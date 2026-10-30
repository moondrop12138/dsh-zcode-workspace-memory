/**
 * Pure core of `dsh-workspace-memory`.
 *
 * No Cordis context, no service calls, no I/O: every function here is
 * deterministic and covered by `node --test` (`test/*.test.mjs`). The Host half
 * (`lib/host.js`) owns wiring, the Client half (`lib/client.js`) owns rendering.
 *
 * Porting source: ZCode `apps/zcode-cli/packages/core/src/memory/*` and
 * `src/context/sections/memory.ts`; behavior is frozen in `INTERFACES.md`.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Directory segments appended to a workspace root. */
export const MEMORY_DIR_SEGMENTS = Object.freeze(['.dsh', 'memory'])

/** Index file name inside the memory directory. */
export const INDEX_FILE = 'MEMORY.md'

/** Subdirectory that receives forgotten fact files instead of deleting them. */
export const TRASH_DIR = 'trash'

/** How many forgotten files the trash keeps before evicting the oldest ones. */
export const TRASH_KEEP = 50

/** Accepted `metadata.type` values (ZCode file protocol). */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/**
 * Memory scope. Memory is per-workspace and independent: a session only ever
 * reads and writes `<workspaceRoot>/.dsh/memory/`. The former global layer was
 * withdrawn at the user's request, so no code path touches the user's home.
 */

/** Injection bounds for the index block (ZCode `index-content.ts`). */
export const MAX_INDEX_LINES = 200
export const DEFAULT_MAX_INDEX_CHARS = 25000

/** Extraction bounds (ZCode: 5-turn memory agent budget → 5 facts here). */
export const MAX_FACTS_PER_RUN = 5
export const MAX_TRANSCRIPT_CHARS = 24000
/** Roadmap D6: one oversized turn is extracted in at most this many segments. */
export const MAX_TRANSCRIPT_SEGMENTS = 3
export const MIN_USER_WORDS = 3
export const EXTRACTION_MAX_OUTPUT_TOKENS = 1200

/** Section placement: after the deployment persona (0), before plan policy (500). */
export const MEMORY_SECTION_ORDER = 450

/** Frozen truncation notice appended when the index exceeds the injection bounds. */
export const INDEX_TRUNCATION_WARNING =
  '> WARNING: MEMORY.md is too large. Only part of it was loaded. ' +
  'Keep index entries to one line; move detail into fact files.'

/** Upper bound for one fact file name (without `.md`). */
const MAX_NAME_LENGTH = 48

/** File-name shape accepted for fact files and for `name:` slugs. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** CJK ranges counted as half a word each by {@link countWords}. */
const CJK_SOURCE = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af]'
const CJK_CHARACTER = new RegExp(CJK_SOURCE, 'gu')
const CJK_CHARACTER_SPLIT = new RegExp(CJK_SOURCE, 'gu')

/** Pointer line: `- [Title](fact-name.md) — hook`. */
const POINTER_PATTERN = /^\s*-\s*\[([^\]]*)\]\(([^()\s]+)\)\s*(?:—|–|-)?\s*(.*)$/

/* ------------------------------------------------------------------ paths */

/**
 * The memory root of one workspace.
 * @param {string} workspaceRoot absolute workspace root (session header cwd)
 * @returns {string} `<workspaceRoot>/.dsh/memory`
 */
export function memoryRoot(workspaceRoot) {
  return join(workspaceRoot, MEMORY_DIR_SEGMENTS[0], MEMORY_DIR_SEGMENTS[1])
}

/**
 * Absolute index path inside one memory root.
 * @param {string} root memory root
 * @returns {string} `<root>/MEMORY.md`
 */
export function indexPath(root) {
  return join(root, INDEX_FILE)
}

/**
 * Absolute trash path inside one memory root.
 * @param {string} root memory root
 * @returns {string} `<root>/trash`
 */
export function trashDirPath(root) {
  return join(root, TRASH_DIR)
}

/**
 * Whether one file name is the index file.
 * @param {unknown} fileName
 * @returns {boolean}
 */
export function isIndexFile(fileName) {
  return fileName === INDEX_FILE
}

/**
 * Whether one slug is an acceptable fact name.
 *
 * `memory` is rejected because `memory.md` collides with `MEMORY.md` on
 * case-insensitive filesystems (Windows).
 * @param {unknown} name
 * @returns {boolean} true for a lowercase kebab slug of 1..48 chars
 */
export function isValidMemoryName(name) {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false
  if (!NAME_PATTERN.test(name)) return false
  if (name.endsWith('-')) return false
  return name.toLowerCase() !== 'memory'
}

/**
 * File name of one fact.
 * @param {string} name valid fact name
 * @returns {string} `<name>.md`
 */
export function factFileName(name) {
  return `${name}.md`
}

/**
 * Extract the fact name from a `.md` file name.
 * @param {unknown} fileName
 * @returns {string | undefined} the name when it is a valid fact file
 */
export function parseFactFileName(fileName) {
  if (typeof fileName !== 'string') return undefined
  if (!fileName.endsWith('.md')) return undefined
  const name = fileName.slice(0, -3)
  return isValidMemoryName(name) ? name : undefined
}

/**
 * Resolve one file name inside a memory root, rejecting anything that is not the
 * index or a valid fact file. This is the only path constructor the Host may use
 * for memory files: names never contain separators, so containment is lexical.
 * @param {string} root memory root
 * @param {unknown} fileName `MEMORY.md` or `<fact>.md`
 * @returns {string | undefined} absolute path, or undefined when rejected
 */
export function safeMemoryPath(root, fileName) {
  if (typeof root !== 'string' || root.length === 0) return undefined
  if (isIndexFile(fileName)) return indexPath(root)
  const name = parseFactFileName(fileName)
  return name === undefined ? undefined : join(root, factFileName(name))
}

/**
 * Derive a valid fact name from a human title.
 * @param {unknown} title
 * @param {number} [maxLength]
 * @returns {string | undefined} slug, or undefined when nothing usable remains
 */
export function slugifyTitle(title, maxLength = MAX_NAME_LENGTH) {
  if (typeof title !== 'string') return undefined
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  if (slug.length === 0) return undefined
  if (!NAME_PATTERN.test(slug)) return undefined
  return slug.toLowerCase() === 'memory' ? undefined : slug
}

/**
 * Human title derived from a fact name.
 * @param {string} name valid fact name
 * @returns {string}
 */
