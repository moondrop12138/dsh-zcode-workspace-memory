// Adapted from ZCode zcode-cli/packages/core/src/memory/{retrieval-branch,recall-types,recall-manifest,recall-selector,recall-content,recall-index}.ts (Apache-2.0).
// Changes: ported TypeScript to zero-dependency ESM, dropped the FileSystemPort/model/contracts
// plumbing (callers pass plain records and content strings), reused the local
// parseFactFrontmatter/MEMORY_TYPES/INDEX_FILE instead of the YAML parser plus a private
// frontmatter reader, added the filename tie-break to manifest sorting, take the fact filename
// from basename (the memory directory is flat), dedupe repeated filenames in selection
// filtering, and apply the 1-day / 48-hour age rules directly to the rendered header.

/**
 * Semantic-recall branch of workspace memory.
 *
 * The default-index branch (`MEMORY.md` pointer injection) stays the live path;
 * this module freezes the semantic-recall primitives so the branch can be
 * switched on later without moving behavior. Everything here is pure: no I/O,
 * no model calls, no Cordis context — callers hand in records, content and a
 * clock, and `node --test` covers the rest. Behavior is aligned in
 * `docs/alignment/w2-recall.md`.
 */

import { basename } from 'node:path'

import { INDEX_FILE, MEMORY_TYPES, parseFactFrontmatter } from './memory-core.js'

/**
 * Whether the semantic-recall branch is active. Mirrors ZCode
 * `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED`; flipping this one value is the
 * whole switch.
 */
export const SEMANTIC_RECALL_ENABLED = false

/** Retrieval branch names (ZCode `ProjectMemoryRetrievalBranch`). */
export const RETRIEVAL_BRANCHES = Object.freeze(['default-index', 'semantic-recall'])

/** Upper bound of memories one selector round may recall (ZCode `slice(0, 5)`). */
export const RECALL_MAX_ITEMS = 5

/** Per-session character budget for recalled memory content (ZCode `61_440`). */
export const RECALL_BUDGET_CHARS = 61440

/** Line cap for one recalled fact file (ZCode `MEMORY_CONTENT_LINE_LIMIT`). */
export const RECALL_FACT_MAX_LINES = 200

/** Byte cap for one recalled fact file (ZCode `MEMORY_CONTENT_BYTE_LIMIT`). */
export const RECALL_FACT_MAX_BYTES = 4096

/** Age past which a recalled memory is flagged as stale (48 hours). */
export const RECALL_STALE_AFTER_MS = 48 * 60 * 60 * 1000

/** Lines of a fact file kept as its manifest preview (ZCode `MANIFEST_PREVIEW_LINE_LIMIT`). */
export const RECALL_PREVIEW_LINES = 30

/** Manifest entries kept after sorting (ZCode `MANIFEST_FILE_LIMIT`). */
export const RECALL_MANIFEST_LIMIT = 200

/** One day in milliseconds (ZCode `STALE_DAY_MS`). */
const DAY_MS = 86_400_000

/** Leading line of every recall block (ZCode `formatRelevantMemoryAttachment`). */
const RECALL_PREAMBLE =
  'Retrieved for possible relevance — use only if it actually applies to what the user asked.'

/** Stale-memory notice, emitted once the fact is older than {@link RECALL_STALE_AFTER_MS}. */
const STALE_NOTICE =
  'This memory has not been updated in over 48 hours; re-verify it before relying on it.'

/** Day-age notice; only the `days` count varies. */
const DAY_AGE_NOTICE =
  'days old. Memories are point-in-time observations, not live state — claims about code ' +
  'behavior or file:line citations may be outdated. Verify against current code before ' +
  'asserting as fact.'

/**
 * ZCode `MEMORY_SELECTOR_SYSTEM_PROMPT`, verbatim. The last two bullets are the
 * conservative rules for `[user]` and `[project]` memories.
 */
const SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to the coding agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to the coding agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
`

/** Keys the selector response may contain (ZCode `MEMORY_SELECTOR_RESPONSE_SCHEMA`). */
const SELECTOR_KEYS = Object.freeze(['selected_memories', 'selected_knowledge_ids'])

/**
 * Which retrieval branch is active. Mirrors ZCode
 * `resolveProjectMemoryRetrievalBranch`.
 * @param {boolean} [semanticRecallEnabled] defaults to {@link SEMANTIC_RECALL_ENABLED}
 * @returns {'default-index' | 'semantic-recall'}
 */
export function retrievalBranch(semanticRecallEnabled = SEMANTIC_RECALL_ENABLED) {
  return semanticRecallEnabled === true ? 'semantic-recall' : 'default-index'
}

/** Branch resolved from {@link SEMANTIC_RECALL_ENABLED} at module load. */
export const ACTIVE_RETRIEVAL_BRANCH = retrievalBranch()

/**
 * Build the recall manifest from in-memory file records.
 *
 * Only `.md` files are candidates and the `MEMORY.md` index is excluded — it is
 * already injected by the default-index branch. Frontmatter comes from
 * {@link parseFactFrontmatter} (no YAML dependency); entries are sorted by
 * mtime descending, filename ascending, then capped at
 * {@link RECALL_MANIFEST_LIMIT}.
 * @param {Array<{ filePath: string, content?: string, mtimeMs?: number }>} records
 * @returns {Array<{
 *   filePath: string, filename: string, description: string,
 *   type: string | undefined, mtimeMs: number, preview: string
 * }>}
 */
export function buildRecallManifest(records) {
  const list = Array.isArray(records) ? records : []
  const entries = []

  for (const record of list) {
    if (record === null || typeof record !== 'object') continue
    const filePath = typeof record.filePath === 'string' ? record.filePath : ''
    if (filePath.length === 0) continue
    // Upstream filters on the file path and the basename of the index file.
    if (!filePath.endsWith('.md')) continue
    const filename = basename(filePath)
    if (filename === INDEX_FILE) continue

    const content = normalizeContent(record.content)
    const frontmatter = parseFactFrontmatter(content)
    entries.push({
      filePath,
      filename,
      description:
        typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : '',
      type: MEMORY_TYPES.includes(frontmatter?.type) ? frontmatter.type : undefined,
      mtimeMs: Number.isFinite(record.mtimeMs) ? record.mtimeMs : 0,
      preview: firstLines(content, RECALL_PREVIEW_LINES),
    })
  }

  entries.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || compareStrings(left.filename, right.filename),
  )
  return entries.slice(0, RECALL_MANIFEST_LIMIT)
}

/**
 * Render the manifest the selector sees: one line per memory,
 * `- [type] filename (ISO timestamp): description` (ZCode
 * `formatMemoryManifest`). Missing type or description drops that part only.
 * @param {ReadonlyArray<{
 *   filename?: string, type?: string, mtimeMs?: number, description?: string
 * }>} manifest
 * @returns {string}
 */
export function formatRecallManifest(manifest) {
  const list = Array.isArray(manifest) ? manifest : []
  const lines = []

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.filename !== 'string' || entry.filename.length === 0) continue
    const type = MEMORY_TYPES.includes(entry.type) ? `[${entry.type}] ` : ''
    // Upstream calls toISOString() unguarded; a non-finite mtime would throw on
    // an otherwise usable manifest entry, so it degrades to the epoch instead.
    const timestamp = new Date(Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0).toISOString()
    const base = `- ${type}${entry.filename} (${timestamp})`
    const description = typeof entry.description === 'string' ? entry.description : ''
    lines.push(description.length > 0 ? `${base}: ${description}` : base)
  }

  return lines.join('\n')
}

/**
 * Build the data-only selector prompt. ZCode sends the manifest and the query
 * as two separate user messages; this flattens them into one string so the
 * prompt is pure data and a single request.
 * @param {{ query?: string, manifest?: ReadonlyArray<object> }} [input]
 * @returns {{
 *   system: string,
 *   user: string,
 *   schema: {
 *     type: 'object',
 *     properties: { selected_memories: object, selected_knowledge_ids: object },
 *     required: string[],
 *     additionalProperties: false
 *   }
 * }}
 */
export function buildSelectorPrompt(input = {}) {
  const query = typeof input?.query === 'string' ? input.query : ''
  const manifest = Array.isArray(input?.manifest) ? input.manifest : []
  const user = `Available memories:\n${formatRecallManifest(
    manifest,
  )}\n\nSelect memories relevant to:\n${query}`
  return { system: SELECTOR_SYSTEM_PROMPT, user, schema: selectorResponseSchema() }
}

/**
 * Parse the selector model's JSON reply. Only `selected_memories` and
 * `selected_knowledge_ids` are allowed; an unknown key or a non-string-array
 * value rejects the whole response (ZCode `parseSelectorResponse`).
 * `selected_memories` is required by the schema; a missing
 * `selected_knowledge_ids` defaults to `[]`.
 * @param {unknown} text raw model output
 * @returns {{ selectedMemories: string[], selectedKnowledgeIds: string[] } | undefined}
 */
export function parseSelectorResponse(text) {
  if (typeof text !== 'string') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (_ignored) {
    return undefined
  }
  if (!isPlainRecord(parsed)) return undefined
  if (Object.keys(parsed).some((key) => !SELECTOR_KEYS.includes(key))) return undefined
  if (!isStringArray(parsed.selected_memories)) return undefined
  if (parsed.selected_knowledge_ids !== undefined && !isStringArray(parsed.selected_knowledge_ids)) {
    return undefined
  }
  return {
    selectedMemories: [...parsed.selected_memories],
    selectedKnowledgeIds: Array.isArray(parsed.selected_knowledge_ids)
      ? [...parsed.selected_knowledge_ids]
      : [],
  }
}

/**
 * Map selector filenames back to manifest entries, dropping anything already
 * recalled this session, keeping the model's order, and capping at
 * {@link RECALL_MAX_ITEMS}. Repeated filenames collapse to one entry (upstream
 * relies on the model not repeating itself).
 * @param {{
 *   manifest?: ReadonlyArray<{ filename?: string, filePath?: string }>,
 *   selectedFilenames?: ReadonlyArray<string>,
 *   recalledPaths?: Iterable<string> | ReadonlySet<string>
 * }} [input]
 * @returns {Array<{ filePath: string, filename: string, [key: string]: unknown }>}
 */
export function filterRecallSelections(input = {}) {
  const manifest = Array.isArray(input?.manifest) ? input.manifest : []
  const selectedFilenames = Array.isArray(input?.selectedFilenames) ? input.selectedFilenames : []
  const recalledPaths = toPathSet(input?.recalledPaths)

  const byFilename = new Map()
  for (const entry of manifest) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.filename !== 'string' || typeof entry.filePath !== 'string') continue
    if (!byFilename.has(entry.filename)) byFilename.set(entry.filename, entry)
  }

  const picked = []
  const seenPaths = new Set()
  for (const filename of selectedFilenames) {
    if (typeof filename !== 'string') continue
    const entry = byFilename.get(filename)
    if (entry === undefined) continue
    if (recalledPaths.has(entry.filePath)) continue
    if (seenPaths.has(entry.filePath)) continue
    seenPaths.add(entry.filePath)
    picked.push(entry)
    if (picked.length >= RECALL_MAX_ITEMS) break
  }
  return picked
}

/**
 * Render the recall block appended to the user's query. Each memory is
 * `header\n\ncontent`; content is clipped to {@link RECALL_FACT_MAX_LINES}
 * lines and {@link RECALL_FACT_MAX_BYTES} bytes on complete-line boundaries so
 * multi-byte characters never split. Entries are added until the accumulated
 * characters reach `budgetChars`, then a `(+N more memories not shown)` tail
 * records the remainder. An empty input renders as `''`.
 * @param {ReadonlyArray<{
 *   filePath?: string, filename?: string, content?: string, mtimeMs?: number
 * }>} memories
 * @param {{ nowMs?: number, budgetChars?: number }} [options]
 * @returns {string}
 */
export function renderRecallBlock(memories, options = {}) {
  const list = (Array.isArray(memories) ? memories : []).filter(
    (memory) => memory !== null && typeof memory === 'object',
  )
  if (list.length === 0) return ''

  const nowMs = Number.isFinite(options?.nowMs) ? options.nowMs : Date.now()
  const budgetChars = Number.isFinite(options?.budgetChars)
    ? Math.max(0, options.budgetChars)
    : RECALL_BUDGET_CHARS
  const blocks = list.map((memory) => renderMemoryEntry(memory, nowMs))

  const parts = [RECALL_PREAMBLE]
  let used = 0
  let rendered = 0
  for (const block of blocks) {
    // Join with '\n\n', so every block after the first costs its separator too.
    const cost = block.length + (rendered === 0 ? 0 : 2)
    if (used + cost > budgetChars) break
    parts.push(block)
    used += cost
    rendered += 1
  }

  const omitted = blocks.length - rendered
  if (omitted > 0) parts.push(`(+${omitted} more memories not shown)`)
  return parts.join('\n\n')
}

/* --------------------------------------------------------------- internals */

/**
 * Render one memory: optional age/staleness notes, the path header, then the
 * clipped file body.
 * @param {{ filePath?: string, content?: string, mtimeMs?: number }} memory
 * @param {number} nowMs
 * @returns {string}
 */
function renderMemoryEntry(memory, nowMs) {
  const filePath = typeof memory.filePath === 'string' ? memory.filePath : ''
  const mtimeMs = Number.isFinite(memory.mtimeMs) ? memory.mtimeMs : 0
  const content = truncateFactContent(normalizeContent(memory.content), filePath)
  return `${memoryHeader(filePath, mtimeMs, nowMs)}\n\n${content}`
}

/**
 * Clip a fact body to the line and byte caps, appending the truncation notice
 * (ZCode `readRecalledMemory`). The byte cap wins as the reported reason when
 * both apply, matching upstream.
 * @param {string} content already normalized content
 * @param {string} filePath path echoed in the truncation notice
 * @returns {string}
 */
function truncateFactContent(content, filePath) {
  const lines = content === '' ? [''] : content.split('\n')
  // A trailing newline terminates the last line; it is not a content line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const lineTruncated = lines.length > RECALL_FACT_MAX_LINES
  const kept = lineTruncated ? lines.slice(0, RECALL_FACT_MAX_LINES) : lines
  const byteLimited = limitCompleteLinesByBytes(kept.join('\n'))
  if (!byteLimited.truncated && !lineTruncated) return byteLimited.content

  const reason = byteLimited.truncated
    ? `${RECALL_FACT_MAX_BYTES} byte limit`
    : `first ${RECALL_FACT_MAX_LINES} lines`
  return (
    `${byteLimited.content}\n\n> This memory file was truncated (${reason}). ` +
    `Use the Read tool to view the complete file at: ${filePath}`
  )
}

/**
 * Keep whole lines while their UTF-8 bytes stay within
 * {@link RECALL_FACT_MAX_BYTES} (ZCode `limitCompleteLinesByBytes`). Counting
 * `Buffer.byteLength` per line means a multi-byte character is never cut in
 * half.
 * @param {string} content
 * @returns {{ content: string, lineCount: number, truncated: boolean }}
 */
function limitCompleteLinesByBytes(content) {
  const lines = content === '' ? [''] : content.split('\n')
  const selected = []
  let selectedBytes = 0

  for (const line of lines) {
    const separatorBytes = selected.length > 0 ? 1 : 0
    const nextBytes = selectedBytes + separatorBytes + Buffer.byteLength(line, 'utf8')
    if (nextBytes > RECALL_FACT_MAX_BYTES) {
      return { content: selected.join('\n'), lineCount: selected.length, truncated: true }
    }
    selected.push(line)
    selectedBytes = nextBytes
  }

  return { content: selected.join('\n'), lineCount: selected.length, truncated: false }
}

/**
 * Header for one memory: age notice when it is at least a day old, the 48-hour
 * stale notice, then the path line (ZCode `memoryHeader`).
 *
 * Boundary note: upstream suppresses the age notice for `daysOld <= 1` (so a
 * 24–47h-old fact reads as plain); the W2 contract states "age >= 1 day", so
 * this port emits the notice from `daysOld >= 1` and a 1-day-old fact reads
 * "This memory is 1 days old." Flip the comparison to `> 1` to restore
 * upstream's wording exactly.
 * @param {string} filePath
 * @param {number} mtimeMs
 * @param {number} nowMs
 * @returns {string}
 */
function memoryHeader(filePath, mtimeMs, nowMs) {
  const age = Math.max(0, nowMs - mtimeMs)
  const lines = []
  const daysOld = Math.floor(age / DAY_MS)
  if (daysOld >= 1) lines.push(`This memory is ${daysOld} ${DAY_AGE_NOTICE}`)
  if (age >= RECALL_STALE_AFTER_MS) lines.push(STALE_NOTICE)
  lines.push(`Memory: ${filePath}:`)
  return lines.join('\n\n')
}

/**
 * Strip a BOM and CRLF line endings (ZCode normalizes the same two things
 * before measuring bytes).
 * @param {unknown} content
 * @returns {string}
 */
function normalizeContent(content) {
  if (typeof content !== 'string') return ''
  return content.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
}

/**
 * First `lineLimit` lines of `text`, newline-terminated exactly as in the
 * source.
 * @param {string} text normalized content
 * @param {number} lineLimit
 * @returns {string}
 */
function firstLines(text, lineLimit) {
  if (text.length === 0) return ''
  return text.split('\n').slice(0, lineLimit).join('\n')
}

/**
 * Fresh copy of the selector response schema, so a caller mutating the returned
 * schema cannot poison later prompts.
 * @returns {object}
 */
function selectorResponseSchema() {
  return {
    type: 'object',
    properties: {
      selected_memories: { type: 'array', items: { type: 'string' } },
      selected_knowledge_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['selected_memories'],
    additionalProperties: false,
  }
}

/**
 * Normalize `recalledPaths` to a Set: callers may pass the session Set or a
 * plain array.
 * @param {unknown} value
 * @returns {Set<string>}
 */
function toPathSet(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === 'string'))
  return new Set()
}

/**
 * Locale-independent string comparison for deterministic sorting.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
