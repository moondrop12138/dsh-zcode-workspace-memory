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

import { join } from 'node:path'

/** Directory segments appended to a workspace root. */
export const MEMORY_DIR_SEGMENTS = Object.freeze(['.dsh', 'memory'])

/** Index file name inside the memory directory. */
export const INDEX_FILE = 'MEMORY.md'

/** Accepted `metadata.type` values (ZCode file protocol). */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/** Injection bounds for the index block (ZCode `index-content.ts`). */
export const MAX_INDEX_LINES = 200
export const DEFAULT_MAX_INDEX_CHARS = 25000

/** Extraction bounds (ZCode: 5-turn memory agent budget → 5 facts here). */
export const MAX_FACTS_PER_RUN = 5
export const MAX_TRANSCRIPT_CHARS = 24000
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
 * @param {unknown} raw raw file content
 * @param {{ maxLines?: number, maxChars?: number }} [options]
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
 * `write`/`edit` tools, read-before-write, AGENTS.md).
 * @param {string} root absolute memory root
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
    'After writing the file, add a one-line pointer in `MEMORY.md` (`- [Title](file.md) — hook`). `MEMORY.md` is the index loaded into every session\'s context — one line per memory, no frontmatter, never put memory content there.',
    '',
    "Before saving, check for an existing file that already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, AGENTS.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Existing files must be read before you overwrite them, and `glob`/`grep` can search this directory.",
  ].join('\n')
}

/**
 * Render the complete injected section: rules, plus the formatted index when the
 * workspace already has one.
 * @param {{ root: string, rawIndex?: unknown, maxChars?: number }} input
 * @returns {{ text: string, indexTruncated: boolean, indexLineCount: number }}
 */
export function renderMemorySection(input) {
  const root = typeof input.root === 'string' ? input.root : ''
  const formatted = formatIndexContent(input.rawIndex, { maxChars: input.maxChars })
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
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/()#'’+,-]*$/.test(text) && !text.endsWith(' ')) return text
  return JSON.stringify(text)
}

/**
 * Render one fact file.
 * @param {{
 *   name: string, description: string, type: string, body: string,
 *   why?: string, howToApply?: string, originSessionId?: string
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
  lines.push('---', '')

  let text = `${lines.join('\n')}${body}\n`
  const why = typeof fact.why === 'string' ? fact.why.trim() : ''
  if (why.length > 0 && !/\*\*Why:\*\*/i.test(body)) text += `\n**Why:** ${why}\n`
  const how = typeof fact.howToApply === 'string' ? fact.howToApply.trim() : ''
  if (how.length > 0 && !/\*\*How to apply:\*\*/i.test(body)) text += `\n**How to apply:** ${how}\n`
  return text
}

/**
 * Parse the frontmatter fields this plugin owns.
 * @param {unknown} text fact file content
 * @returns {{ name?: string, description?: string, type?: string, originSessionId?: string } | undefined}
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
  }
  return Object.keys(result).length === 0 ? undefined : result
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
    manifest.push({ name, description })
  }
  return manifest
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
 * The frozen extraction instruction (ZCode `buildMemoryExtractionPrompt`, adapted
 * to a single JSON reply instead of a restricted memory agent loop).
 * @param {{ messageCount: number, manifest?: Array<{ name: string, description: string }> }} input
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
        ...manifest.map((entry) => `- ${entry.name}${entry.description ? `: ${entry.description}` : ''}`),
        '',
        'Check this list before writing — update an existing file rather than creating a duplicate.',
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
    ...(existing.length === 0 ? [''] : [existing, '']),
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
 * Validate and normalize one extraction reply. Strict: any invalid memory
 * abandons the whole reply so a run never writes a partial batch.
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
    if (memory === undefined) return undefined
    canonical.set(memory.name, memory)
  }
  const maxFacts = Number.isSafeInteger(options.maxFacts) && options.maxFacts > 0
    ? options.maxFacts
    : MAX_FACTS_PER_RUN
  const memories = [...canonical.values()].slice(0, maxFacts)
  const forget = [...new Set(rawForget.filter((name) => isValidMemoryName(name)))]
  return { memories, forget }
}

/**
 * Normalize one extraction memory entry.
 * @param {unknown} raw
 * @returns {object | undefined}
 */
function normalizeExtractedMemory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const title = typeof raw.title === 'string' ? raw.title.replace(/[\r\n]+/g, ' ').trim() : ''
  const name = isValidMemoryName(raw.name) ? raw.name : slugifyTitle(raw.name ?? title)
  if (name === undefined) return undefined
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