export function deriveTitle(name) {
  return String(name)
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/* ------------------------------------------------------------ index content */

/**
 * Remove a leading YAML frontmatter block.
 * @param {string} text normalized text (BOM stripped, LF endings)
 * @returns {string}
 */
function stripLeadingFrontmatter(text) {
  if (!text.startsWith('---\n')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const after = text.indexOf('\n', end + 1)
  return after < 0 ? '' : text.slice(after + 1)
}

/**
 * Remove top-level HTML comment lines (ZCode strips comment tokens; we keep the
 * simple whole-line form so code fences and inline comments are untouched).
 * @param {string} text
 * @returns {string}
 */
function stripTopLevelHtmlComments(text) {
  const lines = text.split('\n')
  const kept = []
  let inComment = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false
      continue
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Format raw `MEMORY.md` for injection: strip frontmatter and top-level HTML
 * comments, trim, then bound by line count and character count (character bound
 * wins when both trigger) with the frozen warning appended when truncated.
 * When `options.query` carries a non-empty query, pointer lines are reordered
 * by relevance to it (roadmap D3) BEFORE either truncation applies, so old but
 * relevant preferences survive a tight cap; the ordering never reaches disk.
 * @param {unknown} raw raw file content
 * @param {{ maxLines?: number, maxChars?: number, query?: unknown }} [options]
 * @returns {{ text: string, truncated: boolean, lineCount: number }}
 */
export function formatIndexContent(raw, options = {}) {
  if (typeof raw !== 'string') return { text: '', truncated: false, lineCount: 0 }
  const maxLines = Number.isSafeInteger(options.maxLines) && options.maxLines > 0
    ? options.maxLines
    : MAX_INDEX_LINES
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_INDEX_CHARS

  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  text = stripLeadingFrontmatter(text)
  text = stripTopLevelHtmlComments(text)
  text = text.trim()
  if (text.length === 0) return { text: '', truncated: false, lineCount: 0 }
  if (typeof options.query === 'string' && options.query.length > 0) {
    text = reorderIndexForQuery(text, options.query)
  }

  let truncated = false
  const lines = text.split('\n')
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n')
    truncated = true
  }
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars)
    text = cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars)
    truncated = true
  }
  text = text.replace(/\s+$/u, '')
  if (truncated) text = `${text}\n\n${INDEX_TRUNCATION_WARNING}`
  return { text, truncated, lineCount: text.split('\n').length }
}

/* ---------------------------------------------------------- injected prompt */

/**
 * The frozen `# Memory` rules text (ZCode `buildMemoryContent`, adapted for DSH:
 * `write`/`edit` tools, read-before-write, AGENTS.md). Workspace-only: every
 * fact lives in this workspace's own memory directory.
 * @param {string} root absolute workspace memory root
 * @returns {string}
 */
export function memoryRulesText(root) {
  return [
    '# Memory',
    '',
    `You have a persistent file-based workspace memory at \`${root}/\`. This directory already exists — write to it directly with the \`write\` and \`edit\` tools (do not create the directory or check for its existence). Each memory is one file holding one fact, with frontmatter:`,
    '',
    '```markdown',
    '---',
    'name: <short-kebab-case-slug>',
    'description: <one-line summary>',
    'metadata:',
    '  type: user | feedback | project | reference',
    '---',
    '',
    '<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>',
    '```',
    '',
    "In the body, link related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.",
    '',
    '`user` — who the user is (role, expertise, preferences). `feedback` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. `project` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. `reference` — pointers to external resources (URLs, dashboards, tickets).',
    '',
    'Memory is per-workspace: everything you save here belongs to this workspace only and is never shared with another one.',
    '',
    'After writing the file, add a one-line pointer in `MEMORY.md` (`- [Title](file.md) — hook`). `MEMORY.md` is the index loaded into every session\'s context — one line per memory, no frontmatter, never put memory content there.',
    '',
    "Before saving, check for an existing file that already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, AGENTS.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Existing files must be read before you overwrite them, and `glob`/`grep` can search this directory.",
  ].join('\n')
}

/**
 * Render the complete injected section: rules, plus the formatted index when the
 * workspace already has one.
 * @param {{ root: string, rawIndex?: unknown, maxChars?: number, query?: unknown }} input
 * @returns {{ text: string, indexTruncated: boolean, indexLineCount: number }}
 */
export function renderMemorySection(input) {
  const root = typeof input.root === 'string' ? input.root : ''
  const formatted = formatIndexContent(input.rawIndex, { maxChars: input.maxChars, query: input.query })
  const rules = memoryRulesText(root)
  if (formatted.text.length === 0) {
    return { text: rules, indexTruncated: false, indexLineCount: 0 }
  }
  const block = [
    `Contents of \`${root}/${INDEX_FILE}\` (workspace memory, persists across sessions):`,
    '',
    formatted.text,
  ].join('\n')
  return {
    text: `${rules}\n\n${block}`,
    indexTruncated: formatted.truncated,
    indexLineCount: formatted.lineCount,
  }
}

/* ----------------------------------------------------------------- pointers */

/**
 * Parse the pointer lines of an index.
 * @param {unknown} indexText
 * @returns {Array<{ title: string, file: string, hook: string, lineIndex: number }>}
 */
export function parseIndexPointers(indexText) {
  if (typeof indexText !== 'string' || indexText.length === 0) return []
  const pointers = []
  const lines = indexText.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = POINTER_PATTERN.exec(lines[i])
    if (match === null) continue
    const file = match[2]
    if (!file.endsWith('.md')) continue
    pointers.push({
      title: match[1].trim(),
      file,
      hook: match[3].trim(),
      lineIndex: i,
    })
  }
  return pointers
}

/**
 * One-line title safe for a pointer.
 * @param {unknown} title
 * @returns {string}
 */
function pointerTitle(title, file) {
  const single = typeof title === 'string' ? title.replace(/[\r\n]+/g, ' ').trim() : ''
  const fallback = parseFactFileName(file)
  const text = single.length > 0 ? single : (fallback === undefined ? '' : deriveTitle(fallback))
  return text.replace(/]/g, '\\]')
}

/**
 * Render one pointer line.
 * @param {{ title?: string, file: string, hook?: string }} pointer
 * @returns {string}
 */
export function renderPointer(pointer) {
  const title = pointerTitle(pointer.title, pointer.file)
  const hook = typeof pointer.hook === 'string' ? pointer.hook.replace(/[\r\n]+/g, ' ').trim() : ''
  const head = `- [${title}](${pointer.file})`
  return hook.length === 0 ? head : `${head} — ${hook}`
}

/* ------------------------------------------------- pointer relevance ranking */

/**
 * Words too generic to rank a pointer against: function words that appear in
 * almost every sentence, in English and the common Chinese function
 * characters. Kept frozen so a ranking stays reproducible across versions.
 */
const RANKING_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'if', 'in', 'is', 'it',
  'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'please',
  'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'vs',
  '我', '你', '他', '她', '的', '了', '吗', '呢', '吧', '啊', '是', '在', '和',
  '跟', '就', '都', '也', '不', '没', '有', '这', '那', '什么', '怎么', '为什么',
  '请', '帮', '记得', '还是', '一直', '再', '又', '很', '挺',
])

/**
 * Split a query into lowercase ranking terms (zero dependencies, no
 * embeddings): ASCII words of two or more characters minus the stop words,
 * lightly stemmed by dropping a trailing `s` (substring matching makes the
 * stem match the plural forms on the pointer side), plus every CJK character
 * and adjacent CJK bigram so a short Chinese query still carries signal.
 * @param {unknown} query
 * @returns {string[]}
 */
