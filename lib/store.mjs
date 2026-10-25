/**
 * SQLite store for the append-only transcript memory.
 *
 * Two rules shape this module:
 *  - `raw_event` is the base layer: INSERT only, never UPDATE/DELETE.
 *  - every derived row (chunk) carries a `[start_seq, end_seq]` pointer back to
 *    `raw_event`, so the whole index can be rebuilt from the raw layer.
 *
 * The database uses `node:sqlite` (synchronous), because `systemPrompt.context`
 * providers must return text synchronously and cannot await.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { contentText, estimateTokens, ftsExpression, recencyWeight, searchTokens } from './text.mjs'

const CHUNKER_VER = 4
const GAP_MARK = '…[truncated — full event in the session log]'

/** Short, human-facing session label used in coordinates (`s=<id>#<seq>`). */
function shortSession(id) {
  return String(id).replace(/^session-/, '').slice(0, 8)
}

/** Workspace identity is the project directory; compare case/separator-insensitively. */
function normalizePath(path) {
  return String(path ?? '')
    .trim()
    .toLowerCase()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_meta (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT,
  workspace    TEXT,
  title        TEXT,
  parent_session TEXT,
  origin       TEXT,
  first_seq    INTEGER,
  last_seq     INTEGER,
  first_time   INTEGER,
  last_time    INTEGER,
  chunk_seq    INTEGER NOT NULL DEFAULT 0,
  gap_from_seq INTEGER,
  gap_to_seq   INTEGER,
  gap_turn     INTEGER,
  gap_seen     INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  synced_at    INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS raw_event (
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  time           INTEGER NOT NULL,
  turn           INTEGER,
  step           INTEGER,
  type           TEXT NOT NULL,
  role           TEXT,
  text           TEXT,
  text_truncated INTEGER NOT NULL DEFAULT 0,
  payload        BLOB,
  payload_ref    TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS raw_time ON raw_event(time);

CREATE TABLE IF NOT EXISTS chunk (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  start_seq   INTEGER NOT NULL,
  end_seq     INTEGER NOT NULL,
  t_start     INTEGER NOT NULL,
  t_end       INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'turn',
  text        TEXT NOT NULL,
  tokens      TEXT NOT NULL DEFAULT '',
  token_est   INTEGER NOT NULL,
  chunker_ver INTEGER NOT NULL,
  archived    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, start_seq, end_seq, chunker_ver)
);
CREATE INDEX IF NOT EXISTS chunk_time ON chunk(t_end);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  tokens, content='chunk', content_rowid='id', tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS digest (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  start_seq  INTEGER NOT NULL,
  end_seq    INTEGER NOT NULL,
  level      TEXT NOT NULL,
  text       TEXT NOT NULL,
  keywords   TEXT,
  importance INTEGER NOT NULL DEFAULT 1,
  generator  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS digest_fts USING fts5(
  text, keywords, content='digest', content_rowid='id'
);

CREATE TABLE IF NOT EXISTS hot (
  id         INTEGER PRIMARY KEY,
  slot       TEXT NOT NULL,
  text       TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  source     TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy (
  id       INTEGER PRIMARY KEY,
  kind     TEXT NOT NULL,
  trigger  TEXT NOT NULL,
  text     TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS synonym (
  group_id INTEGER NOT NULL,
  term     TEXT NOT NULL,
  PRIMARY KEY (group_id, term)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS assembled_log (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn       INTEGER,
  step       INTEGER,
  budget     INTEGER,
  used       INTEGER,
  tiers      TEXT,
  sources    TEXT,
  at         INTEGER NOT NULL
);
`

/** Event types whose text belongs in the searchable chunk layer. */
const CHUNK_TYPES = new Set(['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])
/** Message sources that are plugin/bookkeeping noise, not conversation. */
const NOISE_SOURCES = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'compact-checkpoint',
  'user-approval',
  'goal',
  'schedule',
  'tool-jobs',
  'agent-message',
  'subagent-settled',
  'model-selection',
  'working-directory',
  'ptc-mode',
  'tool-registry',
  'plan-mode',
  'session-reference',
  'user-question-reply',
])

export class MemoryStore {
  constructor(dir, options = {}) {
    this.dir = dir
    this.oversizeBytes = options.oversizeBytes ?? 102400
    this.chunkChars = options.chunkChars ?? 1600
    this.chunkCharsMax = options.chunkCharsMax ?? 3000
    this.dbPath = join(dir, 'raw.db')
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(SCHEMA)
    this.db.exec('PRAGMA user_version = 1')
    // Drop diagnostic keys written by earlier development builds.
    try {
      this.db.exec("DELETE FROM meta WHERE key IN ('workspaceDefaultDir', 'workspaceCount')")
    } catch {
      /* meta table is new */
    }
    this.prepare()
    this.sessionCache = new Map()
    this.workspaceLabels = new Map(Object.entries(options.workspaceLabels ?? {}).map(([path, label]) => [normalizePath(path), String(label)]))
    this.stats = { events: 0, chunks: 0, errors: 0, lastError: null, lastIngestAt: 0 }
    this.needsRechunk = false
    this.migrateChunker()
    this.seedSynonyms()
    this.seedPolicies()
  }

  /** Readable workspace label for a project directory (configured, else basename). */
  labelFor(cwd) {
    const key = normalizePath(cwd)
    if (!key) return '未标记'
    const configured = this.workspaceLabels.get(key)
    if (configured) return configured
    const base = basename(String(cwd)) || '未标记'
    // The default workspace is named after its folder; give it a friendly label.
    return base === 'default-workspace' ? '默认工作区' : base
  }

  /** Replace the configured labels (e.g. the default workspace name is known only to the host). */
  setWorkspaceLabels(labels) {
    this.workspaceLabels = new Map(Object.entries(labels ?? {}).map(([path, label]) => [normalizePath(path), String(label)]))
  }

  /** Session counts per workspace, most active first. */
  workspaceStats() {
    return this.qWorkspaceStats
      .all()
      .map((row) => ({ cwd: row.cwd, label: this.labelFor(row.cwd), sessions: row.n }))
      .sort((a, b) => b.sessions - a.sessions)
  }

  /** Recent digests whose source session belongs to one workspace. */
  recentDigestsForCwd(cwd, limit = 3) {
    const key = normalizePath(cwd)
    if (!key) return []
    return this.qDigestsRecent
      .all(200)
      .filter((row) => normalizePath(this.sessionRow(row.session_id)?.cwd) === key)
      .slice(0, limit)
      .map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }))
  }

  /**
   * First-turn orientation for a session: recent summaries of the same
   * workspace, or a "new workspace" note pointing at the global store.
   */
  bootstrapText(sid, cwd) {
    const label = this.labelFor(cwd)
    const digests = this.recentDigestsForCwd(cwd, 3)
    if (digests.length > 0) {
      const lines = digests.map((digest) => {
        const title = String(digest.text)
          .split('\n')[0]
          .replace(/^【压缩摘要[^】]*】\s*/, '')
          .slice(0, 110)
        const time = new Date(digest.createdAt).toLocaleString('zh-CN', { hour12: false })
        return `- ${time} ${title}`
      })
      return `【近期上下文｜${label}】本工作区最近的记忆摘要（更早的用 mem_search，默认跨工作区）：\n${lines.join('\n')}`
    }
    const others = this.workspaceStats()
      .filter((ws) => normalizePath(ws.cwd) !== normalizePath(cwd) && ws.sessions > 0)
      .slice(0, 5)
      .map((ws) => `${ws.label}(${ws.sessions} 会话)`)
    return `【新工作区】你在 "${cwd}"，这里还没有历史记录。过去的记录在：${others.join('、') || '（暂无）'}。需要旧事直接 mem_search（默认跨工作区）；只想查本区加 scope:"workspace"。`
  }

  /** Chunking rules are derived data: a version bump drops chunks and replays raw_event. */
  migrateChunker() {
    const stored = Number(this.getMeta('chunker') ?? 0)
    if (stored === CHUNKER_VER) return
    this.db.exec('DELETE FROM chunk_fts')
    this.db.exec('DELETE FROM chunk')
    this.db.exec('UPDATE session_meta SET chunk_seq = 0')
    this.setMetaValue('chunker', CHUNKER_VER)
    this.sessionCache.clear()
    this.needsRechunk = true
  }

  prepare() {
    const db = this.db
    this.qSession = db.prepare('SELECT * FROM session_meta WHERE session_id = ?')
    this.insSession = db.prepare(`INSERT OR IGNORE INTO session_meta
      (session_id, cwd, workspace, parent_session, origin, first_seq, last_seq, first_time, last_time, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    this.touchSession = db.prepare(`UPDATE session_meta SET
      last_seq = MAX(COALESCE(last_seq, -1), ?),
      last_time = COALESCE(?, last_time),
      first_seq = MIN(COALESCE(first_seq, ?), ?),
      first_time = MIN(COALESCE(first_time, ?), ?),
      synced_at = ?
      WHERE session_id = ?`)
    this.setTitle = db.prepare('UPDATE session_meta SET title = ? WHERE session_id = ?')
    this.setGap = db.prepare('UPDATE session_meta SET gap_from_seq = ?, gap_to_seq = ?, gap_turn = ?, gap_seen = 0 WHERE session_id = ?')
    this.updGapSeen = db.prepare('UPDATE session_meta SET gap_seen = 1 WHERE session_id = ?')
    this.insRaw = db.prepare(`INSERT OR IGNORE INTO raw_event
      (session_id, seq, time, turn, step, type, role, text, text_truncated, payload, payload_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    this.qRaw = db.prepare('SELECT * FROM raw_event WHERE session_id = ? AND seq = ?')
    this.qRange = db.prepare(`SELECT seq, time, type, role, text FROM raw_event
      WHERE session_id = ? AND seq >= ? AND seq <= ? AND role IS NOT NULL AND text IS NOT NULL
      ORDER BY seq ASC LIMIT 400`)
    this.insDigest = db.prepare(`INSERT INTO digest
      (session_id, start_seq, end_seq, level, text, keywords, importance, generator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    this.insDigestFts = db.prepare('INSERT INTO digest_fts(rowid, text, keywords) VALUES (?, ?, ?)')
    this.qDigest = db.prepare('SELECT * FROM digest WHERE archived = 0 ORDER BY created_at DESC LIMIT ?')
    this.qHot = db.prepare('SELECT * FROM hot ORDER BY ord, id')
    this.delHot = db.prepare('DELETE FROM hot WHERE slot = ?')
    this.insHot = db.prepare('INSERT INTO hot (slot, text, ord, source, updated_at) VALUES (?, ?, ?, ?, ?)')
    this.maxHotOrd = db.prepare('SELECT COALESCE(MAX(ord), 0) AS n FROM hot')
    this.qPending = db.prepare(`SELECT seq, time, turn, step, type, role, text FROM raw_event
      WHERE session_id = ? AND seq > ? AND type IN ('turn/start','turn/end','user/message','assistant/message','tool/call','tool/result')
      ORDER BY seq ASC LIMIT 4000`)
    this.insChunk = db.prepare(`INSERT OR IGNORE INTO chunk
      (session_id, start_seq, end_seq, t_start, t_end, kind, text, tokens, token_est, chunker_ver)
      VALUES (?, ?, ?, ?, ?, 'turn', ?, ?, ?, ?)`)
    this.insChunkFts = db.prepare('INSERT INTO chunk_fts(rowid, tokens) VALUES (?, ?)')
    this.updChunkSeq = db.prepare('UPDATE session_meta SET chunk_seq = ? WHERE session_id = ?')
    this.qSearch = db.prepare(`SELECT c.*, bm25(chunk_fts) AS rank
      FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid
      WHERE chunk_fts MATCH ? AND c.archived = 0
      ORDER BY rank LIMIT ?`)
    this.qLike = db.prepare(`SELECT c.*, 0 AS rank FROM chunk c
      WHERE c.archived = 0 AND c.text LIKE ? ORDER BY c.t_end DESC LIMIT ?`)
    this.qCountRaw = db.prepare('SELECT COUNT(*) AS n FROM raw_event')
    this.qCountChunks = db.prepare('SELECT COUNT(*) AS n FROM chunk WHERE archived = 0')
    this.qCountSessions = db.prepare('SELECT COUNT(*) AS n FROM session_meta')
    this.qCountDigest = db.prepare('SELECT COUNT(*) AS n FROM digest WHERE archived = 0')
    this.qSessions = db.prepare(`SELECT session_id, cwd, title, first_time, last_time, last_seq, gap_from_seq
      FROM session_meta ORDER BY last_time DESC LIMIT ?`)
    this.qMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
    this.setMeta = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    this.qRangeLarge = db.prepare(`SELECT seq, time, type, role, text FROM raw_event
      WHERE session_id = ? AND seq >= ? AND seq <= ? AND role IS NOT NULL AND text IS NOT NULL
      ORDER BY seq ASC LIMIT 5000`)
    this.qDigestByRange = db.prepare(`SELECT id FROM digest
      WHERE session_id = ? AND start_seq = ? AND end_seq = ? AND level = 'summary' AND archived = 0 LIMIT 1`)
    this.insAssembled = db.prepare(`INSERT INTO assembled_log
      (session_id, turn, step, budget, used, tiers, sources, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    this.qRecentRefills = db.prepare(`SELECT * FROM assembled_log
      WHERE tiers LIKE '%gap%' ORDER BY at DESC LIMIT ?`)
    this.qPolicies = db.prepare('SELECT * FROM policy WHERE enabled = 1 ORDER BY priority DESC, id')
    this.insPolicy = db.prepare('INSERT INTO policy (kind, trigger, text, priority, enabled) VALUES (?, ?, ?, ?, 1)')
    this.qWorkspaceStats = db.prepare('SELECT cwd, COUNT(*) AS n FROM session_meta WHERE cwd IS NOT NULL GROUP BY cwd')
    this.qDigestsRecent = db.prepare('SELECT * FROM digest WHERE archived = 0 ORDER BY created_at DESC LIMIT ?')
  }

  /** Re-chunk a session from seq 0 (used after a backfill filled earlier events). */
  resetChunkCursor(sid) {
    this.updChunkSeq.run(0, sid)
    const cached = this.sessionCache.get(sid)
    if (cached) cached.chunk_seq = 0
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  sessionRow(sid) {
    let row = this.sessionCache.get(sid)
    if (row === undefined) {
      row = this.qSession.get(sid) ?? null
      this.sessionCache.set(sid, row)
    }
    return row
  }

  ensureSession(sid, header) {
    let row = this.sessionRow(sid)
    if (row) return row
    const now = Date.now()
    this.insSession.run(
      sid,
      header?.cwd ?? null,
      header?.cwd ?? null,
      header?.parentSession ?? null,
      header?.origin ?? null,
      null,
      -1,
      null,
      null,
      now,
    )
    row = this.qSession.get(sid)
    this.sessionCache.set(sid, row)
    return row
  }

  /** Persist one session event. Idempotent per (session, seq). */
  saveEvent(sid, seq, time, ev, header, options = {}) {
    const row = this.ensureSession(sid, header)
    const last = row?.last_seq ?? -1
    // Live events arrive in order; a backfill may insert events older than the
    // live watermark, so it bypasses this shortcut and relies on INSERT OR IGNORE.
    if (!options.backfill && seq <= last) return false
    const type = ev?.type ?? 'unknown'
    const data = ev?.data ?? {}
    let role = null
    let text = null
    if (type === 'user/message') {
      const kind = data.source?.kind
      if (!NOISE_SOURCES.has(kind) && !String(kind ?? '').startsWith('plugin:')) {
        role = 'user'
        text = contentText(data.content)
      }
    } else if (type === 'assistant/message') {
      role = 'assistant'
      text = contentText(data.message?.content)
    } else if (type === 'tool/result') {
      role = 'tool'
      text = contentText(data.message?.content)
    } else if (type === 'tool/call') {
      role = 'tool'
      text = `[${data.name ?? 'tool'}] ${String(data.arguments ?? '').slice(0, 2000)}`
    } else if (type === 'compaction/summary') {
      role = null
      text = contentText(data.summary)
    }
    if (text !== null && text.length === 0) text = null

    let truncated = 0
    let payload = null
    let payloadRef = null
    let json = null
    try {
      // Assistant stream replay data is redundant with the message text and can
      // be megabytes per turn, so the payload copy drops it.
      const source =
        type === 'assistant/message' && data && typeof data === 'object'
          ? { ...ev, data: { ...data, stream: undefined } }
          : ev
      json = JSON.stringify(source)
    } catch {
      json = null
    }
    if (json !== null) {
      const bytes = Buffer.byteLength(json)
      if (bytes > this.oversizeBytes) {
        if (text) {
          const head = text.length > 4000 ? text.slice(0, 4000) + `\n${GAP_MARK}` : text
          text = head
          truncated = 1
        }
        payloadRef = JSON.stringify({ sessionId: sid, seq, bytes })
      } else {
        try {
          payload = gzipSync(Buffer.from(json))
        } catch {
          payload = null
        }
      }
    }

    try {
      const info = this.insRaw.run(
        sid,
        seq,
        time || Date.now(),
        data.turn ?? null,
        data.step ?? null,
        type,
        role,
        text,
        truncated,
        payload,
        payloadRef,
      )
      this.touchSession.run(seq, time || Date.now(), seq, seq, time || Date.now(), time || Date.now(), Date.now(), sid)
      const cached = this.sessionCache.get(sid) ?? row
      if (cached) {
        cached.last_seq = Math.max(cached.last_seq ?? -1, seq)
        cached.last_time = time || cached.last_time
      }
      if (info.changes > 0) {
        this.stats.events += 1
        this.stats.lastIngestAt = Date.now()
      }
      if (type === 'compaction/summary' && data.shadowedRange?.start !== undefined) {
        this.setGap.run(data.shadowedRange.start, data.shadowedRange.end ?? null, data.turn ?? null, sid)
        const c = this.sessionCache.get(sid)
        if (c) {
          c.gap_from_seq = data.shadowedRange.start
          c.gap_to_seq = data.shadowedRange.end ?? null
          c.gap_seen = 0
        }
      }
      if (type === 'session/title' && typeof data.title === 'string') {
        this.setTitle.run(data.title, sid)
      }
      return true
    } catch (error) {
      this.stats.errors += 1
      this.stats.lastError = String(error?.message ?? error)
      return false
    }
  }

  /** Build searchable chunks from not-yet-chunked raw events. */
  flushChunks(sid) {
    const row = this.sessionRow(sid)
    if (!row) return 0
    const cursor = row.chunk_seq ?? 0
    const rows = this.qPending.all(sid, cursor)
    if (rows.length === 0) return 0

    let produced = 0
    let group = []
    let chars = 0
    let tokens = new Set()
    let groupTurn = null
    let currentTurn = null
    const emit = () => {
      if (group.length === 0) return
      const text = group.map((r) => r.line).join('\n')
      const tokenList = [...tokens].join(' ')
      const info = this.insChunk.run(
        sid,
        group[0].seq,
        group[group.length - 1].seq,
        group[0].time,
        group[group.length - 1].time,
        text,
        tokenList,
        estimateTokens(text),
        CHUNKER_VER,
      )
      if (info.changes > 0) {
        this.insChunkFts.run(Number(info.lastInsertRowid), tokenList)
        produced += 1
      }
      group = []
      chars = 0
      tokens = new Set()
      groupTurn = null
    }

    for (const r of rows) {
      // A turn boundary closes the previous chunk and opens a new one.
      if (r.type === 'turn/start') {
        emit()
        currentTurn = typeof r.turn === 'number' ? r.turn : currentTurn
        continue
      }
      if (r.type === 'turn/end') {
        emit()
        continue
      }
      if (!r.text) continue
      // `turn` is only carried by assistant/tool events; user messages inherit
      // the turn being assembled so one exchange stays in one chunk.
      if (typeof r.turn === 'number') currentTurn = r.turn
      const turn = currentTurn
      let label = ''
      let body = r.text
      if (r.role === 'user') label = '用户: '
      else if (r.role === 'assistant') label = '助手: '
      else if (r.type === 'tool/call') label = '工具调用: '
      else if (r.type === 'tool/result') {
        label = '工具结果: '
        if (body.length > 600) body = body.slice(0, 600) + ' …'
      }
      if (!body) continue
      const line = label + body
      const turnChanged = group.length > 0 && turn !== null && groupTurn !== null && turn !== groupTurn
      if (group.length > 0 && (turnChanged || chars + line.length > this.chunkCharsMax)) emit()
      if (group.length === 0) groupTurn = turn
      group.push({ seq: r.seq, time: r.time, line })
      chars += line.length + 1
      for (const t of searchTokens(body)) tokens.add(t)
      if (chars >= this.chunkChars) emit()
    }
    emit()

    const lastSeq = rows[rows.length - 1].seq
    this.updChunkSeq.run(lastSeq, sid)
    row.chunk_seq = lastSeq
    this.stats.chunks += produced
    return produced
  }

  /** Load the synonym groups once; the table is small and read-only at runtime. */
  loadSynonyms() {
    if (this.synonymMap) return this.synonymMap
    const map = new Map()
    try {
      const rows = this.db.prepare('SELECT group_id, term FROM synonym').all()
      const groups = new Map()
      for (const row of rows) {
        if (!groups.has(row.group_id)) groups.set(row.group_id, [])
        groups.get(row.group_id).push(row.term)
      }
      for (const terms of groups.values()) {
        for (const term of terms) {
          if (!map.has(term)) map.set(term, new Set())
          for (const other of terms) map.get(term).add(other)
        }
      }
    } catch {
      /* synonyms are optional */
    }
    this.synonymMap = map
    return map
  }

  /** Expand query tokens through the synonym table (bigram-level, no vectors). */
  expandTokens(tokens) {
    const map = this.loadSynonyms()
    const out = new Set(tokens)
    for (const token of tokens) {
      const group = map.get(token)
      if (!group) continue
      for (const term of group) out.add(term)
    }
    return [...out]
  }

  /** Add synonym groups; each group is an array of interchangeable terms. */
  addSynonyms(groups) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO synonym (group_id, term) VALUES (?, ?)')
    const maxRow = this.db.prepare('SELECT COALESCE(MAX(group_id), 0) AS n FROM synonym').get()
    let groupId = Number(maxRow.n)
    let added = 0
    for (const group of groups) {
      const terms = [...new Set(group.map((t) => String(t).trim()).filter(Boolean))]
      if (terms.length < 2) continue
      groupId += 1
      for (const term of terms) {
        const info = insert.run(groupId, term)
        if (info.changes > 0) added += 1
      }
    }
    this.synonymMap = null
    return { added, groups: groupId - Number(maxRow.n) }
  }

  /** Seed a small base dictionary the first time the store is used. */
  seedSynonyms() {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM synonym').get().n
    if (count > 0) return 0
    const seed = [
      ['吃', '吃饭', '吃了', '吃掉'],
      ['睡', '睡觉', '睡了', '睡眠'],
      ['猫', '猫咪', '喵', '小猫'],
      ['狗', '狗狗', '汪'],
      ['电脑', '主机', '机器', 'pc'],
      ['手机', '电话', 'mobile'],
      ['游戏', '打游戏', 'steam'],
      ['记忆', '回忆', '记得', '想起'],
      ['插件', 'plugin', '扩展'],
      ['清理', '打扫', '垃圾', '删除'],
      ['启动器', 'launcher'],
      ['女朋友', '女友', '对象'],
      ['昨天', '前一天'],
      ['今天', '当天'],
      ['明天', '第二天'],
      ['工作', '上班', '干活'],
      ['写代码', '编码', '编程'],
      ['报错', '错误', 'error', 'bug'],
      ['配置', '设置', 'config'],
      ['文件', '文档', 'file'],
      ['视频', '片子'],
      ['饭', '吃饭', '餐厅', '店'],
      ['拉面', '牛肉面', '面馆'],
      ['记忆库', '数据库', 'db'],
      ['备份', '导出', 'backup'],
    ]
    this.addSynonyms(seed)
    return seed.length
  }

  /** Current dictionary as groups for display. */
  listSynonyms() {
    const rows = this.db.prepare('SELECT group_id, term FROM synonym ORDER BY group_id, term').all()
    const groups = new Map()
    for (const row of rows) {
      if (!groups.has(row.group_id)) groups.set(row.group_id, [])
      groups.get(row.group_id).push(row.term)
    }
    return [...groups.values()]
  }

  /** FTS recall with recency blending and simple near-duplicate suppression. */
  search(query, options = {}) {
    const limit = Math.max(1, Math.min(50, options.limit ?? 8))
    const now = Date.now()
    const tokens = searchTokens(query)
    const strong = tokens.filter((t) => t.length >= 2)
    // Expand through the dictionary only. Every expansion term (even a single
    // character such as 猫 → 喵) is meaningful, while raw single-character
    // unigrams of a longer query are not.
    const expanded = this.expandTokens(strong.length > 0 ? strong : tokens)
    const matchTerms = expanded
    const expr = ftsExpression(expanded.slice(0, 32))
    let rows = []
    if (expr) {
      try {
        rows = this.qSearch.all(expr, limit * 6)
      } catch {
        rows = []
      }
    }
    if (rows.length === 0 && query.trim()) {
      rows = this.qLike.all(`%${query.trim().slice(0, 40)}%`, limit * 3)
    }
    const minTime = options.days ? now - options.days * 86400000 : 0
    // Default is a global search; isolation is opt-in (`scope: 'workspace'`)
    // or an explicit `workspace` path.
    const scopeCwd = options.workspace
      ? normalizePath(options.workspace)
      : options.scope === 'workspace'
        ? normalizePath(options.cwd)
        : ''
    const scored = []
    for (const r of rows) {
      if (options.session && r.session_id !== options.session) continue
      if (minTime && r.t_end < minTime) continue
      if (scopeCwd) {
        const session = this.sessionRow(r.session_id)
        if (normalizePath(session?.cwd) !== scopeCwd) continue
      }
      // A candidate must contain at least one expanded query term (a dictionary
      // synonym counts) so single-character noise cannot win on BM25 alone.
      if (matchTerms.length > 0 && !matchTerms.some((t) => r.text.includes(t))) continue
      const recency = recencyWeight(r.t_end, now)
      // Conversation lines are worth more than tool plumbing, and a chunk whose
      // user turn actually mentions the query beats one that only matches a tool
      // argument.
      const dialogue = r.text.includes('用户: ') || r.text.includes('助手: ')
      let roleBoost = dialogue ? 1.3 : 0.55
      const userText = r.text
        .split('\n')
        .filter((line) => line.startsWith('用户: '))
        .join(' ')
      if (userText) {
        const userTokens = new Set(searchTokens(userText))
        const matched = tokens.filter((t) => userTokens.has(t)).length
        roleBoost *= 1 + 0.9 * (matched / Math.max(1, tokens.length))
      }
      const score = (-Number(r.rank ?? 0) + recency * 0.8) * roleBoost
      scored.push({ row: r, score })
    }
    scored.sort((a, b) => b.score - a.score)

    const picked = []
    for (const item of scored) {
      const tokenSet = new Set(searchTokens(item.row.text, 80))
      // Suppress near-duplicates: the same edit or the same reply quoted twice.
      const duplicate = picked.some((p) => {
        let shared = 0
        for (const token of tokenSet) if (p.tokenSet.has(token)) shared += 1
        return shared / Math.max(1, Math.min(tokenSet.size, p.tokenSet.size)) > 0.7
      })
      if (duplicate) continue
      picked.push({ ...item, tokenSet })
      if (picked.length >= limit) break
    }

    return picked.map(({ row, score }) => {
      const session = this.sessionRow(row.session_id)
      return {
        ref: `s=${shortSession(row.session_id)}#${row.start_seq}-${row.end_seq}`,
        session: row.session_id,
        workspace: this.labelFor(session?.cwd),
        title: session?.title ?? undefined,
        cwd: session?.cwd ?? undefined,
        time: row.t_end,
        timeText: new Date(row.t_end).toLocaleString('zh-CN', { hour12: false }),
        seq: [row.start_seq, row.end_seq],
        score: Number(score.toFixed(3)),
        text: row.text.length > 900 ? row.text.slice(0, 900) + ' …' : row.text,
      }
    })
  }

  /** Read one raw event (full payload when it was small enough to keep). */
  readEvent(sid, seq) {
    const row = this.qRaw.get(sid, seq)
    if (!row) return null
    let payload = null
    if (row.payload) {
      try {
        payload = JSON.parse(gunzipSync(row.payload).toString('utf8'))
      } catch {
        payload = null
      }
    }
    return {
      ref: `s=${shortSession(row.session_id)}#${row.seq}`,
      session: row.session_id,
      seq: row.seq,
      time: row.time,
      timeText: new Date(row.time).toLocaleString('zh-CN', { hour12: false }),
      type: row.type,
      role: row.role,
      text: row.text,
      truncated: row.text_truncated === 1,
      payloadRef: row.payload_ref ? JSON.parse(row.payload_ref) : undefined,
      payload,
    }
  }

  /** Replay every pending raw event into chunks (activation / chunker bump). */
  drainChunks(sid) {
    let total = 0
    for (let page = 0; page < 400; page++) {
      const row = this.sessionRow(sid)
      if (!row) break
      const pending = this.qPending.all(sid, row.chunk_seq ?? 0)
      if (pending.length === 0) break
      const before = row.chunk_seq
      total += this.flushChunks(sid)
      if (row.chunk_seq === before) break
    }
    return total
  }

  /**
   * Extractive, coordinate-bound summary of a compacted range.
   * Pure local work (no model call), so it can never block or fail compaction.
   */
  summarizeRange(sid, start, end, options = {}) {
    if (start == null || end == null) return null
    const existing = this.qDigestByRange.get(sid, start, end)
    if (existing && !options.force) return { id: existing.id, skipped: true }
    if (existing) this.db.prepare(`UPDATE digest SET archived = 1
      WHERE session_id = ? AND start_seq = ? AND end_seq = ? AND level = 'summary'`).run(sid, start, end)
    const rows = this.qRangeLarge.all(sid, start, end)
    if (rows.length === 0) return null
    // Older rows may still carry reasoning noise from before it was stripped at
    // ingest, so clean at summary time too.
    const clean = (text) =>
      String(text)
        .split('\n')
        .filter((line) => {
          const head = line.trimStart()
          return !head.startsWith('[reasoning]') && !head.startsWith('[tool-call')
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    const users = []
    const assistants = []
    const tools = new Map()
    for (const row of rows) {
      if (row.role === 'user') {
        const text = clean(row.text)
        if (text) users.push(text)
      } else if (row.role === 'assistant') {
        const text = clean(row.text)
        if (text) assistants.push(text)
      } else if (row.role === 'tool') {
        const name = /^\[([^\]]{1,40})\]/.exec(row.text)?.[1] ?? '工具结果'
        tools.set(name, (tools.get(name) ?? 0) + 1)
      }
    }
    const clip = (text, max) => {
      const flat = String(text).replace(/\s+/g, ' ').trim()
      return flat.length > max ? flat.slice(0, max) + '…' : flat
    }
    const toolList = [...tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}×${count}`)
      .join('、')
    // The first user line is often a reaction ("好耶"); the longest one carries
    // the actual request of the range.
    const mainUser = [...users].sort((a, b) => b.length - a.length)[0]
    const lastUser = users.length > 1 ? users[users.length - 1] : undefined
    const lastAssist = [...assistants].reverse().find((text) => text.length >= 20) ?? assistants[assistants.length - 1]
    const lines = [`【压缩摘要｜${this.labelFor(this.sessionRow(sid)?.cwd)}】s=${shortSession(sid)}#${start}-${end}（${rows.length} 条消息）`]
    if (mainUser) lines.push(`诉求：${clip(mainUser, 160)}`)
    if (lastUser && lastUser !== mainUser) lines.push(`后续：${clip(lastUser, 140)}`)
    if (lastAssist) lines.push(`结果：${clip(lastAssist, 180)}`)
    if (toolList) lines.push(`工具：${toolList}`)
    const text = lines.join('\n')
    const keywords = searchTokens(text, 40).filter((token) => token.length >= 2).slice(0, 24)
    const saved = this.note(text, {
      session: sid,
      startSeq: start,
      endSeq: end,
      level: 'summary',
      keywords,
      importance: 2,
      generator: options.generator ?? 'auto-extractive',
    })
    return { ...saved, chars: text.length, messages: rows.length }
  }

  /** Seed the default conditional-safety rules once. */
  seedPolicies() {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM policy').get().n
    if (count > 0) return 0
    const seed = [
      ['privacy', '身份证|密码|银行卡|手机号|住址|护照|验证码|api[_-]?key|secret|token', '涉及凭据/身份信息：只做必要引用，不完整复述、不写日志、不外发。', 50],
      ['link', 'https?://|www\\.|点击链接|打开链接', '外部链接：不自行打开或抓取未验证链接，先说明风险由用户决定。', 40],
      ['danger', '删库|格式化|rm -rf|shutdown|关机', '危险操作：不直接执行，先确认目标与后果，给出可回滚方案。', 35],
      ['readonly', '只读|不要修改|别改|readonly', '只读模式：本轮只读与检查，不改文件、不写数据。', 30],
      ['forward', '转发|转给|分享给|发给别人', '转发：转述/转发前确认范围，不泄露第三方内容。', 20],
      ['leak', '保密|别告诉|秘密|不要外传', '保密：涉及他人隐私或内部信息先脱敏，不主动扩散。', 20],
    ]
    for (const [kind, trigger, text, priority] of seed) this.insPolicy.run(kind, trigger, text, priority)
    return seed.length
  }

  listPolicies() {
    return this.db.prepare('SELECT * FROM policy ORDER BY priority DESC, id').all().map((r) => ({
      id: r.id,
      kind: r.kind,
      trigger: r.trigger,
      text: r.text,
      priority: r.priority,
      enabled: r.enabled === 1,
    }))
  }

  addPolicy(rule) {
    const info = this.insPolicy.run(
      String(rule.kind ?? 'custom'),
      String(rule.trigger ?? ''),
      String(rule.text ?? ''),
      Number(rule.priority ?? 10),
    )
    return { id: Number(info.lastInsertRowid) }
  }

  /** Rules whose trigger matches this user text and were not injected yet. */
  matchPolicies(text, already = new Set()) {
    if (!text) return []
    const out = []
    for (const row of this.qPolicies.all()) {
      if (already.has(row.id)) continue
      let re
      try {
        re = new RegExp(row.trigger, 'i')
      } catch {
        continue
      }
      if (re.test(text)) out.push({ id: row.id, kind: row.kind, text: row.text })
    }
    return out
  }

  /** Record one compaction refill in the observability log (never throws). */
  logRefill(sid, chars, sources) {
    try {
      this.insAssembled.run(sid, null, null, 0, chars, JSON.stringify({ gap: chars }), JSON.stringify(sources ?? []), Date.now())
    } catch {
      /* observability is best-effort */
    }
  }

  recentRefills(limit = 5) {
    return this.qRecentRefills.all(limit).map((row) => ({
      session: row.session_id,
      timeText: new Date(row.at).toLocaleString('zh-CN', { hour12: false }),
      used: row.used,
      tiers: row.tiers,
      sources: row.sources,
    }))
  }

  /** Record a first-turn orientation injection (best effort). */
  logBootstrap(sid, chars) {
    try {
      this.insAssembled.run(sid, null, null, 0, chars, JSON.stringify({ bootstrap: chars }), JSON.stringify([]), Date.now())
    } catch {
      /* observability is best-effort */
    }
  }

  recentBootstraps(limit = 5) {
    return this.db
      .prepare("SELECT * FROM assembled_log WHERE tiers LIKE '%bootstrap%' ORDER BY at DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        session: row.session_id,
        timeText: new Date(row.at).toLocaleString('zh-CN', { hour12: false }),
        used: row.used,
        tiers: row.tiers,
      }))
  }

  /** Verbatim transcript excerpt for a compacted range, as one injectable block. */
  gapText(sid, from, to, maxChars = 4000) {
    const end = to ?? from + 100000
    const rows = this.qRange.all(sid, from, end)
    if (rows.length === 0) return ''
    const parts = []
    let used = 0
    for (const r of rows) {
      const label = r.role === 'user' ? '用户' : r.role === 'assistant' ? '助手' : '工具'
      let body = r.text
      if (body.length > 400) body = body.slice(0, 400) + ' …'
      const line = `[${label} #${r.seq}] ${body}`
      if (used + line.length > maxChars) break
      parts.push(line)
      used += line.length + 1
    }
    if (parts.length === 0) return ''
    return [
      `【记忆补全】以下是这段对话被压缩前的原文（来自只追加原文库，坐标 s=${sid.slice(0, 12)}，直接引用即可）：`,
      ...parts,
    ].join('\n')
  }

  markGapSeen(sid) {
    this.updGapSeen.run(sid)
    const cached = this.sessionCache.get(sid)
    if (cached) cached.gap_seen = 1
  }

  /** Manual note (a fact/summary the model decided to persist), optionally tied to a file range. */
  note(text, options = {}) {
    const keywords = options.keywords ?? searchTokens(text, 24)
    const info = this.insDigest.run(
      options.session ?? '',
      options.startSeq ?? 0,
      options.endSeq ?? 0,
      options.level ?? 'fact',
      text,
      JSON.stringify(keywords),
      options.importance ?? 1,
      options.generator ?? 'manual',
      Date.now(),
    )
    const id = Number(info.lastInsertRowid)
    this.insDigestFts.run(id, text, keywords.join(' '))
    return { id, level: options.level ?? 'fact', keywords }
  }

  /** Hot memory rendered for the system prompt (stable text, cached by the host). */
  hotSectionText() {
    const rows = this.qHot.all()
    if (rows.length === 0) return ''
    return rows.map((r) => r.text).join('\n')
  }

  listHot() {
    return this.qHot.all().map((r) => ({ id: r.id, slot: r.slot, text: r.text, ord: r.ord, source: r.source }))
  }

  setHot(slot, text, options = {}) {
    const ord = Number(this.maxHotOrd.get().n) + 1
    if (!options.append) this.delHot.run(slot)
    const info = this.insHot.run(slot, text, ord, options.source ?? 'manual', Date.now())
    return { id: Number(info.lastInsertRowid), slot, ord }
  }

  listDigests(limit = 20) {
    return this.qDigest.all(limit).map((r) => ({
      id: r.id,
      level: r.level,
      text: r.text,
      session: r.session_id || undefined,
      seq: typeof r.start_seq === 'number' && typeof r.end_seq === 'number' ? [r.start_seq, r.end_seq] : undefined,
      importance: r.importance,
      generator: r.generator,
      createdAt: r.created_at,
    }))
  }

  /**
   * One-click backup. Builds in a staging directory, validates the snapshot by
   * reopening it, records its size and sha256, then renames into place so a
   * crash never leaves a half-written backup at the published path.
   */
  exportBackup(targetDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const finalDir = targetDir || join(this.dir, 'backup', stamp)
    if (existsSync(finalDir)) throw new Error(`backup target already exists: ${finalDir}`)
    const tmpDir = `${finalDir}.tmp`
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    const tmpDb = join(tmpDir, 'raw.db')
    try {
      this.db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`)

      // Reopen the snapshot and derive counts from it, not from the live DB.
      const snapshot = new DatabaseSync(tmpDb, { readOnly: true })
      let counts
      try {
        counts = {
          sessions: snapshot.prepare('SELECT COUNT(*) AS n FROM session_meta').get().n,
          events: snapshot.prepare('SELECT COUNT(*) AS n FROM raw_event').get().n,
          chunks: snapshot.prepare('SELECT COUNT(*) AS n FROM chunk WHERE archived = 0').get().n,
          digests: snapshot.prepare('SELECT COUNT(*) AS n FROM digest WHERE archived = 0').get().n,
        }
        const integrity = snapshot.prepare('PRAGMA integrity_check').get()
        if (Object.values(integrity)[0] !== 'ok') throw new Error(`snapshot integrity check failed: ${JSON.stringify(integrity)}`)
      } finally {
        snapshot.close()
      }

      const bytes = statSync(tmpDb).size
      const sha256 = createHash('sha256').update(readFileSync(tmpDb)).digest('hex')
      const manifest = {
        format: 'dsh-memraw-backup',
        schema: 1,
        chunker: CHUNKER_VER,
        exportedAt: new Date().toISOString(),
        db: 'raw.db',
        dbBytes: bytes,
        dbSha256: sha256,
        counts,
        hot: this.db.prepare('SELECT * FROM hot ORDER BY ord').all(),
        policy: this.db.prepare('SELECT * FROM policy ORDER BY priority').all(),
        synonym: this.db.prepare('SELECT * FROM synonym').all(),
      }
      writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
      renameSync(tmpDir, finalDir)
      return {
        dir: finalDir,
        db: join(finalDir, 'raw.db'),
        bytes,
        sha256,
        files: ['raw.db', 'manifest.json'],
        counts,
      }
    } catch (error) {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* staging cleanup is best-effort */
      }
      throw error
    }
  }

  /** Merge a backup directory into this store. Never deletes local data. */
  importBackup(sourceDir) {
    const srcPath = join(sourceDir, 'raw.db')
    if (!existsSync(srcPath)) throw new Error(`no raw.db in ${sourceDir}`)
    const manifestPath = join(sourceDir, 'manifest.json')
    let manifest = null
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch (error) {
        throw new Error(`manifest.json is not valid JSON: ${error?.message ?? error}`)
      }
      if (manifest?.format !== undefined && manifest.format !== 'dsh-memraw-backup') {
        throw new Error(`unexpected backup format: ${manifest.format}`)
      }
      if (typeof manifest?.dbSha256 === 'string') {
        const actual = createHash('sha256').update(readFileSync(srcPath)).digest('hex')
        if (actual !== manifest.dbSha256) throw new Error('backup checksum mismatch: raw.db differs from its manifest')
      }
    }
    const src = new DatabaseSync(srcPath, { readOnly: true })
    const touched = []
    let events = 0
    let sessions = 0
    let digests = 0
    let hot = 0
    try {
      const tables = new Set(
        src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      )
      for (const table of ['raw_event', 'session_meta', 'hot', 'digest']) {
        if (!tables.has(table)) throw new Error(`backup missing table: ${table}`)
      }
      const readMeta = src.prepare('SELECT * FROM session_meta')
      const readRaw = src.prepare(`SELECT seq, time, turn, step, type, role, text, text_truncated, payload, payload_ref
        FROM raw_event WHERE session_id = ? ORDER BY seq ASC`)
      const readHot = src.prepare('SELECT slot, text, ord, source FROM hot ORDER BY ord')
      const readDigest = src.prepare('SELECT session_id, start_seq, end_seq, level, text, keywords, importance, generator, created_at FROM digest')
      const hasDigest = this.db.prepare('SELECT 1 AS hit FROM digest WHERE text = ? LIMIT 1')

      for (const meta of readMeta.all()) {
        const sid = meta.session_id
        const local = this.sessionRow(sid)
        const rows = readRaw.all(sid)
        let maxSeq = local?.last_seq ?? -1
        let maxTime = local?.last_time ?? 0
        for (const r of rows) {
          if (local && r.seq <= (local.last_seq ?? -1)) continue
          const info = this.insRaw.run(
            sid,
            r.seq,
            r.time,
            r.turn,
            r.step,
            r.type,
            r.role,
            r.text,
            r.text_truncated ?? 0,
            r.payload,
            r.payload_ref,
          )
          if (info.changes > 0) events += 1
          maxSeq = Math.max(maxSeq, r.seq)
          maxTime = Math.max(maxTime, r.time)
        }
        if (maxSeq >= 0) {
          this.touchSession.run(maxSeq, maxTime, meta.first_seq ?? maxSeq, maxSeq, meta.first_time ?? maxTime, maxTime, Date.now(), sid)
        }
        if (!local) {
          this.insSession.run(
            sid,
            meta.cwd ?? null,
            meta.workspace ?? null,
            meta.parent_session ?? null,
            meta.origin ?? null,
            meta.first_seq ?? null,
            meta.last_seq ?? null,
            meta.first_time ?? null,
            meta.last_time ?? null,
            Date.now(),
          )
        }
        this.updChunkSeq.run(0, sid)
        this.sessionCache.delete(sid)
        sessions += 1
        touched.push(sid)
      }

      for (const entry of readHot.all()) {
        if (this.qHot.all().some((r) => r.slot === entry.slot && r.text === entry.text)) continue
        this.insHot.run(entry.slot, entry.text, Number(this.maxHotOrd.get().n) + 1, entry.source ?? 'import', Date.now())
        hot += 1
      }

      const insertDigest = this.insDigest
      for (const row of readDigest.all()) {
        if (hasDigest.get(row.text)) continue
        const info = insertDigest.run(
          row.session_id,
          row.start_seq,
          row.end_seq,
          row.level,
          row.text,
          row.keywords,
          row.importance,
          row.generator,
          row.created_at,
        )
        const id = Number(info.lastInsertRowid)
        this.insDigestFts.run(id, row.text, row.keywords ?? '')
        digests += 1
      }
    } finally {
      src.close()
    }
    return { dir: sourceDir, sessions, events, digests, hot, touched, verified: typeof manifest?.dbSha256 === 'string' }
  }

  status() {
    return {
      db: this.dbPath,
      dir: this.dir,
      sessions: this.qCountSessions.get().n,
      events: this.qCountRaw.get().n,
      chunks: this.qCountChunks.get().n,
      digests: this.qCountDigest.get().n,
      ingestedThisRun: this.stats.events,
      lastIngestAt: this.stats.lastIngestAt || undefined,
      errors: this.stats.errors,
      lastError: this.stats.lastError ?? undefined,
      schema: 1,
      chunker: CHUNKER_VER,
    }
  }

  listSessions(limit = 20) {
    return this.qSessions.all(limit).map((r) => ({
      session: r.session_id,
      workspace: this.labelFor(r.cwd),
      cwd: r.cwd ?? undefined,
      title: r.title ?? undefined,
      firstTime: r.first_time ?? undefined,
      lastTime: r.last_time ?? undefined,
      lastSeq: r.last_seq ?? undefined,
      gapFrom: r.gap_from_seq ?? undefined,
    }))
  }

  getMeta(key) {
    return this.qMeta.get(key)?.value
  }

  setMetaValue(key, value) {
    this.setMeta.run(key, String(value))
  }
}
