/**
 * dsh-memraw — append-only transcript memory for DSH.
 *
 * Raw layer:   every session event is copied into `raw_event` (INSERT only).
 * Index layer: conversation turns are chunked into `chunk` + FTS5 with CJK
 *              bigram tokens, each chunk pointing back at [start_seq, end_seq].
 * Recall:      `mem_search` / `mem_read` tools; the system prompt carries a
 *              stable guide so recall costs no per-turn context growth.
 *
 * Injection policy (P0): only the stable guide is injected (`section`). The
 * host's `systemPrompt.context` appends a new snapshot whenever its text
 * changes and never removes old ones, so per-turn recall blocks are left to
 * the tools until a replacement-safe mechanism is verified.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { MemoryStore } from './lib/store.mjs'
import { eventText } from './lib/text.mjs'

export const name = 'memraw'
export const inject = ['sessionPersistence', 'tools', 'systemPrompt', 'timer']

const DEFAULTS = {
  /** Data directory; default is $DSH_HOME/memraw. */
  dir: '',
  /** Events whose JSON payload exceeds this stay as text + pointer. */
  oversizeBytes: 102400,
  /** Target size of one chunk, in characters. */
  chunkChars: 1600,
  /** Hard cap for one chunk. */
  chunkCharsMax: 3000,
  /** Ingest existing sessions on activation. */
  backfill: true,
  /** Register the stable memory guide into the system prompt. */
  guide: true,
  /** Character budget for one compacted-range refill. */
  gapChars: 4000,
  /** Inject the compacted range back into the next step after compaction. */
  gapRefill: true,
  /** Summarize every compacted range into a coordinate-bound digest (local, async). */
  autoDigest: true,
  /** First-turn orientation: recent summaries here, or a "new workspace" note. */
  bootstrap: true,
  /**
   * Project directory → readable workspace label, used in search results and
   * digest headers. Empty by default: the host's workspace titles (and the
   * folder name) are used; add entries here to override.
   */
  workspaceLabels: {},
}

const GUIDE = `【原文记忆】你有一个跨会话、只追加的会话原文库（存原文，不是摘要），用工具按需检索：
- mem_search(query, limit?, days?, session?, scope?, workspace?)：CJK 二元词 + 关键词匹配，返回带「s=<会话短id>#<seq>」与时间的原文片段；**默认跨工作区全局检索**，只想查本区传 scope:"workspace"，查指定工作区传 workspace:"<路径>"。
- mem_read(session, seq)：按坐标回读那一条原始事件（含完整 text；超大事件只留头尾+指针）。
- mem_note(text, session?, startSeq?, endSeq?)：把值得长期留着的一条事实/结论落盘（带原文指针）。
- mem_digest(session?, startSeq?, endSeq?)：为一段原文生成带坐标摘要（标题带工作区标签）；不带参数则列出已有摘要。
- mem_hot(slot, text)：写/改常驻热记忆（soul=我是谁 / user=用户是谁 / rules=工作准则 / criteria=必须判据），会常驻系统提示词。
- mem_export()：一键备份整个原文库。
- mem_status() / mem_list_sessions()：看库里有什么、覆盖到哪。
规则：遇到「上次 / 之前 / 那天 / 那个」这类指代，或用户问起旧事、旧决定、旧偏好时，先用 mem_search 查，再回答；查不到就直说没找到，不要凭印象编。引用历史时带上来源会话与时间。
工作区规则：默认是**跨工作区全局检索**（换工作区也能找回旧事）；只想查当前区加 scope:"workspace"，查某个指定区加 workspace:"<路径>"。每个会话第一轮会收到一条「近期上下文」（本工作区最近的摘要）或「新工作区」（这里还没有历史，过去的记录在哪些工作区）提示——看到「新工作区」就主动 mem_search 找旧事，别当自己是个刚失忆的陌生人。

去重规则：如果你在 meow-memory 自动召回的上下文里已经看到了相关信息，不要重复调用 mem_search；如果调用了 mem_search 且发现内容与它重复，自行忽略重复部分即可。mem_search 的结果来源标记为 [Source: memraw]，不要与 meow-memory 的召回混为一谈。`