export function queryTermsForRanking(query) {
  if (typeof query !== 'string' || query.length === 0) return []
  const lower = query.toLowerCase()
  const terms = new Set()
  for (const word of lower.match(/[a-z0-9][a-z0-9]*/g) ?? []) {
    if (word.length < 2 || RANKING_STOP_WORDS.has(word)) continue
    terms.add(word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
  }
  const cjkChars = []
  for (const match of lower.matchAll(CJK_CHARACTER)) {
    const char = match[0]
    if (RANKING_STOP_WORDS.has(char)) continue
    cjkChars.push(char)
    terms.add(char)
  }
  let previous = ''
  for (const char of cjkChars) {
    if (previous !== '') terms.add(previous + char)
    previous = char
  }
  return [...terms]
}

/**
 * Score one parsed pointer against the query terms: a title hit counts ×2
 * (it is the entry's own label), a hook or file-name hit ×1. A pointer the
 * query says nothing about scores 0.
 * @param {{ title?: string, file?: string, hook?: string } | undefined} pointer
 * @param {string[]} terms
 * @returns {number}
 */
export function scoreIndexPointer(pointer, terms) {
  if (!pointer || !Array.isArray(terms) || terms.length === 0) return 0
  const title = typeof pointer.title === 'string' ? pointer.title.toLowerCase() : ''
  const hook = typeof pointer.hook === 'string' ? pointer.hook.toLowerCase() : ''
  const file = typeof pointer.file === 'string' ? pointer.file.toLowerCase() : ''
  let score = 0
  for (const term of terms) {
    if (title.length > 0 && title.includes(term)) score += 2
    if (hook.length > 0 && hook.includes(term)) score += 1
    if (file.length > 0 && file.includes(term)) score += 1
  }
  return score
}

/**
 * Reorder the pointer lines of an index by their relevance to `query` — the
 * D3 ranking. Most relevant first; ties and zero scores keep the original
 * order (stable), so a query with no signal degrades to the identity
 * permutation. Non-pointer lines and pointers to non-`.md` files keep their
 * positions untouched. This only ever shapes the injected copy: callers never
 * write the result back to `MEMORY.md`.
 * @param {unknown} indexText
 * @param {unknown} query
 * @returns {string} the reordered text, or the input unchanged
 */
export function reorderIndexForQuery(indexText, query) {
  if (typeof indexText !== 'string' || indexText.length === 0) return indexText
  const terms = queryTermsForRanking(query)
  if (terms.length === 0) return indexText
  const pointers = parseIndexPointers(indexText)
  if (pointers.length === 0) return indexText
  const lines = indexText.replace(/\r\n?/g, '\n').split('\n')
  const ranked = pointers
    .map((pointer, order) => ({ pointer, order, score: scoreIndexPointer(pointer, terms) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
  const slotOfLine = new Map(pointers.map((pointer, position) => [pointer.lineIndex, position]))
  return lines
    .map((line, index) => {
      const slot = slotOfLine.get(index)
      return slot === undefined ? line : ranked[slot].pointer.lineIndex === index
        ? line
        : lines[ranked[slot].pointer.lineIndex]
    })
    .join('\n')
}

/**
 * Insert or replace the pointer for one file, keeping existing line order.
 * @param {unknown} indexText
 * @param {{ title?: string, file: string, hook?: string }} pointer
 * @returns {string} new index text ending with a newline ('' stays '')
 */
export function upsertPointer(indexText, pointer) {
  const base = typeof indexText === 'string' ? indexText.replace(/\r\n?/g, '\n') : ''
  const lines = base.trim().length === 0 ? [] : base.replace(/\s+$/u, '').split('\n')
  const rendered = renderPointer(pointer)
  const existing = parseIndexPointers(lines.join('\n')).find((entry) => entry.file === pointer.file)
  if (existing === undefined) {
    lines.push(rendered)
  } else {
    lines[existing.lineIndex] = rendered
  }
  return `${lines.join('\n')}\n`
}

/**
 * Remove every pointer line for one file.
 * @param {unknown} indexText
 * @param {string} file file name (e.g. `prefers-tabs.md`)
 * @returns {string} remaining index text ('' when nothing is left)
 */
export function removePointer(indexText, file) {
  if (typeof indexText !== 'string' || indexText.length === 0) return ''
  const text = indexText.replace(/\r\n?/g, '\n')
  const drop = new Set(
    parseIndexPointers(text).filter((entry) => entry.file === file).map((entry) => entry.lineIndex),
  )
  if (drop.size === 0) return text
  const kept = text.split('\n').filter((_line, index) => !drop.has(index))
  const trimmed = kept.join('\n').replace(/\s+$/u, '')
  return trimmed.length === 0 ? '' : `${trimmed}\n`
}

/* -------------------------------------------------------------- fact files */

/**
 * Serialize one YAML scalar without inventing a YAML library. Plain values stay
 * plain; values that could be misread are JSON-quoted (a JSON string is a valid
 * YAML double-quoted scalar).
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  const text = value.replace(/[\r\n]+/g, ' ').trim()
  if (text.length === 0) return '""'
  // ISO timestamps stay plain: colons inside them are never followed by a space,
  // so no YAML parser can misread the line as a nested mapping.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) return text
  // `#` starts a YAML comment, so any value containing it is quoted whole.
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/()'’+,-]*$/.test(text) && !text.endsWith(' ')) return text
  return JSON.stringify(text)
}

/**
 * Render one fact file.
 * @param {{
 *   name: string, description: string, type: string, body: string,
 *   why?: string, howToApply?: string, originSessionId?: string,
 *   createdAt?: string, updatedAt?: string
 * }} fact
 * @returns {string} markdown file content, or '' when the fact is invalid
 */
export function renderFactFile(fact) {
  if (fact === null || typeof fact !== 'object') return ''
  if (!isValidMemoryName(fact.name)) return ''
  if (!MEMORY_TYPES.includes(fact.type)) return ''
  const description = typeof fact.description === 'string' ? fact.description.trim() : ''
  const body = typeof fact.body === 'string' ? fact.body.trim() : ''
  if (description.length === 0 || body.length === 0) return ''

  const lines = [
    '---',
    `name: ${yamlScalar(fact.name)}`,
    `description: ${yamlScalar(description)}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${fact.type}`,
  ]
  const origin = typeof fact.originSessionId === 'string' ? fact.originSessionId.trim() : ''
  if (origin.length > 0) lines.push(`  originSessionId: ${yamlScalar(origin)}`)
  // Timestamps are host-maintained: callers pass existing values to preserve them
  // and omit them (or pass blanks) to have fresh ones minted at write time.
  const createdAt = timestampScalar(fact.createdAt) ?? nowIsoTimestamp()
  const updatedAt = timestampScalar(fact.updatedAt) ?? nowIsoTimestamp()
  lines.push(`  createdAt: ${createdAt}`)
  lines.push(`  updatedAt: ${updatedAt}`)
  lines.push('---', '')

  let text = `${lines.join('\n')}${body}\n`
  const why = typeof fact.why === 'string' ? fact.why.trim() : ''
  if (why.length > 0 && !/\*\*Why:\*\*/i.test(body)) text += `\n**Why:** ${why}\n`
  const how = typeof fact.howToApply === 'string' ? fact.howToApply.trim() : ''
  if (how.length > 0 && !/\*\*How to apply:\*\*/i.test(body)) text += `\n**How to apply:** ${how}\n`
  return text
}

/**
 * Parse the frontmatter fields this plugin owns. Legacy files without the
 * host-maintained timestamps parse fine — every field is optional.
 * @param {unknown} text fact file content
 * @returns {{
 *   name?: string, description?: string, type?: string, originSessionId?: string,
 *   createdAt?: string, updatedAt?: string, lastAccessedAt?: string
 * } | undefined}
 */
export function parseFactFrontmatter(text) {
  if (typeof text !== 'string') return undefined
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return undefined
  const block = normalized.slice(4, end)

  const result = {}
  let inMetadata = false
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/u, '')
    if (line.length === 0 || line.startsWith('#')) continue
    const indented = /^\s+/.test(line)
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = unquoteScalar(match[2])
    if (!indented && key === 'metadata') {
      inMetadata = true
      continue
    }
    if (!indented) {
      inMetadata = false
      if (key === 'name') result.name = value
      else if (key === 'description') result.description = value
      continue
    }
    if (!inMetadata) continue
    if (key === 'type') result.type = value
    else if (key === 'originSessionId') result.originSessionId = value
    else if (key === 'createdAt') result.createdAt = value
    else if (key === 'updatedAt') result.updatedAt = value
    else if (key === 'lastAccessedAt') result.lastAccessedAt = value
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Current time as an ISO 8601 UTC timestamp, the wire format for every
 * host-maintained frontmatter timestamp.
 * @returns {string}
 */
export function nowIsoTimestamp() {
  return new Date().toISOString()
}

/**
 * Return the value when it already looks like an ISO 8601 UTC timestamp
 * (the shape {@link nowIsoTimestamp} produces), else undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function timestampScalar(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) return text
  return undefined
}

/**
 * Interpret a YAML scalar written by {@link yamlScalar}.
 * @param {string} raw
 * @returns {string}
 */
function unquoteScalar(raw) {
  const text = raw.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return String(JSON.parse(text))
    } catch (_ignored) {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1)
  return text
}

/**
 * Build the existing-memory manifest handed to the extraction model.
 * @param {Array<{ fileName: string, content: string }>} files
 * @param {number} [limit]
 * @returns {Array<{ name: string, description: string }>}
 */
export function buildManifest(files, limit = 50) {
  const manifest = []
  for (const file of files) {
    if (manifest.length >= limit) break
    const name = parseFactFileName(file.fileName)
    if (name === undefined) continue
    const front = parseFactFrontmatter(file.content)
    const description = typeof front?.description === 'string' ? front.description : ''
    manifest.push({ name, description, excerpt: conflictExcerpt(file.content) })
  }
  return manifest
}

/**
 * Decide which trash files exceed the retention cap.
 * @param {Array<{ name: string, mtimeMs: number }>} entries trash contents
 * @param {number} [limit] how many files the trash keeps
 * @returns {string[]} names of the oldest entries beyond the limit
 */
export function selectTrashEvictions(entries, limit = TRASH_KEEP) {
  const files = Array.isArray(entries) ? entries : []
  if (files.length <= limit) return []
  const ranked = files
    .filter((entry) => typeof entry?.name === 'string' && Number.isFinite(entry.mtimeMs))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  return ranked.slice(0, Math.max(0, ranked.length - limit)).map((entry) => entry.name)
}

/* -------------------------------------------------------------- extraction */

/**
 * Count word units for the eligibility rule.
 *
 * ZCode counts whitespace-separated words only, which never reaches the
 * threshold for Chinese/Japanese/Korean prose (no spaces). Ported with a CJK
 * adjustment: each CJK character counts as half a word, rounded up, so a real
 * sentence qualifies while a bare "好的"/"继续" still skips extraction.
 * @param {unknown} text
 * @returns {number} word units (0 for empty input)
 */
export function countWords(text) {
  if (typeof text !== 'string') return 0
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  const cjk = trimmed.match(CJK_CHARACTER)?.length ?? 0
  const rest = cjk === 0 ? trimmed : trimmed.replace(CJK_CHARACTER_SPLIT, ' ')
  const words = rest.trim().split(/\s+/u).filter(Boolean).length
  return words + Math.ceil(cjk / 2)
}

/**
 * Decide whether this completed turn deserves an extraction request.
 * @param {{ userBlocks?: readonly string[], directWrite?: boolean }} input
 * @returns {{ run: boolean, reason?: 'direct-memory-write' | 'no-user-prose' }}
 */
export function evaluateExtraction(input) {
  if (input?.directWrite === true) return { run: false, reason: 'direct-memory-write' }
  const blocks = Array.isArray(input?.userBlocks) ? input.userBlocks : []
  const eligible = blocks.some((block) => countWords(block) >= MIN_USER_WORDS)
  if (!eligible) return { run: false, reason: 'no-user-prose' }
  return { run: true }
}

/**
 * Render the turn transcript handed to the extraction model, keeping the newest
 * content when the cap applies.
 * @param {Array<{ role: 'user' | 'assistant', text: string }>} messages
 * @param {number} [maxChars]
 * @returns {{ text: string, truncated: boolean }}
 */
export function buildTranscript(messages, maxChars = MAX_TRANSCRIPT_CHARS) {
  const blocks = []
  for (const message of messages) {
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (text.length === 0) continue
    blocks.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`)
  }
  let text = blocks.join('\n\n')
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars)
    const firstBreak = text.indexOf('\n\n')
    if (firstBreak > 0) text = text.slice(firstBreak + 2)
    truncated = true
  }
  return { text, truncated }
}

/**
 * Roadmap D6: split one turn into at most `maxSegments` transcripts so an
 * oversized turn is extracted piecewise instead of silently losing its oldest
 * content to {@link buildTranscript}'s tail cap.
 *
 * A turn that fits returns exactly one segment (identical text to
 * `buildTranscript`, so the single-call path is unchanged). A longer turn is
 * cut into contiguous message groups weighted by character count. When even
 * `maxSegments × maxChars` cannot hold the turn, whole oldest messages are
 * dropped first — the same direction `buildTranscript` truncates — so the
 * newest content always survives.
 *
 * @param {Array<{ role: 'user' | 'assistant', text: string }>} messages
 * @param {number} [maxChars]
 * @param {number} [maxSegments]
 * @returns {string[]} 0–`maxSegments` non-empty transcript segments, in turn order
 */
export function buildTranscriptSegments(messages, maxChars = MAX_TRANSCRIPT_CHARS, maxSegments = MAX_TRANSCRIPT_SEGMENTS) {
  const blocks = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = typeof message?.text === 'string' ? message.text.trim() : ''
    if (text.length === 0) continue
    blocks.push(`${message?.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`)
  }
  if (blocks.length === 0) return []
  const cap = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : MAX_TRANSCRIPT_CHARS
  const limit = Number.isSafeInteger(maxSegments) && maxSegments > 0 ? maxSegments : MAX_TRANSCRIPT_SEGMENTS
  let kept = blocks
  let total = kept.reduce((sum, block) => sum + block.length + 2, 0) - 2
  if (total <= cap) return [kept.join('\n\n')]

  // The turn cannot fit in `limit` windows at all: drop whole oldest messages.
  while (kept.length > 1 && total > limit * cap) {
    total -= kept[0].length + 2
    kept = kept.slice(1)
  }
  if (kept.length === 1) return [clipTranscriptTail(kept[0], cap)]

  const count = Math.max(1, Math.min(limit, Math.ceil(total / cap)))
  const target = total / count
  const segments = []
  let current = []
  let size = 0
  for (const block of kept) {
    // Close the current group once it reaches its share of the character
    // budget, while leaving one group per remaining segment untouched.
    if (current.length > 0 && segments.length < count - 1 && size + block.length + 2 > target) {
      segments.push(current.join('\n\n'))
      current = []
      size = 0
    }
    current.push(block)
    size += block.length + (current.length > 1 ? 2 : 0)
  }
  if (current.length > 0) segments.push(current.join('\n\n'))

  return segments.map((text) => (text.length <= cap ? text : clipTranscriptTail(text, cap)))
}

/** Newest `cap` characters of one rendered transcript, cut at a message boundary when possible. */
function clipTranscriptTail(text, cap) {
  let clipped = text.slice(text.length - cap)
  const firstBreak = clipped.indexOf('\n\n')
  if (firstBreak > 0) clipped = clipped.slice(firstBreak + 2)
  return clipped
}

/**
 * The frozen extraction instruction (ZCode `buildMemoryExtractionPrompt`, adapted
 * to a single JSON reply instead of a restricted memory agent loop).
 * Roadmap D1 (global layer withdrawn): the manifest lists the memory files of
 * this workspace's directory only, so `forget` and dedupe stay inside it.
 * Roadmap D4: `conflictGuidance` (built by
 * {@link buildConflictGuidance}) is appended after the manifest on the
 * conflict re-ask, with body excerpts of the near-matching files.
 * @param {{ messageCount: number, manifest?: Array<{ name: string, description: string, excerpt?: string }>, conflictGuidance?: string }} input
 * @returns {string}
 */
export function buildExtractionPrompt(input) {
  const messageCount = Number.isSafeInteger(input?.messageCount) && input.messageCount > 0
    ? input.messageCount
    : 0
  const manifest = Array.isArray(input?.manifest) ? input.manifest : []
  const existing = manifest.length === 0
    ? ''
    : [
        '',
        '## Existing memory files',
        '',
        ...manifest.map((entry) => {
          return `- ${entry.name}${entry.description ? `: ${entry.description}` : ''}`
        }),
        '',
        'Check this list before writing — update an existing file rather than creating a duplicate. Every entry lives in this workspace\'s own memory directory; keep new facts there too.',
      ].join('\n')

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${messageCount} messages above and use them to update the workspace memory.`,
    '',
    'Use only content from those messages. Do not grep source files, read code, or run git commands to investigate further.',
    '',
    'Reply with one JSON object and nothing else:',
    '{"memories":[{"name":"short-kebab-slug","title":"Title","type":"user|feedback|project|reference","description":"one line","body":"markdown fact","why":"optional, feedback/project","howToApply":"optional, feedback/project"}],"forget":["existing-fact-name"]}',
    '',
    'Rules: at most 5 memories this run; `name` is lowercase kebab-case with no type prefix; one fact per memory; link related memories with [[their-name]]; apply the memory types and the what-not-to-save criteria from the Memory section of your system prompt.',
    '',
    "If nothing is worth saving, reply exactly {\"memories\":[],\"forget\":[]}. Do not explain why.",
    '',
    'If the user explicitly asks you to remember something, save it as whichever type fits best. If they ask you to forget something, list the matching existing fact name in `forget`.',
    ...(existing.length === 0 ? [''] : [existing, ...(typeof input?.conflictGuidance === 'string' && input.conflictGuidance.length > 0 ? [input.conflictGuidance] : []), '']),
    '## Conversation',
  ].join('\n')
}

/**
 * Find the first JSON object in a model reply, tolerating markdown code fences
 * and surrounding prose.
 * @param {unknown} text
 * @returns {unknown | undefined} parsed value, or undefined when nothing parses
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return undefined
  const candidates = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  for (let match = fenced.exec(text); match !== null; match = fenced.exec(text)) {
    candidates.push(match[1])
  }
  candidates.push(text)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start < 0) continue
    const slice = candidate.slice(start)
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = 0; i < slice.length; i += 1) {
      const char = slice[i]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) continue
    try {
      return JSON.parse(slice.slice(0, end + 1))
    } catch (_ignored) {
      // try the next candidate
    }
  }
  return undefined
}

/**
 * Validate and normalize one extraction reply. Entries that fail validation
 * (wrong type, missing description/body) are dropped individually; only a
 * non-object reply or non-array `memories`/`forget` abandons the whole batch.
 * @param {unknown} text model reply text
 * @param {{ maxFacts?: number }} [options]
 * @returns {{ memories: Array<object>, forget: string[] } | undefined}
 */
export function parseExtractionResponse(text, options = {}) {
  const parsed = extractJsonObject(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const rawMemories = parsed.memories === undefined ? [] : parsed.memories
  const rawForget = parsed.forget === undefined ? [] : parsed.forget
  if (!Array.isArray(rawMemories) || !Array.isArray(rawForget)) return undefined

  const canonical = new Map()
  for (const raw of rawMemories) {
    const memory = normalizeExtractedMemory(raw)
    if (memory !== undefined) canonical.set(memory.name, memory)
  }
  const maxFacts = Number.isSafeInteger(options.maxFacts) && options.maxFacts > 0
    ? options.maxFacts
    : MAX_FACTS_PER_RUN
  const memories = [...canonical.values()].slice(0, maxFacts)
  const forget = [...new Set(rawForget.filter((name) => isValidMemoryName(name)))]
  return { memories, forget }
}

/**
 * Deterministic fallback fact name for entries whose title cannot be slugged
 * (pure CJK titles leave `slugifyTitle` with nothing usable). The hash covers
 * the whole entry so two same-titled facts in one run stay distinct.
 * @param {{ type: unknown, description: unknown, body: unknown }} raw
 * @returns {string} `fact-` + first 8 hex chars of the SHA-256 of the entry JSON
 */
function fallbackFactName(raw) {
  const content = JSON.stringify([raw.type, raw.description, raw.body])
  return `fact-${createHash('sha256').update(content).digest('hex').slice(0, 8)}`
}

/**
 * Normalize one extraction memory entry. The name is repaired (slug from
 * `name`, then title, then a content hash fallback); only an entry missing
 * body/description or a valid type is dropped — one bad entry no longer
 * abandons the rest of the batch (the caller filters undefined).
 * @param {unknown} raw
 * @returns {object | undefined}
 */
function normalizeExtractedMemory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const title = typeof raw.title === 'string' ? raw.title.replace(/[\r\n]+/g, ' ').trim() : ''
  const name = isValidMemoryName(raw.name)
    ? raw.name
    : (slugifyTitle(raw.name ?? title) ?? fallbackFactName(raw))
  if (!MEMORY_TYPES.includes(raw.type)) return undefined
  const description = typeof raw.description === 'string'
    ? raw.description.replace(/[\r\n]+/g, ' ').trim()
    : ''
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  if (description.length === 0 || body.length === 0) return undefined
  return {
    name,
    title: title.length === 0 ? deriveTitle(name) : title,
    type: raw.type,
    description,
    body,
    why: typeof raw.why === 'string' ? raw.why.trim() : '',
    howToApply: typeof raw.howToApply === 'string' ? raw.howToApply.trim() : '',
  }
}

/* -------------------------------------------------------------------- route */

/**
 * Pick the provider/model route for the extraction call. Mirrors the shipped
 * `configured ?? latest ?? agentTarget` precedence.
 * @param {{
 *   requestContext?: unknown, requestHeader?: unknown,
 *   agentOptions?: unknown, defaultSelection?: unknown
 * }} input
 * @returns {{ provider: string, model: string } | undefined}
 */
export function pickRoute(input) {
  const candidates = [
    normalizeRoute(input?.requestContext),
    normalizeRoute(input?.requestHeader?.config ?? input?.requestHeader),
    normalizeRoute(input?.agentOptions),
    normalizeRoute(input?.defaultSelection),
  ]
  return candidates.find((candidate) => candidate !== undefined)
}

/**
 * Normalize one route candidate.
 * @param {unknown} candidate
 * @returns {{ provider: string, model: string } | undefined}
 */
function normalizeRoute(candidate) {
  if (candidate === null || typeof candidate !== 'object') return undefined
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Decide whether a planned index may replace the current one.
 *
 * A run may only lose as many pointer lines as it explicitly forgets, and it
 * may only introduce or rewrite pointers for fact files it actually writes
 * this run. Anything worse means the base the plan was built from was not the
 * real index (an unreadable file read as empty, a stale cache, a truncated
 * read), so the write must be refused instead of silently dropping or
 * replacing memories in the index. An empty current index is always accepted:
 * the very first index of a workspace has no base to diff against.
 *
 * @param {unknown} before current index text
 * @param {unknown} after planned index text
 * @param {unknown} forgottenFiles files this run explicitly forgets
 * @param {unknown} [writtenFiles] fact files this run writes; only their pointers may be introduced or rewritten
 * @returns {{ ok: boolean, reason: string, beforeCount: number, afterCount: number, allowedFloor: number }}
 */
export function evaluateIndexReplacement(before, after, forgottenFiles, writtenFiles) {
  const beforeCount = parseIndexPointers(typeof before === 'string' ? before : '').length
  const afterCount = parseIndexPointers(typeof after === 'string' ? after : '').length
  const forgotten = Array.isArray(forgottenFiles) ? forgottenFiles.length : 0
  const allowedFloor = Math.max(0, beforeCount - forgotten)
  if (afterCount < allowedFloor) {
    const reason = 'planned index has ' + afterCount + ' pointer(s), the current one has '
      + beforeCount + ' and only ' + forgotten + ' forgotten; refusing to write'
    return { ok: false, reason, beforeCount, afterCount, allowedFloor }
  }
  if (typeof before === 'string' && before.length > 0) {
    const writes = new Set(Array.isArray(writtenFiles) ? writtenFiles : [])
    const existing = new Map()
    for (const pointer of parseIndexPointers(before)) existing.set(pointer.file, pointer)
    for (const pointer of parseIndexPointers(after)) {
      const prior = existing.get(pointer.file)
      if (prior === undefined) {
        if (!writes.has(pointer.file)) {
          const reason = 'planned index introduces a pointer for ' + pointer.file
            + ' that is neither in the current index nor written this run; refusing to write'
          return { ok: false, reason, beforeCount, afterCount, allowedFloor }
        }
      } else if (prior.title !== pointer.title || prior.hook !== pointer.hook) {
        if (!writes.has(pointer.file)) {
          const reason = 'planned index rewrites the pointer for ' + pointer.file
            + ' without writing that file this run; refusing to write'
          return { ok: false, reason, beforeCount, afterCount, allowedFloor }
        }
      }
    }
  }
  return { ok: true, reason: '', beforeCount, afterCount, allowedFloor }
}

/* ------------------------------------------------------------ conflict guidance */

/**
 * Strip frontmatter from a fact file, returning the body markdown. Files
 * without a frontmatter block count as all-body.
 * @param {unknown} text fact file content
 * @returns {string}
 */
export function factBodyText(text) {
  if (typeof text !== 'string') return ''
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized.trim()
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return normalized.trim()
  return normalized.slice(end + 4).replace(/^-\n/, '').trim()
}

/**
 * Levenshtein edit distance with an early exit above `max` — the manifest
 * comparison only needs the ≤ 2 verdict, not the exact number.
 * @param {string} a
 * @param {string} b
 * @param {number} max bail out once the distance provably exceeds this
 * @returns {number} min(distance, max + 1)
 */
function boundedEditDistance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_v, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]
}

/**
 * Roadmap D4: match candidate fact names against manifest entries so near
 * duplicates can be guided back onto the existing file. A match is a shared
 * prefix (either direction, ≥ 3 chars) or an edit distance ≤ 2.
 * @param {string[]} names candidate names from the extraction reply
 * @param {Array<{ name: string }>} manifest existing entries
 * @returns {Map<string, string[]>} manifest name → candidate names that hit it
 */
export function findNearDuplicateMatches(names, manifest) {
  const entries = Array.isArray(manifest) ? manifest : []
  const wanted = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.length > 0) : []
  const matches = new Map()
  if (entries.length === 0 || wanted.length === 0) return matches
  for (const candidate of wanted) {
    for (const entry of entries) {
      const existing = typeof entry?.name === 'string' ? entry.name : ''
      if (existing.length === 0) continue
      if (candidate === existing) continue // exact upsert — no conflict guidance needed
      const near = (candidate.startsWith(existing) || existing.startsWith(candidate))
          && candidate.length >= 3 && existing.length >= 3
        || boundedEditDistance(candidate, existing, 2) <= 2
      if (!near) continue
      const list = matches.get(existing)
      if (list === undefined) matches.set(existing, [candidate])
      else if (!list.includes(candidate)) list.push(candidate)
    }
  }
  return matches
}

/** Cap on the excerpt rendered per conflicting manifest entry (chars). */
export const CONFLICT_EXCERPT_MAX_CHARS = 600

/**
 * One entry's excerpt for the conflict prompt: the fact body collapsed to
 * single-spaced lines and truncated on a whole-word boundary.
 * @param {unknown} text full fact file content
 * @param {number} [maxChars]
 * @returns {string}
 */
export function conflictExcerpt(text, maxChars = CONFLICT_EXCERPT_MAX_CHARS) {
  const body = factBodyText(text).replace(/\s+/gu, ' ').trim()
  if (body.length <= maxChars) return body
  let cut = body.lastIndexOf(' ', maxChars)
  if (cut < Math.floor(maxChars / 2)) cut = maxChars
  return `${body.slice(0, cut)}…`
}

/**
 * Roadmap D4: the re-ask block listing the conflicting entries with their body
 * excerpts, steering the model to update those files in place.
 * @param {Map<string, string[]>} matches manifest name → candidate names
 * @param {Map<string, { excerpt?: string }>} details per manifest name
 * @returns {string} '' when there is nothing to say
 */
export function buildConflictGuidance(matches, details) {
  const pairs = matches instanceof Map ? [...matches.entries()] : []
  if (pairs.length === 0) return ''
  const lines = [
    '',
    '## Conflicting existing files',
    '',
    'Your reply named files that closely match existing memories below. Each excerpt shows the current file body — update that existing file in place (same `name`) instead of writing a new one, unless the fact truly does not belong there.',
    '',
  ]
  for (const [name, candidates] of pairs) {
    const detail = details instanceof Map ? details.get(name) : undefined
    lines.push(`- ${name} (your reply used: ${candidates.join(', ')}): ${detail?.excerpt ?? ''}`)
  }
  return lines.join('\n')
}

/* --------------------------------------------------- consolidation proposals */

/**
 * Roadmap D8: sub-directory of one memory root that holds consolidation
 * proposals. It is deliberately NOT part of the fact namespace — nothing in
 * `proposals/` is ever injected, counted as a fact, exported, or repaired into
 * the index.
 */
export const PROPOSALS_DIR = 'proposals'

/** File-name prefix of one proposal file (`consolidation-<iso>.md`). */
export const PROPOSAL_FILE_PREFIX = 'consolidation-'

/** Fact count above which the next extraction also writes a proposal file. */
export const PROPOSAL_FACT_THRESHOLD = 60

/** A fact untouched for this many days is listed as long-unaccessed. */
export const PROPOSAL_STALE_DAYS = 90

/**
 * Bullets listed per section. The marker keeps every machine-readable item —
 * this caps only the prose, so a large memory directory still yields a readable file
 * instead of a megabyte of near-duplicate pairs.
 */
export const PROPOSAL_ITEM_LIMIT = 50

/** Marker block kind embedded at the end of every proposal file. */
export const PROPOSAL_MARKER_KIND = 'workspace-memory-proposals'

/** Marker block version (bumped only on an incompatible shape change). */
export const PROPOSAL_MARKER_VERSION = 1

/** Shared threshold for "two descriptions are about the same thing". */
const CONTRADICTION_JACCARD = 0.6

/** Minimum significant terms per side before a description pair is compared. */
const CONTRADICTION_MIN_TERMS = 3

const PROPOSAL_FILE_PATTERN = /^consolidation-[0-9A-Za-z-]+\.md$/

/**
 * Absolute proposals directory inside one memory root.
 * @param {string} root memory root
 * @returns {string} `<root>/proposals`
 */
export function proposalsDirPath(root) {
  return join(root, PROPOSALS_DIR)
}

/**
 * Whether one entry name is a proposal file (and therefore never a fact).
 * @param {unknown} fileName
 * @returns {boolean}
 */
export function isProposalFileName(fileName) {
  return typeof fileName === 'string' && PROPOSAL_FILE_PATTERN.test(fileName)
}

/**
 * File name of one proposal, derived from its creation timestamp so files sort
 * chronologically and never collide on one filesystem-safe stem.
 * @param {string} [at] ISO 8601 timestamp; default now
 * @returns {string} `consolidation-<fs-safe-iso>.md`
 */
export function proposalFileName(at = nowIsoTimestamp()) {
  const stamp = (typeof at === 'string' && at.length > 0 ? at : nowIsoTimestamp())
    .replace(/[:.]/gu, '-')
    .replace(/[^0-9A-Za-z-]/gu, '')
  return PROPOSAL_FILE_PREFIX + stamp + '.md'
}

/**
 * Significant terms of one fact description, lower-cased and de-duplicated.
 * Used only by the contradiction heuristic, so it stays deliberately blunt.
 * @param {unknown} description
 * @returns {string[]}
 */
function descriptionTerms(description) {
  if (typeof description !== 'string') return []
  const terms = new Set()
  for (const raw of description.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue
    if (RANKING_STOP_WORDS.has(raw)) continue
    terms.add(raw)
    if (terms.size >= 12) break
  }
  return [...terms]
}

/**
 * Roadmap D8 contradiction heuristic: two facts of one memory directory whose
 * descriptions are textually the same or nearly the same are candidates for a
 * human review — the model may have recorded the same preference twice with
 * different names. Deterministic and cheap on purpose: the output is a
 * proposal, never an applied change.
 * @param {Array<{ name: string, description?: string }>} facts
 * @returns {Array<{ a: string, b: string, reason: string, shared: string[] }>}
 */
export function findContradictionCandidates(facts) {
  const entries = []
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact.name !== 'string' || fact.name.length === 0) continue
    entries.push({ name: fact.name, description: typeof fact.description === 'string' ? fact.description : '' })
  }
  const candidates = []
  for (let i = 0; i < entries.length; i += 1) {
    const left = entries[i]
    const leftText = left.description.trim().toLowerCase()
    const leftTerms = descriptionTerms(left.description)
    for (let j = i + 1; j < entries.length; j += 1) {
      const right = entries[j]
      const rightText = right.description.trim().toLowerCase()
      if (leftText.length > 0 && leftText === rightText) {
        candidates.push({ a: left.name, b: right.name, reason: 'identical description', shared: [] })
        continue
      }
      const rightTerms = descriptionTerms(right.description)
      if (leftTerms.length < CONTRADICTION_MIN_TERMS || rightTerms.length < CONTRADICTION_MIN_TERMS) continue
      const rightSet = new Set(rightTerms)
      const shared = leftTerms.filter((term) => rightSet.has(term))
      const union = new Set([...leftTerms, ...rightTerms]).size
      if (union === 0) continue
      if (shared.length / union < CONTRADICTION_JACCARD) continue
      candidates.push({ a: left.name, b: right.name, reason: 'descriptions overlap heavily', shared })
    }
  }
  return candidates
}

