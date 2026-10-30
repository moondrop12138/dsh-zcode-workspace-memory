/**
 * The ZCode memory agent loop, ported to a host-driven tool loop.
 *
 * ZCode's extraction is a restricted five-turn agent: the model can Read, Grep
 * and Glob the memory directory, then Write/Edit/remove files inside it. This
 * plugin runs inside DSH, where a background model call may carry tool schemas
 * (`GenerateOptions.tools`) but the calling plugin executes the calls itself.
 * That is exactly what this module is: schemas the model sees, a journal the
 * host owns, and a bounded loop that feeds tool results back.
 *
 * Nothing here touches the filesystem. The caller injects `read(name)` and
 * `list()`, so every path decision still goes through the host's
 * `safeMemoryPath` guard, and every write is collected as an intent that the
 * host applies through its single guarded extraction pipeline. A five-turn
 * agent therefore cannot write outside the memory root even if it tries.
 *
 * @module
 */

import {
  MEMORY_TYPES,
  factFileName,
  isValidMemoryName,
  parseFactFrontmatter,
  renderFactFile,
} from './memory-core.js'

/** ZCode's per-extraction turn budget (`MEMORY_AGENT_MAX_TURNS`). */
export const MEMORY_AGENT_MAX_TURNS = 5

/** The exact reply that reports "nothing worth saving" to the caller. */
export const MEMORY_AGENT_NOOP_TEXT = 'Nothing to save.'

/** How many grep matches one tool result may carry. */
export const MEMORY_AGENT_GREP_LIMIT = 50

/** Tool names the extraction agent may call. */
export const MEMORY_AGENT_TOOL_NAMES = [
  'memory_read',
  'memory_list',
  'memory_grep',
  'memory_write',
  'memory_edit',
  'memory_delete',
]

/**
 * The model-facing tool set. `parameters` is one object-rooted JSON Schema per
 * tool, the shape `GenerateOptions.tools` expects.
 * @returns {Array<{ name: string, description: string, parameters: object }>}
 */
export function buildMemoryAgentTools() {
  return [
    {
      name: 'memory_read',
      description: 'Read one file from the workspace memory directory. Pass the memory name (kebab-case, no extension) or "MEMORY.md" for the index.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Memory name, e.g. "deploy-pipeline", or "MEMORY.md".' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_list',
      description: 'List every fact file in the workspace memory directory with its one-line description.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'memory_grep',
      description: 'Search every memory file and the index for a regular expression; returns matching "name:line" rows.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_write',
      description: 'Create or replace one memory file. Read an existing file first when the fact is an update; one fact per file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase kebab-case name, no type prefix.' },
          title: { type: 'string', description: 'Short human title for the index pointer.' },
          type: { type: 'string', enum: [...MEMORY_TYPES] },
          description: { type: 'string', description: 'One line: what this memory is about.' },
          body: { type: 'string', description: 'Markdown body. Follow the memory rules in the system prompt.' },
          why: { type: 'string', description: 'Optional: why this guidance matters (feedback memories).' },
          howToApply: { type: 'string', description: 'Optional: when and how it applies.' },
        },
        required: ['name', 'type', 'description', 'body'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_edit',
      description: 'Replace the body of an existing memory file while keeping its frontmatter fields.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Existing memory name.' },
          body: { type: 'string', description: 'New markdown body.' },
          description: { type: 'string', description: 'Optional: replace the one-line description.' },
        },
        required: ['name', 'body'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_delete',
      description: 'Forget one memory file. Use it when a stored memory is wrong or superseded.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Memory name to forget.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ]
}

/**
 * @param {unknown} name tool name
 * @returns {boolean}
 */
export function isMemoryTool(name) {
  return typeof name === 'string' && MEMORY_AGENT_TOOL_NAMES.includes(name)
}

/**
 * The body of a fact file: everything after its closing frontmatter fence.
 * @param {string} content
 * @returns {string}
 */
export function stripFactFrontmatter(content) {
  if (typeof content !== 'string') return ''
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return normalized
  const after = normalized.slice(end + 4)
  return after.startsWith('\n') ? after.slice(1) : after
}