function resolveDir(config) {
  if (config.dir) return config.dir
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memraw')
}

function jsonSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function textRender(_args, value) {
  let body
  try {
    body = JSON.stringify(value, null, 2)
  } catch {
    body = String(value)
  }
  if (body.length > 60000) body = body.slice(0, 60000) + '\n…[truncated]'
  return [{ type: 'text', text: body }]
}

/** Tool results must be lossless JSON: drop `undefined` members and BigInts. */
function clean(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? Number(item) : item)),
  )
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const dir = resolveDir(config)
  const store = new MemoryStore(dir, config)

  const warn = (message) => {    try {
      ctx.logger?.warn?.(`memraw: ${message}`)
    } catch {
      /* logger is optional */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`memraw: ${message}`)
    } catch {
      /* logger is optional */
    }
  }

  ctx.effect(() => () => store.close())

  let refreshLabels = () => 0

  // Workspace labels: config overrides, then the host's workspace titles
  // (whatever the user named each workspace in the sidebar). Re-resolved on
  // each search so a rename applies without a restart.
  {
    const normalize = (path) => String(path ?? '').trim().toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')
    const refresh = () => {
      const labels = { ...(config.workspaceLabels ?? {}) }
      let workspaces = []
      try {
        workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
      } catch {
        workspaces = []
      }
      for (const ws of workspaces) {
        if (!ws?.path || !ws?.title) continue
        // A title equal to the folder name adds no information; the label
        // fallback gives the friendly name instead.
        if (ws.title === basename(ws.path)) continue
        if (Object.keys(labels).some((path) => normalize(path) === normalize(ws.path))) continue
        labels[ws.path] = ws.title
      }
      store.setWorkspaceLabels(labels)
      return workspaces.length
    }
    refreshLabels = refresh
    if (refresh() === 0) {
      let attempt = 0
      const retry = () => {
        if (refresh() > 0 || ++attempt > 10) return
        ctx.timer.timeout(retry, 1000)
      }
      ctx.timer.timeout(retry, 1000)
    }
  }

  // Policy ids already injected per session (cleared when compaction rewrites history).
  const injectedPolicies = new Map()
  const bootstrapped = new Set()
  const textOfMessage = (message) =>
    Array.isArray(message?.content)
      ? message.content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('\n')
      : ''

  // ---- live ingestion -----------------------------------------------------
  const summarizeLater = (sid, start, end) => {
    // Compaction must never wait for us: schedule onto the next tick and swallow
    // every failure so a bad digest cannot affect the host's /compact.
    setTimeout(() => {
      try {
        const result = store.summarizeRange(sid, start, end)
        if (result && !result.skipped) info(`digest #${result.id} for ${sid.slice(0, 12)}#${start}-${end}: ${result.chars} chars`)
      } catch (error) {
        warn(`digest failed for ${sid.slice(0, 12)}#${start}-${end}: ${error?.message ?? error}`)
      }
    }, 0)
  }

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (!session?.id || !event?.type) return
      try {
        const sid = String(session.id)
        store.saveEvent(sid, event.seq, event.time, event, session.header)
        if (event.type === 'turn/end') store.flushChunks(sid)
        if (config.autoDigest !== false && event.type === 'compaction/summary') {
          // History is rewritten: safety rules may need to be injected again.
          injectedPolicies.delete(sid)
          const range = event.data?.shadowedRange
          if (range && range.start != null && range.end != null) summarizeLater(sid, range.start, range.end)
        }
      } catch (error) {
        warn(`ingest failed for ${session.id}: ${error?.message ?? error}`)
      }
    }),
  )

  // ---- backfill existing sessions -----------------------------------------
  if (config.backfill) {
    const backfill = async () => {
      let snapshots = []
      try {
        snapshots = await ctx.sessionPersistence.list()
      } catch (error) {
        warn(`session list failed: ${error?.message ?? error}`)
        return
      }
      let done = 0
      const migrated = store.needsRechunk === true
      store.needsRechunk = false
      for (const snap of snapshots) {
        const sid = String(snap?.header?.id ?? '')
        if (!sid) continue
        let inserted = 0
        try {
          const handle = await ctx.sessionPersistence.open(sid, 'read')
          try {
            let offset = 0
            for (let page = 0; page < 400; page++) {
              const result = await handle.read(offset, 256)
              const events = result?.events ?? []
              if (events.length === 0) break
              for (const event of events) {
                // Out-of-order rows are legal here: a live session may have
                // started ingesting mid-log, so early events are backfilled later.
                if (store.saveEvent(sid, event.seq, event.time, event, snap.header, { backfill: true })) {
                  inserted += 1
                }
              }
              offset += events.length
              if (events.length < 256) break
              await new Promise((resolve) => setTimeout(resolve, 0))
            }
          } finally {
            await handle.close?.()
          }
          if (inserted > 0 || migrated) {
            store.resetChunkCursor(sid)
            store.drainChunks(sid)
            done += 1
          }
        } catch (error) {
          warn(`backfill ${sid} failed: ${error?.message ?? error}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      store.setMetaValue('lastBackfillAt', Date.now())
      info(`backfill done, sessions filled: ${done}, events: ${store.status().events}`)
    }
    ctx.effect(() => ctx.timer.timeout(() => void backfill(), 2000))
  }

  // ---- per-turn conditional context: orientation + safety rules + refill --
  ctx.effect(() =>
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind !== 'enter' || !decision.messages?.length) return decision
        if (signal?.aborted) return decision
        if (agent?.session?.header?.origin === 'subagent') return decision
        const sid = String(agent.id)
        const additions = []

        // ⓪ First turn of a session: orientation. A new workspace gets a
        //    "here is where the past lives" note; an old one gets its recent
        //    summaries so a fresh session is not a stranger.
        if (config.bootstrap !== false && !bootstrapped.has(sid)) {
          bootstrapped.add(sid)
          const text = store.bootstrapText(sid, agent?.session?.header?.cwd)
          if (text) {
            store.logBootstrap(sid, text.length)
            additions.push({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'plugin:dsh-memraw' },
            })
          }
        }

        // ① Conditional safety rules: match this turn's user text and inject each
        //    rule at most once per session (they stay in history once injected).
        const userText = decision.messages
          .filter((message) => message?.source?.kind === 'user')
          .map(textOfMessage)
          .filter(Boolean)
          .join('\n')
        let seen = injectedPolicies.get(sid)
        if (!seen) {
          seen = new Set()
          injectedPolicies.set(sid, seen)
        }
        const matched = store.matchPolicies(userText, seen)
        if (matched.length > 0) {
          for (const rule of matched) seen.add(rule.id)
          additions.push({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: `【本轮约束】${matched.map((rule) => rule.text).join(' ')}` }],
            source: { kind: 'plugin:dsh-memraw' },
          })
          info(`policy ${matched.map((rule) => rule.kind).join(',')} for ${sid.slice(0, 12)}`)
        }

        // ② Compaction refill: once per compacted range.
        if (config.gapRefill !== false) {
          const row = store.sessionRow(sid)
          // 0 is a valid boundary (the shadowed range may start at seq 0).
          if (row?.gap_from_seq != null && !row.gap_seen) {
            const text = store.gapText(sid, row.gap_from_seq, row.gap_to_seq, config.gapChars)
            store.markGapSeen(sid)
            if (text) {
              additions.push({
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'plugin:dsh-memraw' },
              })
              info(`gap refill for ${sid.slice(0, 12)}: ${text.length} chars`)
              store.logRefill(sid, text.length, [{ session: sid, start: row.gap_from_seq, end: row.gap_to_seq }])
            }
          }
        }

        if (additions.length === 0) return decision
        return { ...decision, messages: [...additions, ...decision.messages] }
      } catch (error) {
        warn(`conditional context failed: ${error?.message ?? error}`)
        return decision
      }
    }),
  )

  // ---- stable system prompt guide ----------------------------------------
  if (config.guide) {
    let registered = false
    let timer = 0
    const register = (attempt) => {
      if (registered) return
      const systemPrompt = ctx.get('systemPrompt')
      if (!systemPrompt?.section) {
        if (attempt < 20) timer = setTimeout(() => register(attempt + 1), 1000)
        return
      }
      try {
        ctx.effect(() =>
          systemPrompt.section({
            name: 'memraw:guide',
            order: 89990,
            text: () => {
              const hot = store.hotSectionText()
              return hot ? `${hot}\n\n${GUIDE}` : GUIDE
            },
          }),
        )
        registered = true
        info('guide section registered')
      } catch (error) {
        warn(`guide registration failed: ${error?.message ?? error}`)
        registered = true
      }
    }
    register(0)
    ctx.effect(() => () => clearTimeout(timer))
  }

  // ---- tools --------------------------------------------------------------
  const statusTool = {
    name: 'mem_status',
    description: 'Show the raw-memory store status: database path, coverage, counts, ingest errors.',
    parameters: jsonSchema({}),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute() {
      return clean({
        ...store.status(),
        workspaceLabels: Object.fromEntries(store.workspaceLabels),
        policies: store.listPolicies().length,
        sessionsRecent: store.listSessions(5),
        recentRefills: store.recentRefills(5),
        recentBootstraps: store.recentBootstraps(5),
        recentDigests: store.listDigests(5),
      })
    },
  }

  const policyTool = {
    name: 'mem_policy',
    description:
      'List or extend the conditional safety rules. A rule is injected as one short constraint line only on a turn whose user text matches its trigger regex, at most once per session.',
    parameters: jsonSchema({
      list: { type: 'boolean', description: 'Return the current rules.' },
      add: {
        type: 'array',
        description: 'Rules to add.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'privacy | link | danger | readonly | forward | leak | custom' },
            trigger: { type: 'string', description: 'Regular expression (case-insensitive) matched against the user text.' },
            text: { type: 'string', description: 'One-line constraint injected when matched.' },
            priority: { type: 'integer', description: 'Higher runs first (default 10).' },
          },
          required: ['trigger', 'text'],
          additionalProperties: false,
        },
      },
    }),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      if (Array.isArray(args?.add) && args.add.length > 0) {
        const added = args.add.map((rule) => store.addPolicy(rule))
        return clean({ added, total: store.listPolicies().length })
      }
      return clean({ rules: store.listPolicies() })
    },
  }

  const digestTool = {
    name: 'mem_digest',
    description:
      'Summarize one transcript range into a coordinate-bound digest (or list existing digests). Local extraction, no model call; safe to run any time.',
    parameters: jsonSchema({
      session: { type: 'string', description: 'Session id of the range to summarize.' },
      startSeq: { type: 'integer', description: 'First seq of the range.' },
      endSeq: { type: 'integer', description: 'Last seq of the range.' },
      list: { type: 'boolean', description: 'List existing digests instead of creating one.' },
      force: { type: 'boolean', description: 'Regenerate even when a digest for this range exists.' },
      limit: { type: 'integer', description: 'List size (default 10).' },
    }),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      if (args?.list === true) return clean({ digests: store.listDigests(args?.limit ?? 10) })
      const session = String(args?.session ?? '')
      const start = Number(args?.startSeq)
      const end = Number(args?.endSeq)
      if (!session || !Number.isFinite(start) || !Number.isFinite(end)) {
        return { error: 'session, startSeq and endSeq are required (or pass list:true)' }
      }
      const result = store.summarizeRange(session, start, end, { force: args?.force === true })
      if (!result) return { error: 'no events in that range', session, start, end }
      const digest = store.listDigests(50).find((entry) => entry.id === result.id) ?? null
      return clean({ ...result, session, start, end, digest })
    },
  }

  const searchTool = {
    name: 'mem_search',
    description:
      'Search the append-only transcript store. Global across workspaces by default; pass scope:"workspace" to stay in the current project, or workspace:"<path>" for one specific workspace. Returns verbatim snippets with source workspace, session, time and [startSeq, endSeq] coordinates.',
    parameters: jsonSchema({
      query: { type: 'string', description: 'Keywords or a natural-language question; CJK bigrams and latin words are matched.' },
      limit: { type: 'integer', description: 'Max hits (1-50, default 8).' },
      days: { type: 'integer', description: 'Only consider chunks newer than N days.' },
      session: { type: 'string', description: 'Restrict to one session id.' },
      scope: { type: 'string', enum: ['all', 'workspace'], description: 'all (default) = global; workspace = current project only.' },
      workspace: { type: 'string', description: 'Restrict to one workspace path.' },
    }, ['query']),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (!query) return { query: '', hits: [], note: 'empty query' }
      const cwd = exec?.agent?.session?.header?.cwd
      const scope = args?.scope === 'workspace' ? 'workspace' : 'all'
      refreshLabels()
      const hits = store.search(query, {
        limit: args?.limit,
        days: args?.days,
        session: args?.session,
        cwd,
        scope,
        workspace: args?.workspace,
      })
      return clean({
        source: 'memraw',
        scope,
        workspace: store.labelFor(cwd),
        query,
        hits,
        note: hits.length === 0 ? 'no match; say so instead of guessing' : undefined,
      })
    },
  }

  const readTool = {
    name: 'mem_read',
    description:
      'Read one exact original event by its coordinate (the seq from mem_search). Paged with offset/length. When the stored text was truncated (event >100KB), the full original is re-read from the session log on demand, so the whole text can be pieced back together.',
    parameters: jsonSchema({
      session: { type: 'string', description: 'Session id (the value after s= in mem_search output).' },
      seq: { type: 'integer', description: 'Event seq (the value after #).' },
      offset: { type: 'integer', description: 'Character offset into the original text (default 0).' },
      length: { type: 'integer', description: 'Characters to return (200-200000, default 4000).' },
    }, ['session', 'seq']),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      const session = String(args?.session ?? '')
      const seq = Number(args?.seq)
      if (!session || !Number.isFinite(seq)) return { error: 'session and seq are required' }
      const row = store.readEvent(session, seq)
      if (!row) return { error: 'not found', session, seq }
      const offset = Math.max(0, Number(args?.offset ?? 0) || 0)
      const length = Math.min(200000, Math.max(200, Number(args?.length ?? 4000) || 4000))
      let full = row.text ?? ''
      let source = 'store'
      // Oversize events keep only a head; the session log is the authoritative copy.
      if (row.truncated || (row.payloadRef && !row.payload)) {
        try {
          const handle = await ctx.sessionPersistence.open(session, 'read')
          try {
            const page = await handle.read(seq, 1)
            const event = page?.events?.[0]
            const expanded = event ? eventText(event) : ''
            if (expanded) {
              full = expanded
              source = 'session-log'
            }
          } finally {
            await handle.close?.()
          }
        } catch (error) {
          warn(`expand ${session}@${seq} failed: ${error?.message ?? error}`)
        }
      }
      const slice = full.slice(offset, offset + length)
      return clean({
        ref: row.ref,
        session,
        seq,
        timeText: row.timeText,
        type: row.type,
        role: row.role,
        source,
        offset,
        length,
        totalChars: full.length,
        returnedChars: slice.length,
        nextOffset: offset + slice.length < full.length ? offset + slice.length : undefined,
        text: slice,
        payload: offset === 0 && !row.truncated ? row.payload : undefined,
        payloadRef: row.payloadRef,
      })
    },
  }

  const sessionsTool = {
    name: 'mem_list_sessions',
    description: 'List the most recent sessions covered by the raw-memory store, with time range and ingest watermark.',
    parameters: jsonSchema({ limit: { type: 'integer', description: 'Max rows (default 20).' } }),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      return clean({ sessions: store.listSessions(args?.limit ?? 20) })
    },
  }

  const noteTool = {
    name: 'mem_note',
    description:
      'Persist one durable fact or conclusion into the memory database, optionally pointed at the transcript range it came from. Use it for decisions, preferences and facts worth recalling later.',
    parameters: jsonSchema({
      text: { type: 'string', description: 'The note itself, one self-contained sentence or short paragraph.' },
      session: { type: 'string', description: 'Source session id, when the note derives from a transcript range.' },
      startSeq: { type: 'integer', description: 'First source event seq.' },
      endSeq: { type: 'integer', description: 'Last source event seq.' },
      level: { type: 'string', enum: ['fact', 'summary', 'topic'], description: 'Note kind (default fact).' },
      importance: { type: 'integer', description: '1-4 relevance weight.' },
    }, ['text']),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      const text = String(args?.text ?? '').trim()
      if (!text) return { error: 'text is required' }
      const result = store.note(text, {
        session: args?.session,
        startSeq: args?.startSeq,
        endSeq: args?.endSeq,
        level: args?.level,
        importance: args?.importance,
      })
      return clean(result)
    },
  }

  const hotTool = {
    name: 'mem_hot',
    description:
      'Write or replace one hot-memory entry (stable text kept in the system prompt): soul = who you are, user = who the user is, rules = working rules, criteria = must-have judgements. Pass append:true to add another line instead of replacing the slot.',
    parameters: jsonSchema({
      slot: { type: 'string', enum: ['soul', 'user', 'rules', 'criteria'] },
      text: { type: 'string', description: 'Self-contained line(s) for that slot.' },
      append: { type: 'boolean', description: 'Append instead of replacing the slot.' },
    }, ['slot', 'text']),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      const slot = String(args?.slot ?? '')
      const text = String(args?.text ?? '').trim()
      if (!['soul', 'user', 'rules', 'criteria'].includes(slot)) return { error: 'slot must be soul|user|rules|criteria' }
      if (!text) return { error: 'text is required' }
      const saved = store.setHot(slot, text, { append: args?.append === true })
      return clean({ ...saved, hot: store.listHot() })
    },
  }

  const exportTool = {
    name: 'mem_export',
    description:
      'One-click backup of the entire raw-memory database: a consistent SQLite snapshot plus hot memory, policies, synonyms and a manifest. Safe to run at any time.',
    parameters: jsonSchema({
      dir: { type: 'string', description: 'Target directory; defaults to $DSH_HOME/memraw/backup/<timestamp>.' },
    }),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      const result = store.exportBackup(args?.dir)
      return clean(result)
    },
  }

  const importTool = {
    name: 'mem_import',
    description:
      'Merge a mem_export backup directory into this store: raw events past the local watermark, missing hot-memory entries and notes. Never deletes local data; chunks are rebuilt from the imported raw events.',
    parameters: jsonSchema({ dir: { type: 'string', description: 'Backup directory containing raw.db (from mem_export).' } }, ['dir']),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      const dir = String(args?.dir ?? '')
      if (!dir) return { error: 'dir is required' }
      const result = store.importBackup(dir)
      let rebuilt = 0
      for (const sid of result.touched) rebuilt += store.drainChunks(sid)
      return clean({ ...result, touched: result.touched.length, chunksBuilt: rebuilt })
    },
  }

  const synonymTool = {
    name: 'mem_synonym',
    description:
      'Read or extend the recall synonym dictionary. Each added group is a list of interchangeable terms (2+), used to expand a query before full-text recall.',
    parameters: jsonSchema({
      add: {
        type: 'array',
        description: 'Groups to add, each an array of interchangeable terms.',
        items: { type: 'array', items: { type: 'string' } },
      },
      list: { type: 'boolean', description: 'Return the current dictionary.' },
    }),
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args) {
      if (Array.isArray(args?.add) && args.add.length > 0) {
        const result = store.addSynonyms(args.add)
        return clean({ ...result, total: store.listSynonyms().length })
      }
      return clean({ groups: store.listSynonyms() })
    },
  }

  for (const definition of [statusTool, searchTool, readTool, sessionsTool, noteTool, hotTool, exportTool, importTool, synonymTool, digestTool, policyTool]) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  info(`opened ${store.dbPath}`)
  return store
}