/**
 * Roadmap D8: facts nobody has read for `staleDays`. The timestamp chain is
 * lastAccessedAt → updatedAt → createdAt, so a fact that was never accessed
 * still ages from the day it was written; a fact with no usable timestamp at
 * all is skipped rather than reported with a guessed age.
 * @param {Array<{ name: string, createdAt?: string, updatedAt?: string, lastAccessedAt?: string }>} facts
 * @param {number} nowMs epoch ms of "now"
 * @param {number} [staleDays]
 * @returns {Array<{ name: string, at: string, days: number }>} oldest first
 */
export function selectStaleFacts(facts, nowMs, staleDays = PROPOSAL_STALE_DAYS) {
  if (!Number.isFinite(nowMs)) return []
  const windowMs = Math.max(0, staleDays) * 86400000
  const stale = []
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact.name !== 'string' || fact.name.length === 0) continue
    let best = 0
    for (const value of [fact.lastAccessedAt, fact.updatedAt, fact.createdAt]) {
      const ms = Date.parse(typeof value === 'string' ? value : '')
      if (Number.isFinite(ms) && ms > best) best = ms
    }
    if (best === 0) continue
    const age = nowMs - best
    if (age <= windowMs) continue
    stale.push({ name: fact.name, at: new Date(best).toISOString(), days: Math.floor(age / 86400000) })
  }
  return stale.sort((a, b) => b.days - a.days || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Roadmap D8 near-duplicate clusters for one memory directory.
 *
 * Reuses {@link findNearDuplicateMatches} — the extraction conflict matcher —
 * against the directory's own names, so the proposal lists exactly the pairs the
 * extractor would have surfaced as a conflict. Each pair becomes one item whose
 * `keep` is the name that appears first in the index/manifest order (stable and
 * reviewable), and every pair is emitted once.
 * @param {string[]} names fact names in index order
 * @returns {Array<{ kind: 'near-duplicate', keep: string, drop: string[] }>}
 */
export function findNearDuplicateClusters(names) {
  const order = new Map()
  const list = []
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || name.length === 0 || order.has(name)) continue
    order.set(name, list.length)
    list.push(name)
  }
  if (list.length < 2) return []
  const matches = findNearDuplicateMatches(list, list.map((name) => ({ name })))
  const seen = new Set()
  const items = []
  for (const [existing, candidates] of matches) {
    for (const candidate of candidates) {
      const first = order.get(existing) ?? 0
      const second = order.get(candidate) ?? 0
      const keep = first <= second ? existing : candidate
      const drop = first <= second ? candidate : existing
      const key = keep + '\u0000' + drop
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ kind: 'near-duplicate', keep, drop: [drop] })
    }
  }
  return items.sort((a, b) => (order.get(a.keep) ?? 0) - (order.get(b.keep) ?? 0)
    || (a.drop[0] < b.drop[0] ? -1 : a.drop[0] > b.drop[0] ? 1 : 0))
}

