/**
 * Text helpers shared by ingestion and recall: token estimation, CJK bigram
 * tokens for the FTS index, and content-block flattening.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/
const PUNCT = /[\s\p{P}\p{S}]+/u

/** Rough token estimate: CJK chars count 1, latin words count 1, other symbols 0.3. */
export function estimateTokens(text) {
  if (!text) return 0
  let n = 0
  for (const ch of text) {
    if (CJK.test(ch)) n += 1
    else if (/[A-Za-z0-9_]/.test(ch)) n += 0.25
  }
  return Math.ceil(n)
}

/** Normalized search tokens: CJK bigrams plus lowercase latin/number words. */
export function searchTokens(text, limit = 240) {
  if (!text) return []
  const out = new Set()
  const normalized = String(text).toLowerCase()
  const runs = normalized.split(PUNCT).filter(Boolean)
  for (const run of runs) {
    if (!run) continue
    if (CJK.test(run)) {
      const chars = [...run].filter((c) => CJK.test(c))
      // Unigrams make single-character synonyms (猫 → 喵) matchable; bigrams
      // keep the precision that pure unigram matching loses.
      for (const ch of chars) out.add(ch)
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
    } else if (/^[a-z0-9_]+$/.test(run) && run.length >= 2) {
      out.add(run)
    }
    if (out.size >= limit) break
  }
  return [...out]
}

/** Build an FTS5 MATCH expression from tokens (OR of quoted phrases). */
export function ftsExpression(tokens) {
  return tokens
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ')
}

/** Flatten message content blocks to plain text. */
export function contentText(content, options = {}) {
  const toolArgLimit = options.toolArgLimit ?? 400
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(`[tool-call ${block.name ?? ''}] ${String(block.arguments ?? '').slice(0, toolArgLimit)}`)
    else if (block.type === 'tool-addition') parts.push(`[tool+ ${block.toolName ?? ''}]`)
    else if (block.type === 'tool-removal') parts.push(`[tool- ${block.toolName ?? ''}]`)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push(`[file ${block.attachment?.name ?? ''}]`)
  }
  return parts.join('\n')
}

/** Extract the conversational text of one session event (shared by ingest and re-read). */
export function eventText(event) {
  const data = event?.data ?? {}
  const full = { toolArgLimit: Number.MAX_SAFE_INTEGER }
  switch (event?.type) {
    case 'user/message':
      return contentText(data.content, full)
    case 'assistant/message':
      return contentText(data.message?.content, full)
    case 'tool/result':
      return contentText(data.message?.content, full)
    case 'tool/call':
      return `[${data.name ?? 'tool'}] ${String(data.arguments ?? '')}`
    case 'compaction/summary':
      return contentText(data.summary, full)
    default:
      return ''
  }
}

/** Relevance ordering helper: newer is better, half-life in days. */
export function recencyWeight(timeMs, now = Date.now(), halfLifeDays = 7) {
  if (!timeMs) return 0
  const ageDays = Math.max(0, (now - timeMs) / 86400000)
  return Math.exp((-ageDays * Math.LN2) / halfLifeDays)
}