/**
 * Create the in-memory memory directory the agent works against.
 *
 * Reads fall through to the injected `read`, writes and deletes are recorded
 * only — the host decides afterwards what reaches the disk.
 *
 * @param {{
 *   records?: Array<{ name: string, content: string }>,
 *   read?: (fileName: string) => Promise<string | undefined> | string | undefined,
 *   list?: () => Promise<string[]> | string[]
 * }} [source]
 * @returns {{
 *   read: (name: string) => Promise<string | undefined>,
 *   list: () => Promise<string[]>,
 *   index: () => Promise<string | undefined>,
 *   write: (fact: object) => Promise<{ ok: boolean, error?: string }>,
 *   edit: (name: string, body: string, description?: string) => Promise<{ ok: boolean, error?: string }>,
 *   remove: (name: string) => Promise<{ ok: boolean, error?: string }>,
 *   writes: () => Map<string, object>,
 *   deletes: () => string[],
 *   ops: () => Array<{ op: string, name: string }>
 * }}
 */
export function createMemoryJournal(source = {}) {
  const preloaded = new Map()
  for (const record of Array.isArray(source.records) ? source.records : []) {
    if (!record || typeof record !== 'object' || !isValidMemoryName(record.name)) continue
    preloaded.set(record.name, typeof record.content === 'string' ? record.content : '')
  }
  const injectedRead = typeof source.read === 'function' ? source.read : undefined
  const injectedList = typeof source.list === 'function' ? source.list : undefined

  const cache = new Map()
  const indexCache = { loaded: false, text: undefined }
  const written = new Map()
  const deleted = new Set()
  const opLog = []

  async function load(name) {
    if (written.has(name)) return written.get(name).content
    if (deleted.has(name)) return undefined
    if (cache.has(name)) return cache.get(name)
    if (preloaded.has(name)) {
      cache.set(name, preloaded.get(name))
      return preloaded.get(name)
    }
    if (injectedRead === undefined) {
      cache.set(name, undefined)
      return undefined
    }
    const content = await injectedRead(factFileName(name))
    cache.set(name, typeof content === 'string' ? content : undefined)
    return cache.get(name)
  }

  async function list() {
    const names = new Set(preloaded.keys())
    if (injectedList !== undefined) {
      for (const fileName of await injectedList()) {
        if (typeof fileName !== 'string') continue
        const name = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName
        if (name === 'MEMORY' || !isValidMemoryName(name)) continue
        names.add(name)
      }
    }
    for (const name of written.keys()) names.add(name)
    for (const name of deleted) names.delete(name)
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  return {
    read: load,
    list,
    async index() {
      if (indexCache.loaded) return indexCache.text
      indexCache.loaded = true
      if (injectedRead === undefined) return undefined
      const text = await injectedRead('MEMORY.md')
      indexCache.text = typeof text === 'string' ? text : undefined
      return indexCache.text
    },
    async write(fact) {
      if (fact === null || typeof fact !== 'object') return { ok: false, error: 'memory_write needs an object' }
      const name = fact.name
      if (!isValidMemoryName(name)) {
        return { ok: false, error: `invalid memory name "${String(name)}" (lowercase kebab-case required)` }
      }
      if (!MEMORY_TYPES.includes(fact.type)) {
        return { ok: false, error: `invalid type "${String(fact.type)}"; use one of ${MEMORY_TYPES.join(', ')}` }
      }
      const existing = await load(name)
      const front = existing === undefined ? undefined : parseFactFrontmatter(existing)
      const content = renderFactFile({
        name,
        title: fact.title,
        type: fact.type,
        description: fact.description,
        body: fact.body,
        why: fact.why,
        howToApply: fact.howToApply,
        createdAt: front?.createdAt,
      })
      if (content.length === 0) {
        return { ok: false, error: 'memory_write needs a type from the list, a non-empty description and a non-empty body' }
      }
      written.set(name, {
        content,
        title: typeof fact.title === 'string' ? fact.title : '',
        type: fact.type,
        description: typeof fact.description === 'string' ? fact.description : '',
        why: typeof fact.why === 'string' ? fact.why : undefined,
        howToApply: typeof fact.howToApply === 'string' ? fact.howToApply : undefined,
      })
      deleted.delete(name)
      opLog.push({ op: 'write', name })
      return { ok: true }
    },
    async edit(name, body, description) {
      if (!isValidMemoryName(name)) return { ok: false, error: `invalid memory name "${String(name)}"` }
      if (typeof body !== 'string' || body.trim().length === 0) {
        return { ok: false, error: 'memory_edit needs a non-empty body' }
      }
      const existing = await load(name)
      if (existing === undefined) return { ok: false, error: `no memory named "${name}"` }
      const front = parseFactFrontmatter(existing)
      const content = renderFactFile({
        name,
        type: front?.type,
        description: typeof description === 'string' && description.trim().length > 0
          ? description
          : front?.description,
        body,
        createdAt: front?.createdAt,
        originSessionId: front?.originSessionId,
      })
      if (content.length === 0) {
        return { ok: false, error: 'the existing file has no usable type or description; use memory_write instead' }
      }
      written.set(name, {
        content,
        title: typeof front?.description === 'string' ? front.description : '',
        type: front?.type,
        description: typeof description === 'string' && description.trim().length > 0
          ? description
          : front?.description,
      })
      opLog.push({ op: 'edit', name })
      return { ok: true }
    },
    async remove(name) {
      if (!isValidMemoryName(name)) return { ok: false, error: `invalid memory name "${String(name)}"` }
      const exists = written.has(name) || (!deleted.has(name) && (await load(name)) !== undefined)
      if (!exists) return { ok: false, error: `no memory named "${name}"` }
      written.delete(name)
      deleted.add(name)
      opLog.push({ op: 'delete', name })
      return { ok: true }
    },
    writes: () => new Map(written),
    deletes: () => [...deleted],
    ops: () => opLog.map((entry) => ({ ...entry })),
  }
}

/**
 * Parse the raw JSON string a model produced for one tool call.
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} }
  if (typeof raw === 'object') return { ok: true, value: raw }
  if (typeof raw !== 'string') return { ok: false, error: 'tool arguments must be a JSON object' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `invalid JSON arguments: ${message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'tool arguments must be a JSON object' }
  }
  return { ok: true, value: parsed }
}

/**
 * Execute one tool call against a journal.
 *
 * Every failure is a value, never a throw: a malformed call is reported back to
 * the model as a tool error so it can correct itself inside the turn budget.
 *
 * @param {ReturnType<typeof createMemoryJournal>} journal
 * @param {string} name
 * @param {unknown} rawArguments
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function runMemoryTool(journal, name, rawArguments) {
  if (!isMemoryTool(name)) return { ok: false, text: `unknown tool "${String(name)}"` }
  const args = parseToolArguments(rawArguments)
  if (!args.ok) return { ok: false, text: args.error }
  const value = args.value

  if (name === 'memory_read') {
    if (value.name === 'MEMORY.md' || value.name === 'MEMORY') {
      const index = await journal.index()
      return index === undefined
        ? { ok: false, text: 'MEMORY.md does not exist yet' }
        : { ok: true, text: index }
    }
    if (!isValidMemoryName(value.name)) return { ok: false, text: `invalid memory name "${String(value.name)}"` }
    const content = await journal.read(value.name)
    return content === undefined
      ? { ok: false, text: `no memory named "${value.name}"` }
      : { ok: true, text: content }
  }

  if (name === 'memory_list') {
    const names = await journal.list()
    if (names.length === 0) return { ok: true, text: 'the memory directory has no fact files yet' }
    const rows = []
    for (const entry of names) {
      const content = await journal.read(entry)
      const front = content === undefined ? undefined : parseFactFrontmatter(content)
      const description = typeof front?.description === 'string' ? front.description : ''
      rows.push(description.length === 0 ? `- ${entry}` : `- ${entry}: ${description}`)
    }
    return { ok: true, text: rows.join('\n') }
  }

  if (name === 'memory_grep') {
    if (typeof value.pattern !== 'string' || value.pattern.length === 0) {
      return { ok: false, text: 'memory_grep needs a non-empty pattern' }
    }
    let matcher
    try {
      matcher = new RegExp(value.pattern, 'i')
    } catch (_error) {
      matcher = new RegExp(value.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const rows = []
    for (const entry of await journal.list()) {
      const content = await journal.read(entry)
      if (content === undefined) continue
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index])) continue
        rows.push(`${entry}:${index + 1}: ${lines[index].trim().slice(0, 200)}`)
        if (rows.length >= MEMORY_AGENT_GREP_LIMIT) break
      }
      if (rows.length >= MEMORY_AGENT_GREP_LIMIT) break
    }
    return rows.length === 0
      ? { ok: true, text: 'no matches' }
      : { ok: true, text: rows.join('\n') }
  }

  if (name === 'memory_write') {
    const result = await journal.write(value)
    return result.ok
      ? { ok: true, text: `wrote memory "${value.name}"` }
      : { ok: false, text: result.error ?? 'memory_write failed' }
  }

  if (name === 'memory_edit') {
    const result = await journal.edit(value.name, value.body, value.description)
    return result.ok
      ? { ok: true, text: `updated memory "${value.name}"` }
      : { ok: false, text: result.error ?? 'memory_edit failed' }
  }

  const result = await journal.remove(value.name)
  return result.ok
    ? { ok: true, text: `forgot memory "${value.name}"` }
    : { ok: false, text: result.error ?? 'memory_delete failed' }
}

/**
 * Run the bounded tool loop.
 *
 * `callTurn` owns the model request: it receives the current messages and the
 * tool schemas, and resolves to the assembled turn. The loop stops when the
 * model answers without tool calls, and never exceeds `maxTurns` model calls.
 *
 * @param {{
 *   journal: ReturnType<typeof createMemoryJournal>,
 *   prompt: string,
 *   system?: string,
 *   provider?: string,
 *   model?: string,
 *   callTurn: (request: {
 *     messages: object[],
 *     tools: Array<object>,
 *     system?: string
 *   }) => Promise<{
 *     ok: boolean,
 *     text?: string,
 *     toolCalls?: Array<{ id: string, name: string, arguments: string }>,
 *     reason?: string,
 *     detail?: string
 *   }>,
 *   maxTurns?: number
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   turns: number,
 *   toolCalls: number,
 *   exhausted: boolean,
 *   text: string,
 *   reason?: string,
 *   detail?: string
 * }>}
 */
export async function runMemoryAgent(options) {
  const journal = options.journal
  const callTurn = options.callTurn
  const maxTurns = clampTurns(options.maxTurns)
  const tools = buildMemoryAgentTools()
  const messages = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }]
  let turns = 0
  let toolCalls = 0

  while (turns < maxTurns) {
    turns += 1
    const reply = await callTurn({
      messages,
      tools,
      system: options.system,
    })
    if (!reply || reply.ok === false) {
      return {
        ok: false,
        turns,
        toolCalls,
        exhausted: false,
        text: typeof reply?.text === 'string' ? reply.text : '',
        reason: reply?.reason,
        detail: reply?.detail,
      }
    }
    const text = typeof reply.text === 'string' ? reply.text : ''
    const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : []
    if (calls.length === 0) {
      return { ok: true, turns, toolCalls, exhausted: false, text }
    }
    messages.push({
      role: 'assistant',
      content: [
        ...(text.trim().length === 0 ? [] : [{ type: 'text', text }]),
        ...calls.map((call) => ({
          type: 'tool-call',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      ],
      source: {
        kind: 'model',
        provider: typeof options.provider === 'string' ? options.provider : '',
        model: typeof options.model === 'string' ? options.model : '',
      },
    })
    const results = []
    for (const call of calls) {
      toolCalls += 1
      const result = await runMemoryTool(journal, call.name, call.arguments)
      results.push({
        type: 'tool-result',
        toolCallId: call.id,
        content: [{ type: 'text', text: result.text }],
        isError: !result.ok,
      })
    }
    messages.push({
      role: 'user',
      content: results,
      source: { kind: 'tool', callId: calls[0].id },
    })
  }

  return { ok: true, turns, toolCalls, exhausted: true, text: '' }
}

/**
 * Clamp a configured turn budget into the supported range.
 * @param {unknown} value
 * @returns {number}
 */
export function clampTurns(value) {
  const turns = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : MEMORY_AGENT_MAX_TURNS
  if (turns < 1) return 1
  if (turns > 10) return 10
  return turns
}

/**
 * Turn what the agent actually did into the extraction plan the host applies.
 *
 * A memory written more than once keeps its last content; a memory that was
 * written and later deleted is forgotten; a delete of a file that never existed
 * never reaches the plan.
 *
 * @param {ReturnType<typeof createMemoryJournal>} journal
 * @returns {{ memories: Array<object>, forget: string[] }}
 */
export function journalToPlan(journal) {
  const memories = []
  for (const [name, entry] of journal.writes()) {
    const front = parseFactFrontmatter(entry.content) ?? {}
    const body = stripFactFrontmatter(entry.content).trim()
    if (!isValidMemoryName(name) || body.length === 0) continue
    memories.push({
      name,
      title: entry.title || front.description || name,
      type: front.type,
      description: front.description,
      body,
      why: entry.why,
      howToApply: entry.howToApply,
    })
  }
  const written = new Set(memories.map((memory) => memory.name))
  const forget = journal.deletes().filter((name) => !written.has(name))
  return { memories, forget }
}