/**
 * The marker block of one proposal file: a fenced JSON object the Host can read
 * back without parsing English prose. It is the machine-readable half of the
 * file, `items` being the only part an accept call can act on.
 * @param {object} marker
 * @returns {string}
 */
function renderProposalMarker(marker) {
  return '```json\n' + JSON.stringify(marker, null, 2) + '\n```\n'
}

/**
 * Roadmap D8: render one proposal file. Plain markdown with three fixed
 * sections — near-duplicate names, contradiction candidates, long-unaccessed
 * facts — plus the marker block. The file states, in the first paragraph, that
 * nothing has been applied: a proposal is a review artifact, never an action.
 * @param {{
 *   createdAt: string,
 *   root: string,
 *   factCount: number,
 *   threshold?: number,
 *   nearDuplicates?: Array<{ keep: string, drop: string[] }>,
 *   contradictions?: Array<{ a: string, b: string, reason: string, shared?: string[] }>,
 *   stale?: Array<{ name: string, at: string, days: number }>,
 *   acceptedAt?: string,
 * }} input
 * @returns {string}
 */
export function renderProposalFile(input) {
  const createdAt = typeof input?.createdAt === 'string' ? input.createdAt : nowIsoTimestamp()
  const threshold = typeof input?.threshold === 'number' ? input.threshold : PROPOSAL_FACT_THRESHOLD
  const nearDuplicates = Array.isArray(input?.nearDuplicates) ? input.nearDuplicates : []
  const contradictions = Array.isArray(input?.contradictions) ? input.contradictions : []
  const stale = Array.isArray(input?.stale) ? input.stale : []
  const factCount = typeof input?.factCount === 'number' ? input.factCount : 0
  const lines = [
    '# Consolidation proposals',
    '',
    'Generated: ' + createdAt,
    'Root: ' + (typeof input?.root === 'string' ? input.root : ''),
    'Facts: ' + factCount + ' (threshold ' + threshold + ')',
    '',
    'Proposals only — nothing in this file has been applied. Review each item and',
    'act by hand, or accept the near-duplicate drops with the `proposals-accept`',
    'RPC endpoint. Contradiction candidates and long-unaccessed facts are',
    'informational: they need a human decision, not an automatic edit.',
    '',
    '## Near-duplicate names',
    '',
  ]
  if (nearDuplicates.length === 0) {
    lines.push('None.')
  } else {
    for (const item of nearDuplicates.slice(0, PROPOSAL_ITEM_LIMIT)) {
      const drops = Array.isArray(item?.drop) ? item.drop.filter((name) => typeof name === 'string') : []
      lines.push('- keep `' + String(item?.keep ?? '') + '`, drop `' + drops.join('`, `') + '` — names are one edit apart')
    }
    if (nearDuplicates.length > PROPOSAL_ITEM_LIMIT) {
      lines.push('- … ' + (nearDuplicates.length - PROPOSAL_ITEM_LIMIT) + ' more pairs not listed')
    }
  }
  lines.push('', '## Contradiction candidates', '')
  if (contradictions.length === 0) {
    lines.push('None.')
  } else {
    for (const item of contradictions.slice(0, PROPOSAL_ITEM_LIMIT)) {
      const shared = Array.isArray(item?.shared) && item.shared.length > 0 ? ' (shared: ' + item.shared.join(', ') + ')' : ''
      lines.push('- `' + String(item?.a ?? '') + '` vs `' + String(item?.b ?? '') + '`: '
        + String(item?.reason ?? 'possible contradiction') + shared)
    }
    if (contradictions.length > PROPOSAL_ITEM_LIMIT) {
      lines.push('- … ' + (contradictions.length - PROPOSAL_ITEM_LIMIT) + ' more pairs not listed')
    }
  }
  lines.push('', '## Long-unaccessed facts', '')
  if (stale.length === 0) {
    lines.push('None.')
  } else {
    for (const item of stale.slice(0, PROPOSAL_ITEM_LIMIT)) {
      lines.push('- `' + String(item?.name ?? '') + '` — last touched ' + String(item?.at ?? '')
        + ' (' + String(item?.days ?? 0) + ' days ago)')
    }
    if (stale.length > PROPOSAL_ITEM_LIMIT) {
      lines.push('- … ' + (stale.length - PROPOSAL_ITEM_LIMIT) + ' more facts not listed')
    }
  }
  lines.push('')
  const marker = {
    kind: PROPOSAL_MARKER_KIND,
    version: PROPOSAL_MARKER_VERSION,
    factCount,
    threshold,
    createdAt,
    items: nearDuplicates
      .map((item) => ({
        kind: 'near-duplicate',
        keep: String(item?.keep ?? ''),
        drop: Array.isArray(item?.drop) ? item.drop.filter((name) => typeof name === 'string') : [],
      }))
      .filter((item) => item.keep.length > 0 && item.drop.length > 0),
    counts: {
      nearDuplicates: nearDuplicates.length,
      contradictions: contradictions.length,
      stale: stale.length,
    },
    acceptedAt: typeof input?.acceptedAt === 'string' ? input.acceptedAt : '',
  }
  lines.push(renderProposalMarker(marker))
  return lines.join('\n')
}

/**
 * Read the marker block back out of one proposal file.
 * @param {unknown} text proposal file content
 * @returns {{ factCount: number, threshold: number, createdAt: string, items: Array<{ kind: string, keep: string, drop: string[] }>, acceptedAt: string } | undefined}
 */
export function parseProposalFile(text) {
  if (typeof text !== 'string') return undefined
  const match = /```json\n([\s\S]*?)\n```/u.exec(text)
  if (match === null) return undefined
  let parsed
  try {
    parsed = JSON.parse(match[1])
  } catch (_error) {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== PROPOSAL_MARKER_KIND) return undefined
  const items = []
  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    if (!raw || raw.kind !== 'near-duplicate') continue
    const keep = typeof raw.keep === 'string' ? raw.keep : ''
    const drop = Array.isArray(raw.drop) ? raw.drop.filter((name) => typeof name === 'string' && name.length > 0) : []
    if (keep.length === 0 || drop.length === 0) continue
    items.push({ kind: 'near-duplicate', keep, drop })
  }
  const countsRaw = parsed && typeof parsed.counts === 'object' && parsed.counts !== null ? parsed.counts : {}
  const counts = {
    nearDuplicates: typeof countsRaw.nearDuplicates === 'number' ? countsRaw.nearDuplicates : items.length,
    contradictions: typeof countsRaw.contradictions === 'number' ? countsRaw.contradictions : 0,
    stale: typeof countsRaw.stale === 'number' ? countsRaw.stale : 0,
  }
  return {
    factCount: typeof parsed.factCount === 'number' ? parsed.factCount : 0,
    threshold: typeof parsed.threshold === 'number' ? parsed.threshold : PROPOSAL_FACT_THRESHOLD,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    items,
    counts,
    acceptedAt: typeof parsed.acceptedAt === 'string' ? parsed.acceptedAt : '',
  }
}
