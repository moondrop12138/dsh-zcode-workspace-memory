/**
 * Host half of `dsh-workspace-memory`.
 *
 * Responsibilities, in the order the plugin exercises them (contract:
 * `INTERFACES.md`; pure logic and frozen prompts: `lib/memory-core.js`):
 *
 *   1. **Injected section** — one root-context `systemPrompt.section` whose text
 *      provider reads a per-Agent cache. The cache is filled in `agent/created`
 *      (and for Agents that were already alive when this plugin loaded), so the
 *      section appears in the very next assembly without a restart.
 *   2. **Observation** — root `session/event` + `tools/result` listeners buffer
 *      each turn (user prose, assistant text, whether the turn wrote into the
 *      memory root) and trigger extraction after a `turn/end` with
 *      `reason.kind === 'completed'`.
 *   3. **Extraction** — one fire-and-forget `ctx.llm.stream` call per settled
 *      turn (one running slot + one latest-pending slot per Agent), parsed as
 *      strict JSON and applied to disk through `ctx.fs` under the session's own
 *      sandbox policy. Failures are debug-logged only: no retry, no partial
 *      batch.
 *   4. **RPC** — `POST /api/dsh-workspace-memory/call` serving the read-only
 *      `catalog` and `read` endpoints the Client page uses.
 *
 * Deliberate deviations from ZCode are recorded in `README.md`; the two that
 * matter here are that the memory root lives inside the workspace and that
 * extraction is a single JSON reply instead of a five-turn restricted agent.
 *
 * Everything is defensive: `connection` and every other service is resolved
 * lazily, the plugin owns only optional integrations, and no background failure
 * is allowed to escape into the Host.
 *
 * @module dsh-workspace-memory/host
 */

import { appendFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DEFAULT_MAX_INDEX_CHARS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  MAX_FACTS_PER_RUN,
  MAX_TRANSCRIPT_CHARS,
  MEMORY_SECTION_ORDER,
  buildExtractionPrompt,
  buildManifest,
  buildTranscript,
  evaluateExtraction,
  factFileName,
  indexPath,
  isIndexFile,
  isValidMemoryName,
  memoryRoot,
  memoryRulesText,
  parseExtractionResponse,
  parseFactFileName,
  parseFactFrontmatter,
  pickRoute,
  removePointer,
  renderFactFile,
  renderMemorySection,
  safeMemoryPath,
  upsertPointer,
} from './memory-core.js'

/**
 * Schemastery is only needed for `Config`. The bare import resolves when the
 * bundle sits on a real path; a locally installed bundle is a **symlink** into
 * the profile (`dsh-token-usage` is laid out that way), and Node resolves the
 * symlink to the authoring directory, whose `node_modules` chain does not hold
 * the harness packages. The fallback walks the profile and runtime directories
 * for the real package entry so `Config` (and therefore the user-editable
 * switches) survives that layout. Failure is not fatal: `Config` degrades to
 * "no user-editable switches" and the defaults still apply through `cfg()`.
 */
const SCHEMA_PACKAGE = '@deepseek-ai/schemastery'
const SCHEMA_ENTRIES = ['lib/index.mjs', 'lib/index.cjs', 'index.mjs', 'index.cjs']
/** How many ancestors of each anchor directory to probe. */
const SCHEMA_ANCHOR_DEPTH = 6

/**
 * Whether one candidate is the schemastery build this plugin needs. Two
 * different copies can sit on the search path (the profile's build carries the
 * `volatile()` extension; an older one does not), so the check exercises the
 * exact chain `Config` uses instead of trusting the module identity.
 */
function isSchemaModule(value) {
  if (value === null || value === undefined) return false
  const type = typeof value
  if (type !== 'object' && type !== 'function') return false
  if (typeof value.object !== 'function' || typeof value.boolean !== 'function') return false
  try {
    const probe = value.boolean()
    return !!probe && typeof probe.default === 'function' && typeof probe.volatile === 'function'
  } catch (_ignored) {
    return false
  }
}

/** Anchor directories from which `node_modules/...` may be reachable. */
function schemaAnchorDirectories() {
  const anchors = new Set()
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) anchors.add(value)
  }
  push(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home.length > 0) {
    push(join(home, 'profiles'))
    if (typeof profile === 'string' && profile.length > 0) push(join(home, 'profiles', profile))
  }
  try {
    push(dirname(fileURLToPath(import.meta.url)))
  } catch (_ignored) {
    // import.meta.url is always a file URL under the loader; ignore otherwise.
  }
  if (typeof process.argv?.[1] === 'string') push(dirname(process.argv[1]))
  if (typeof process.execPath === 'string') push(dirname(process.execPath))
  return [...anchors]
}

/** Absolute candidate entry files for the schema package. */
function schemaEntryCandidates() {
  const candidates = []
  for (const anchor of schemaAnchorDirectories()) {
    let current = anchor
    for (let depth = 0; depth < SCHEMA_ANCHOR_DEPTH; depth += 1) {
      for (const entry of SCHEMA_ENTRIES) {
        candidates.push(join(current, 'node_modules', SCHEMA_PACKAGE, entry))
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return candidates
}

async function loadSchemaModule() {
  const attempted = new Set()
  const attempt = async (specifier) => {
    if (typeof specifier !== 'string' || specifier.length === 0 || attempted.has(specifier)) return undefined
    attempted.add(specifier)
    try {
      const module = await import(specifier)
      const resolved = module.default ?? module
      return isSchemaModule(resolved) ? resolved : undefined
    } catch (_ignored) {
      return undefined
    }
  }
  const bare = await attempt(SCHEMA_PACKAGE)
  if (bare !== undefined) return bare
  for (const candidate of schemaEntryCandidates()) {
    const loaded = await attempt(pathToFileURL(candidate).href)
    if (loaded !== undefined) return loaded
  }
  return undefined
}

const schemaModule = await loadSchemaModule()

export const name = 'dsh-workspace-memory'

/**
 * `systemPrompt` is the one hard dependency: this plugin's core purpose is the
 * injected section, and declaring it makes the Loader apply the plugin only once
 * the registry exists (and re-apply if it is replaced) instead of silently
 * skipping the section when the row happens to load first. Every other service
 * stays optional and is resolved defensively through `safeService`.
 */
export const inject = ['systemPrompt']

/**
 * User-editable switches. `.volatile()` fields arrive in `apply` as references
 * with `get()`, so `cfg()` re-reads the live value on every use and a settings
 * change applies without a reload. Only `systemPrompt` is declared in `inject`:
 * `connection` and the rest stay optional, so a profile without a web surface
 * still gets the memory section and extraction.
 */
export const Config = schemaModule === undefined
  ? undefined
  : schemaModule.object({
      enabled: schemaModule.boolean().default(true).volatile(),
      autoExtract: schemaModule.boolean().default(true).volatile(),
      maxIndexChars: schemaModule.number().default(DEFAULT_MAX_INDEX_CHARS).volatile(),
      debugLog: schemaModule.boolean().default(false).volatile(),
    })

/** Plugin identity used by log lines and RPC error messages. */
const PKG = 'dsh-workspace-memory'

/** RPC route the Client half posts to. */
const RPC_ENDPOINT = 'dsh-workspace-memory/call'
const RPC_PATH = '/api/' + RPC_ENDPOINT

/** Prompt section name (unique per registry layer). */
const SECTION_NAME = 'workspace-memory:instructions'

/** Best-effort Host journal in the OS temp directory. */
const LOG_PATH = join(tmpdir(), 'workspace-memory-host.log')

/** Tail cap for one file served over RPC (contract: 256 KiB). */
const READ_MAX_BYTES = 262144

/** Deadline for the awaited per-Agent index read at creation time. */
const INIT_READ_TIMEOUT_MS = 5000

/** Tool names whose arguments can mention the memory root (write/edit family). */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/* --------------------------------------------------------------------- log */

/** Append one line to the Host journal; logging never affects the plugin. */
function log(message) {
  try {
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + message + '\n')
  } catch (_ignored) {
    // Best effort only.
  }
}

/** Human-readable text for any thrown value. */
function errorText(error) {
  if (error && typeof error.stack === 'string') return error.stack
  if (error && typeof error.message === 'string') return error.message
  return String(error)
}

/** Debug line, gated by the `debugLog` switch. */
function debug(plugin, message) {
  try {
    if (!isTrue(cfg(plugin, 'debugLog', false))) return
    log('debug: ' + message)
  } catch (_ignored) {
    // Best effort only.
  }
}

/* ------------------------------------------------------------------ helpers */

/** Tolerant service lookup: `ctx.get(name)`, then the property, never throws. */
function safeService(target, key) {
  if (target === null || target === undefined) return undefined
  try {
    if (typeof target.get === 'function') {
      const value = target.get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch (_ignored) {
    // Fall through to the property read.
  }
  try {
    const value = target[key]
    return value === undefined ? undefined : value
  } catch (_ignored) {
    return undefined
  }
}

/**
 * Read one Config field, tolerating a volatile reference (`{ get() }`) and a
 * plain value, and falling back when the field is absent or unreadable.
 * @param {object | undefined} plugin plugin state
 * @param {string} field field name
 * @param {unknown} fallback value used when the field is missing
 * @returns {unknown}
 */
function cfg(plugin, field, fallback) {
  const raw = plugin?.config === null || plugin?.config === undefined ? undefined : plugin.config[field]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'function') {
    try {
      const value = raw()
      return value === undefined ? fallback : value
    } catch (_ignored) {
      return fallback
    }
  }
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const value = raw.get()
      return value === undefined ? fallback : value
    } catch (_ignored) {
      return fallback
    }
  }
  return raw
}

/** Coerce one Config value to a boolean. */
function isTrue(value) {
  return value === true
}

/** Live `enabled` switch. */
function isEnabled(plugin) {
  return cfg(plugin, 'enabled', true) !== false
}

/** Live `autoExtract` switch. */
function isAutoExtract(plugin) {
  return cfg(plugin, 'autoExtract', true) !== false
}

/** Live `maxIndexChars` switch. */
function maxIndexChars(plugin) {
  const value = cfg(plugin, 'maxIndexChars', DEFAULT_MAX_INDEX_CHARS)
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_INDEX_CHARS
}

/** Session identifier, tolerating wrapper shapes. */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return undefined
  if (typeof session.id === 'string' && session.id !== '') return session.id
  const header = session.header
  if (header && typeof header === 'object' && typeof header.id === 'string' && header.id !== '') return header.id
  return undefined
}

/** The immutable workspace root of one session (ZCode's stable workspaceRoot). */
function workspaceRootOf(session) {
  const cwd = session && session.header ? session.header.cwd : undefined
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

/**
 * Whether one session gets workspace memory. ZCode's Main-equivalent rule:
 * subagent / workflow-child sessions are excluded.
 */
function isEligibleSession(session) {
  if (!session || typeof session !== 'object') return false
  const header = session.header
  if (!header || typeof header !== 'object') return true
  return header.origin !== 'subagent'
}

/** Path key used for set membership and case-insensitive argument matching. */
function normalizePathKey(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** Display title for one workspace path. */
function displayTitle(path, candidate) {
  if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  const parts = String(path === undefined || path === null ? '' : path).split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? String(path ?? '') : parts[parts.length - 1]
}

/**
 * Tail of a string capped at a byte budget (contract: keep the newest content).
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
function tailWithinBytes(text, maxBytes) {
  const source = typeof text === 'string' ? text : ''
  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes <= maxBytes) return { text: source, truncated: false }
  const ratio = maxBytes / bytes
  const keep = Math.max(0, Math.floor(source.length * ratio) - 1)
  return { text: source.slice(source.length - keep), truncated: true }
}

/** Combine several abort signals into one, with an explicit disposer. */
function createLinkedSignal(signals) {
  const live = (Array.isArray(signals) ? signals : []).filter(
    (signal) => signal && typeof signal.aborted === 'boolean',
  )
  if (live.length === 0) return { signal: undefined, dispose: () => {} }
  if (live.length === 1) return { signal: live[0], dispose: () => {} }
  if (typeof AbortSignal.any === 'function') {
    try {
      return { signal: AbortSignal.any(live), dispose: () => {} }
    } catch (_ignored) {
      // Fall through to the manual composite.
    }
  }
  const controller = new AbortController()
  const handlers = []
  for (const source of live) {
    if (source.aborted) {
      controller.abort()
      break
    }
    const handler = () => {
      try {
        controller.abort(source.reason)
      } catch (_ignored) {
        controller.abort()
      }
    }
    handlers.push([source, handler])
    source.addEventListener('abort', handler, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [source, handler] of handlers) {
        try {
          source.removeEventListener('abort', handler)
        } catch (_ignored) {
          // The source is gone; nothing to remove.
        }
      }
    },
  }
}

/* ------------------------------------------------------------- turn buffer */

/** One empty turn buffer. */
function newTurnBuffer() {
  return { userBlocks: [], messages: [], directWrite: false, messageCount: 0 }
}

/** Collect the text of one content block array. */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.length === 0) continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Record one durable `user/message` event in the turn buffer. Only genuinely
 * user-authored messages count as prose or enter the transcript: injected
 * runtime context and plugin baselines carry a different `source.kind`.
 */
function applyUserMessage(buffer, data) {
  if (!buffer || !data || typeof data !== 'object') return buffer
  const source = data.source
  const kind = source && typeof source === 'object' ? source.kind : undefined
  if (kind !== 'user') return buffer
  const text = blocksToText(data.content)
  if (text.length === 0) return buffer
  buffer.userBlocks.push(text)
  buffer.messages.push({ role: 'user', text })
  buffer.messageCount += 1
  return buffer
}

/** Record one durable `assistant/message` event (text blocks only). */
function applyAssistantMessage(buffer, data) {
  if (!buffer || !data || typeof data !== 'object') return buffer
  const message = data.message
  if (!message || typeof message !== 'object') return buffer
  const text = blocksToText(message.content)
  if (text.length === 0) return buffer
  buffer.messages.push({ role: 'assistant', text })
  buffer.messageCount += 1
  return buffer
}

/** Collect the string leaves of a tool argument value (bounded walk). */
function collectArgumentStrings(value, out, depth) {
  if (out.length >= 64 || depth > 6) return
  if (typeof value === 'string') {
    out.push(value)
    // A JSON-serialized argument carries doubled backslashes on Windows.
    if (value.includes('\\\\')) out.push(value.replace(/\\\\/g, '\\'))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentStrings(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectArgumentStrings(item, out, depth + 1)
  }
}

/** Mark a turn whose tool arguments mentioned the memory root. */
function applyToolResult(buffer, root, exec) {
  if (!buffer || !exec || typeof exec !== 'object') return buffer
  const toolName = typeof exec.name === 'string' ? exec.name : ''
  if (!WRITE_TOOLS.has(toolName)) return buffer
  const key = normalizePathKey(root)
  if (key.length === 0) return buffer
  const candidates = []
  collectArgumentStrings(exec.arguments, candidates, 0)
  if (candidates.some((value) => normalizePathKey(value).includes(key))) buffer.directWrite = true
  return buffer
}

/** Whether one `turn/end` event closed a successful turn. */
function isCompletedTurn(event) {
  if (!event || typeof event !== 'object' || event.type !== 'turn/end') return false
  const reason = event.data && typeof event.data === 'object' ? event.data.reason : undefined
  return !!reason && typeof reason === 'object' && reason.kind === 'completed'
}

/* -------------------------------------------------------------------- plan */

/**
 * Pure plan for applying one parsed extraction reply: which fact files to
 * write, which to delete, and the resulting index text. The Host performs the
 * I/O; this function is the test seam.
 * @param {{
 *   parsed: { memories: object[], forget: string[] },
 *   files?: Record<string, string>,
 *   indexText?: string,
 *   sessionId?: string
 * }} input
 * @returns {{
 *   writes: Array<{ fileName: string, content: string, title: string, hook: string }>,
 *   deletes: string[],
 *   indexText: string,
 *   indexChanged: boolean
 * } | undefined}
 */
function planExtractionWrites(input) {
  const parsed = input && typeof input === 'object' ? input.parsed : undefined
  if (!parsed || typeof parsed !== 'object') return undefined
  const memories = Array.isArray(parsed.memories) ? parsed.memories : []
  const forget = Array.isArray(parsed.forget) ? parsed.forget : []
  const files = input.files && typeof input.files === 'object' ? input.files : {}
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  const before = typeof input.indexText === 'string' ? input.indexText : ''
  let indexText = before

  const writes = []
  for (const memory of memories) {
    if (!memory || typeof memory !== 'object') continue
    if (!isValidMemoryName(memory.name)) continue
    const fileName = factFileName(memory.name)
    const existing = typeof files[fileName] === 'string' ? files[fileName] : ''
    const frontmatter = existing.length === 0 ? undefined : parseFactFrontmatter(existing)
    const origin = typeof frontmatter?.originSessionId === 'string' && frontmatter.originSessionId !== ''
      ? frontmatter.originSessionId
      : sessionId
    const content = renderFactFile({ ...memory, originSessionId: origin })
    if (content.length === 0) continue
    writes.push({
      fileName,
      content,
      title: typeof memory.title === 'string' ? memory.title : '',
      hook: typeof memory.description === 'string' ? memory.description : '',
    })
  }

  const deletes = [...new Set(forget.filter((entry) => isValidMemoryName(entry)))].map(factFileName)
  for (const write of writes) {
    indexText = upsertPointer(indexText, { title: write.title, file: write.fileName, hook: write.hook })
  }
  for (const fileName of deletes) indexText = removePointer(indexText, fileName)
  return { writes, deletes, indexText, indexChanged: indexText !== before }
}

/* ------------------------------------------------------------ file helpers */

/** Resolve one path through `ctx.fs`, tolerating a missing provider or target. */
async function resolveTarget(fs, path, signal) {
  if (!fs || typeof fs.resolve !== 'function') return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  try {
    const target = signal === undefined ? await fs.resolve(path) : await fs.resolve(path, { signal })
    return target === undefined ? undefined : target
  } catch (_error) {
    return undefined
  }
}

/** Read one file's text through `ctx.fs`; undefined when absent or unreadable. */
async function readFileText(fs, path, signal) {
  const target = await resolveTarget(fs, path, signal)
  if (target === undefined) return undefined
  if (typeof fs.stat === 'function') {
    try {
      const info = signal === undefined ? await fs.stat(target) : await fs.stat(target, signal)
      if (!info || info.type !== 'file') return undefined
    } catch (_error) {
      return undefined
    }
  }
  if (typeof fs.readText !== 'function') return undefined
  try {
    const text = signal === undefined ? await fs.readText(target) : await fs.readText(target, signal)
    return typeof text === 'string' ? text : undefined
  } catch (_error) {
    return undefined
  }
}

/** Read one memory file by name; undefined when absent or unreadable. */
async function readMemoryFileText(fs, root, fileName, signal) {
  const path = safeMemoryPath(root, fileName)
  if (path === undefined) return undefined
  return readFileText(fs, path, signal)
}

/** Raw index text of one workspace ('' when missing or unreadable). */
async function readIndexRaw(plugin, record, signal) {
  const fs = safeService(plugin.ctx, 'fs')
  const text = await readMemoryFileText(fs, record.root, 'MEMORY.md', signal)
  return text === undefined ? '' : text
}

/* --------------------------------------------------------------- lifecycle */

/**
 * Load one session's memory state into the section cache and start observing
 * its turns. Called from `agent/created` and, at plugin load, for every Agent
 * that was already alive.
 */
async function initializeAgent(plugin, agent) {
  try {
    if (!agent || plugin.disposed || plugin.initialized.has(agent)) return
    plugin.initialized.add(agent)

    const session = agent.session
    if (!isEligibleSession(session)) return
    if (!isEnabled(plugin)) return

    const root = workspaceRootOf(session)
    const record = {
      agent,
      session,
      sessionId: sessionIdOf(session),
      root,
      memoryRoot: memoryRoot(root),
      rootKey: normalizePathKey(memoryRoot(root)),
      abort: new AbortController(),
      running: false,
      pending: null,
      buffer: newTurnBuffer(),
    }
    plugin.byAgent.set(agent, record)
    if (record.sessionId !== undefined) plugin.bySession.set(record.sessionId, record)

    await ensureDirectory(plugin, record)

    // The awaited serial creation listener must never stall a session on a slow
    // filesystem provider, so the initial index read is bounded.
    const readSignal = typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(INIT_READ_TIMEOUT_MS)
      : undefined
    const rawIndex = await readIndexRaw(plugin, record, readSignal)
    const rendered = renderMemorySection({
      root: record.memoryRoot,
      rawIndex,
      maxChars: maxIndexChars(plugin),
    })
    plugin.sectionCache.set(agent, rendered.text)
    debug(plugin, `section ready for ${record.sessionId ?? '(unknown)'} (index lines: ${rendered.indexLineCount})`)
  } catch (error) {
    log('initializeAgent failed: ' + errorText(error))
  }
}

/** Best-effort directory creation, never under a read-only policy. */
async function ensureDirectory(plugin, record) {
  const gate = resolvePolicy(plugin, record)
  if (gate === undefined || !gate.writable) {
    debug(plugin, 'memory directory not created (read-only session or no sandbox policy)')
    return
  }
  try {
    await mkdir(record.memoryRoot, { recursive: true })
  } catch (error) {
    debug(plugin, 'mkdir failed: ' + errorText(error))
  }
}

/** Resolve the session's sandbox policy; `undefined` when unavailable. */
function resolvePolicy(plugin, record) {
  const sandboxPolicy = safeService(plugin.ctx, 'sandboxPolicy')
  if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') return undefined
  try {
    const policy = sandboxPolicy.resolve({ session: record.session })
    if (!policy || typeof policy !== 'object') return undefined
    return { policy, writable: policy.mode !== 'read-only' }
  } catch (error) {
    debug(plugin, 'sandbox policy resolution failed: ' + errorText(error))
    return undefined
  }
}

/** Release one Agent's observation state. */
function disposeRecord(record) {
  if (!record || record.disposed) return
  record.disposed = true
  try {
    record.abort.abort()
  } catch (_ignored) {
    // Already aborted.
  }
}

/* ----------------------------------------------------------------- events */

/** `session/event` on the root context, routed to the owning Agent record. */
function onSessionEvent(plugin, session, event) {
  try {
    if (plugin.disposed || !event || typeof event.type !== 'string') return
    const sessionId = sessionIdOf(session)
    const record = sessionId === undefined ? undefined : plugin.bySession.get(sessionId)
    if (!record) return

    switch (event.type) {
      case 'turn/start':
        record.buffer = newTurnBuffer()
        return
      case 'user/message':
        applyUserMessage(record.buffer, event.data)
        return
      case 'assistant/message':
        applyAssistantMessage(record.buffer, event.data)
        return
      case 'turn/end':
        if (!isCompletedTurn(event)) return
        onCompletedTurn(plugin, record)
        return
      default:
        return
    }
  } catch (error) {
    debug(plugin, 'session/event handler failed: ' + errorText(error))
  }
}

/** `tools/result` on the root context: detect memory-root writes per turn. */
function onToolResult(plugin, exec) {
  try {
    if (plugin.disposed || !exec || typeof exec !== 'object') return
    const agent = exec.agent
    const record = agent === undefined ? undefined : plugin.byAgent.get(agent)
    if (!record) return
    applyToolResult(record.buffer, record.rootKey, exec)
  } catch (error) {
    debug(plugin, 'tools/result handler failed: ' + errorText(error))
  }
}

/** A completed turn: decide, buffer, and schedule one extraction. */
function onCompletedTurn(plugin, record) {
  const buffer = record.buffer
  record.buffer = newTurnBuffer()
  if (!isEnabled(plugin) || !isAutoExtract(plugin)) return

  const decision = evaluateExtraction({ userBlocks: buffer.userBlocks, directWrite: buffer.directWrite })
  if (!decision.run) {
    log(`extraction skipped for ${record.sessionId ?? '(unknown session)'} (${decision.reason ?? 'unknown'})`)
    return
  }
  const gate = resolvePolicy(plugin, record)
  if (gate === undefined || !gate.writable) {
    log(`extraction skipped for ${record.sessionId ?? '(unknown session)'} (read-only session or no sandbox policy)`)
    return
  }
  scheduleExtraction(plugin, record, {
    messages: buffer.messages,
    messageCount: buffer.messageCount,
    policy: gate.policy,
  })
}

/* -------------------------------------------------------------- extraction */

/** One running slot plus one latest-pending slot per Agent (ZCode scheduler). */
function scheduleExtraction(plugin, record, snapshot) {
  if (record.running) {
    record.pending = snapshot
    return
  }
  void runExtraction(plugin, record, snapshot)
}

/** Drain the running/pending slots until nothing is left or aborted. */
async function runExtraction(plugin, record, first) {
  record.running = true
  let snapshot = first
  try {
    while (snapshot && !plugin.disposed && !record.abort.signal.aborted) {
      try {
        await extractOnce(plugin, record, snapshot)
      } catch (error) {
        debug(plugin, 'extraction failed: ' + errorText(error))
      }
      const next = record.pending
      record.pending = null
      snapshot = next
    }
  } catch (error) {
    log('extraction loop failed: ' + errorText(error))
  } finally {
    record.running = false
    record.pending = null
  }
}

/** One extraction attempt: route, prompt, model call, parse, apply. */
async function extractOnce(plugin, record, snapshot) {
  const route = extractRoute(plugin, record)
  if (route === undefined) {
    log(`extraction skipped for ${record.sessionId ?? '(unknown session)'} (no provider/model route)`)
    return
  }
  const label = record.sessionId ?? '(unknown session)'
  const fs = safeService(plugin.ctx, 'fs')
  const manifest = await readManifest(plugin, fs, record)
  const prompt = buildExtractionPrompt({ messageCount: snapshot.messageCount, manifest })
  const transcript = buildTranscript(snapshot.messages, MAX_TRANSCRIPT_CHARS)
  const text = await callModel(plugin, record, route, `${prompt}\n${transcript.text}`)
  if (text === undefined) {
    // A background model call is a cost event: its failure is always journaled,
    // not only under debugLog.
    log(`extraction request failed for ${label} (${route.provider}/${route.model})`)
    return
  }
  const parsed = parseExtractionResponse(text, { maxFacts: MAX_FACTS_PER_RUN })
  if (parsed === undefined) {
    log(`extraction reply was not a valid plan for ${label}; nothing written`)
    return
  }
  const applied = await applyExtraction(plugin, record, parsed, snapshot.policy)
  // One line per settled extraction: this journal is the only trace of a
  // background request that never enters the session log.
  log(`extraction done for ${label}: memories=${parsed.memories.length} forget=${parsed.forget.length} applied=${String(applied)}`)
}

/** Route precedence: request context → request header → agent options → default. */
function extractRoute(plugin, record) {
  const session = record.session
  const agentDefaultModel = safeService(plugin.ctx, 'agentDefaultModel')
  const requestContext = callQuietly(() => (typeof session.requestContext === 'function' ? session.requestContext() : undefined))
  const requestHeader = callQuietly(() => (typeof session.requestHeader === 'function' ? session.requestHeader() : undefined))
  return pickRoute({
    requestContext,
    requestHeader,
    agentOptions: record.agent.options,
    defaultSelection: callQuietly(() => (
      agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
        ? agentDefaultModel.currentSelection()
        : undefined
    )),
  })
}

/** Call a reader that may throw (fake sessions, absent services). */
function callQuietly(reader) {
  try {
    return reader()
  } catch (_ignored) {
    return undefined
  }
}

/** Existing facts (name + description) for the extraction prompt. */
async function readManifest(plugin, fs, record) {
  if (!fs || typeof fs.listDir !== 'function') return []
  const rootTarget = await resolveTarget(fs, record.memoryRoot)
  if (rootTarget === undefined) return []
  let entries = []
  try {
    entries = await fs.listDir(rootTarget)
  } catch (_error) {
    return []
  }
  const files = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (parseFactFileName(entry.name) === undefined) continue
    if (files.length >= 50) break
    const content = await readMemoryFileText(fs, record.memoryRoot, entry.name)
    files.push({ fileName: entry.name, content: content === undefined ? '' : content })
  }
  return buildManifest(files, 50)
}

/** One model request; returns the reply text, or undefined on any failure. */
async function callModel(plugin, record, route, prompt) {
  const llm = safeService(plugin.ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    debug(plugin, 'extraction skipped (ctx.llm is unavailable)')
    return undefined
  }
  const linked = createLinkedSignal([plugin.controller.signal, record.abort.signal])
  try {
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    const options = {
      provider: route.provider,
      model: route.model,
      system: memoryRulesText(record.memoryRoot),
      messages,
      maxTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    }
    if (record.sessionId !== undefined) options.sessionId = record.sessionId
    if (linked.signal !== undefined) options.signal = linked.signal
    const collected = await collectStreamText(llm.stream(options))
    if (!collected.ok) {
      debug(plugin, `extraction stream did not finish cleanly (${collected.reason ?? 'unknown'}: ${collected.detail ?? ''})`)
      return undefined
    }
    return collected.text
  } catch (error) {
    debug(plugin, 'extraction request failed: ' + errorText(error))
    return undefined
  } finally {
    linked.dispose()
  }
}

/**
 * The minimal chunk collector this plugin needs: accumulate `text-delta` and
 * require a terminal `finish` with `reason.kind === 'stop'`. `BlockAssembler`
 * lives in a package a plain-JS profile bundle does not import.
 * @param {AsyncIterable<object>} stream chunk stream from `ctx.llm.stream`
 * @returns {Promise<{ ok: boolean, text: string, reason?: string, detail?: string }>}
 */
async function collectStreamText(stream) {
  let text = ''
  let finishKind = ''
  let detail = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason
      finishKind = reason && typeof reason.kind === 'string' ? reason.kind : ''
      detail = reason && reason.failure && typeof reason.failure.message === 'string' ? reason.failure.message : ''
    }
  }
  if (finishKind !== 'stop') {
    return { ok: false, text: '', reason: finishKind === '' ? 'no-finish' : finishKind, detail }
  }
  return { ok: true, text }
}

/** Write one parsed extraction plan through `ctx.fs` under the session policy. */
async function applyExtraction(plugin, record, parsed, policy) {
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function') return false

  const currentIndex = await readIndexRaw(plugin, record)
  const files = {}
  for (const memory of parsed.memories) {
    if (!memory || !isValidMemoryName(memory.name)) continue
    const fileName = factFileName(memory.name)
    if (Object.hasOwn(files, fileName)) continue
    const content = await readMemoryFileText(fs, record.memoryRoot, fileName)
    files[fileName] = content === undefined ? '' : content
  }

  const plan = planExtractionWrites({
    parsed,
    files,
    indexText: currentIndex,
    sessionId: record.sessionId ?? '',
  })
  if (plan === undefined) return false

  const linked = createLinkedSignal([plugin.controller.signal, record.abort.signal])
  let changed = false
  try {
    for (const write of plan.writes) {
      const path = safeMemoryPath(record.memoryRoot, write.fileName)
      const target = path === undefined ? undefined : await resolveTarget(fs, path)
      if (target === undefined) continue
      try {
        await fs.writeText(target, write.content, undefined, linked.signal, policy)
        changed = true
      } catch (error) {
        debug(plugin, `failed to write ${write.fileName}: ${errorText(error)}`)
        break
      }
    }
    for (const fileName of plan.deletes) {
      const path = safeMemoryPath(record.memoryRoot, fileName)
      if (path === undefined) continue
      try {
        await unlink(path)
        changed = true
      } catch (error) {
        if (!error || error.code !== 'ENOENT') debug(plugin, `failed to delete ${fileName}: ${errorText(error)}`)
      }
    }
    if (plan.indexChanged && changed) {
      const indexTarget = await resolveTarget(fs, indexPath(record.memoryRoot))
      if (indexTarget !== undefined) {
        try {
          await fs.writeText(indexTarget, plan.indexText, undefined, linked.signal, policy)
        } catch (error) {
          debug(plugin, 'failed to update MEMORY.md: ' + errorText(error))
        }
      }
    }
  } finally {
    linked.dispose()
  }
  return changed
}

/* -------------------------------------------------------------------- RPC */

/** One contracted failure result. */
function failure(code, message, details) {
  return {
    ok: false,
    error: {
      code: typeof code === 'string' && code !== '' ? code : 'error',
      message: typeof message === 'string' && message !== '' ? message : PKG + ' request failed',
      details: details !== null && typeof details === 'object' && !Array.isArray(details) ? details : {},
    },
  }
}

/** Force the two shapes the framework accepts. */
function normalizeResult(result) {
  if (result && typeof result === 'object' && result.ok === true) {
    if (result.value === undefined || result.value === null) {
      return failure('empty-result', PKG + ' produced no payload')
    }
    return { ok: true, value: result.value }
  }
  const rawError = result && typeof result === 'object' ? result.error : undefined
  const code = rawError && typeof rawError.code === 'string' && rawError.code !== '' ? rawError.code : 'error'
  const message = rawError && typeof rawError.message === 'string' && rawError.message !== ''
    ? rawError.message
    : code
  const details = rawError && rawError.details !== null && typeof rawError.details === 'object'
    && !Array.isArray(rawError.details)
    ? rawError.details
    : {}
  return { ok: false, error: { code, message, details } }
}

/** Decode one Fetch-carried RPC request; never throws. */
async function handleApiRequest(plugin, request) {
  let body = null
  try {
    body = await request.json()
  } catch (_ignored) {
    body = null
  }
  const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
  const invalid = !body || body.type !== 'client-request' || body.method !== RPC_ENDPOINT
    || !body.payload || typeof body.payload !== 'object'
  let result
  if (invalid) {
    result = failure('bad-request', 'invalid ' + PKG + ' request')
  } else if (plugin.disposed) {
    result = failure('not-ready', PKG + ' host half is not applied')
  } else {
    const endpoint = body.payload.endpoint
    const rawPayload = body.payload.payload
    const payload = rawPayload !== null && typeof rawPayload === 'object' ? rawPayload : {}
    try {
      result = await dispatch(plugin, endpoint, payload)
    } catch (error) {
      result = failure('error', errorText(error))
    }
  }
  const envelope = { type: 'server-response', rpcId, result: normalizeResult(result) }
  try {
    return Response.json(envelope)
  } catch (error) {
    log('failed to serialize RPC response: ' + errorText(error))
    const fallback = { type: 'server-response', rpcId: 'invalid-request', result: failure('error', 'unserializable response') }
    return new Response(JSON.stringify(fallback), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

/** Endpoint dispatch. */
async function dispatch(plugin, endpoint, payload) {
  if (endpoint === 'catalog') return { ok: true, value: await buildCatalog(plugin) }
  if (endpoint === 'read') return readMemoryFile(plugin, payload)
  return failure('unknown-endpoint', 'unknown ' + PKG + ' endpoint: ' + String(endpoint), { endpoint: String(endpoint) })
}

/** Every workspace that could carry memory: registry ∪ live session cwds. */
function collectWorkspaceCandidates(plugin) {
  const candidates = new Map()
  const registry = safeService(plugin.ctx, 'workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list() ?? []) {
        const path = workspace && typeof workspace.path === 'string' ? workspace.path : ''
        if (path.length === 0) continue
        candidates.set(normalizePathKey(path), { path, title: displayTitle(path, workspace.title) })
      }
    } catch (error) {
      log('workspaceRegistry.list failed: ' + errorText(error))
    }
  }
  const sessions = safeService(plugin.ctx, 'sessions')
  if (sessions && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list() ?? []) {
        const cwd = session && session.header ? session.header.cwd : undefined
        if (typeof cwd !== 'string' || cwd.length === 0) continue
        const key = normalizePathKey(cwd)
        if (candidates.has(key)) continue
        candidates.set(key, { path: cwd, title: displayTitle(cwd) })
      }
    } catch (error) {
      log('sessions.list failed: ' + errorText(error))
    }
  }
  return [...candidates.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Files of one workspace's memory directory. */
async function listMemoryFiles(plugin, fs, workspacePath) {
  const root = memoryRoot(workspacePath)
  const rootTarget = await resolveTarget(fs, root)
  if (rootTarget === undefined) return []
  if (typeof fs.listDir !== 'function') return []
  let entries = []
  try {
    entries = await fs.listDir(rootTarget)
  } catch (_error) {
    return []
  }
  const files = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (!isIndexFile(entry.name) && parseFactFileName(entry.name) === undefined) continue
    files.push({
      name: entry.name,
      kind: isIndexFile(entry.name) ? 'index' : 'fact',
      size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0,
      updatedAt: 0,
    })
  }
  const kindRank = (file) => (file.kind === 'index' ? 0 : 1)
  files.sort((a, b) => kindRank(a) - kindRank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return files
}

/** The `catalog` value. */
async function buildCatalog(plugin) {
  const config = {
    enabled: isEnabled(plugin),
    autoExtract: isAutoExtract(plugin),
  }
  if (!isEnabled(plugin)) return { config, workspaces: [] }
  const fs = safeService(plugin.ctx, 'fs')
  const workspaces = []
  if (fs) {
    for (const candidate of collectWorkspaceCandidates(plugin)) {
      const files = await listMemoryFiles(plugin, fs, candidate.path)
      if (files.length === 0) continue
      workspaces.push({
        path: candidate.path,
        title: candidate.title,
        memoryRoot: memoryRoot(candidate.path),
        files,
      })
    }
  }
  return { config, workspaces }
}

/** The `read` value, with name and containment validation. */
async function readMemoryFile(plugin, payload) {
  const requested = typeof payload.path === 'string' ? payload.path : ''
  const fileName = typeof payload.name === 'string' ? payload.name : ''
  if (requested.length === 0 || fileName.length === 0) {
    return failure('invalid-path', 'workspace path and file name are required')
  }
  if (!isIndexFile(fileName) && parseFactFileName(fileName) === undefined) {
    return failure('invalid-path', 'not a memory file name: ' + fileName)
  }
  const requestedKey = normalizePathKey(requested)
  let workspacePath
  for (const candidate of collectWorkspaceCandidates(plugin)) {
    if (normalizePathKey(candidate.path) === requestedKey) {
      workspacePath = candidate.path
      break
    }
  }
  if (workspacePath === undefined) return failure('invalid-path', 'unknown workspace')

  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.readText !== 'function') return failure('read-failed', 'filesystem is unavailable')

  const root = memoryRoot(workspacePath)
  const filePath = safeMemoryPath(root, fileName)
  if (filePath === undefined) return failure('invalid-path', 'not a memory file name: ' + fileName)

  const target = await resolveTarget(fs, filePath)
  if (target === undefined) return failure('read-failed', 'file not found: ' + fileName)
  const rootTarget = await resolveTarget(fs, root)
  if (rootTarget !== undefined && typeof fs.contains === 'function') {
    try {
      if (!fs.contains(rootTarget, target)) return failure('invalid-path', 'target escapes the memory root')
    } catch (_error) {
      // Containment probing is best effort; the lexical check above already held.
    }
  }
  if (typeof fs.stat === 'function') {
    try {
      const info = await fs.stat(target)
      if (!info || info.type !== 'file') return failure('read-failed', 'not a file: ' + fileName)
    } catch (error) {
      return failure('read-failed', errorText(error))
    }
  }
  let content
  try {
    content = await fs.readText(target)
  } catch (error) {
    return failure('read-failed', errorText(error))
  }
  if (typeof content !== 'string') return failure('read-failed', 'file is not UTF-8 text')
  const capped = tailWithinBytes(content, READ_MAX_BYTES)
  return { ok: true, value: { path: filePath, content: capped.text, truncated: capped.truncated } }
}

/* -------------------------------------------------------------------- apply */

/**
 * Plugin entry. Never throws: a plugin failure must not take the Host down.
 * @param {object} ctx Cordis root context
 * @param {object} [config] Loader-provided Config (volatile fields are references)
 * @returns {void}
 */
export function apply(ctx, config) {
  try {
    return applyPlugin(ctx, config)
  } catch (error) {
    log('apply threw: ' + errorText(error))
    return undefined
  }
}

function applyPlugin(ctx, config) {
  if (schemaModule === undefined) {
    log('schema module unavailable; Config switches are not exposed (defaults still apply)')
  }
  const plugin = {
    ctx,
    config: config === null || config === undefined ? {} : config,
    sectionCache: new WeakMap(),
    byAgent: new WeakMap(),
    bySession: new Map(),
    initialized: new WeakSet(),
    disposers: [],
    controller: new AbortController(),
    disposed: false,
    rpcRegistered: false,
  }

  ctx.effect(() => {
    const disposers = []

    const systemPrompt = safeService(ctx, 'systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        const dispose = systemPrompt.section({
          name: SECTION_NAME,
          order: MEMORY_SECTION_ORDER,
          text: (context) => {
            try {
              const agent = context && context.agent
              if (!agent) return ''
              const text = plugin.sectionCache.get(agent)
              return typeof text === 'string' ? text : ''
            } catch (_ignored) {
              return ''
            }
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        log('systemPrompt.section registration failed: ' + errorText(error))
      }
    } else {
      log('ctx.systemPrompt is unavailable; the memory section will not be injected')
    }

    if (typeof ctx.on === 'function') {
      push(disposers, ctx.on('session/event', (session, event) => onSessionEvent(plugin, session, event)))
      push(disposers, ctx.on('tools/result', (exec) => onToolResult(plugin, exec)))
      push(disposers, ctx.on('agent/created', (payload) => {
        const agent = payload && payload.agent ? payload.agent : payload
        // Serial listener: awaiting keeps the very first prompt deterministic
        // (the cache is filled before any queued input is released).
        return initializeAgent(plugin, agent)
      }))
      push(disposers, ctx.on('agent/disposed', (payload) => {
        const agent = payload && payload.agent ? payload.agent : payload
        if (!agent) return
        const record = plugin.byAgent.get(agent)
        if (!record) return
        plugin.byAgent.delete(agent)
        if (record.sessionId !== undefined) plugin.bySession.delete(record.sessionId)
        disposeRecord(record)
      }))
    } else {
      log('ctx.on is unavailable; workspace memory cannot observe turns')
    }

    registerRpc(plugin)

    const agents = safeService(ctx, 'agents')
    if (agents && typeof agents.list === 'function') {
      try {
        for (const agent of agents.list() ?? []) void initializeAgent(plugin, agent)
      } catch (error) {
        log('agents.list failed: ' + errorText(error))
      }
    }

    return () => {
      plugin.disposed = true
      try {
        plugin.controller.abort()
      } catch (_ignored) {
        // Already aborted.
      }
      for (const record of plugin.bySession.values()) disposeRecord(record)
      plugin.bySession.clear()
      for (const dispose of plugin.disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (_ignored) {
          // A disposed registration is already gone.
        }
      }
      plugin.disposers.length = 0
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (_ignored) {
          // A disposed listener is already gone.
        }
      }
    }
  }, PKG + ': lifecycle')

  return undefined
}

/** Push a disposer when the registration returned one. */
function push(list, value) {
  if (typeof value === 'function') list.push(value)
}

/**
 * Register the RPC route when a `connection` service is available. `connection`
 * is intentionally not an `inject` dependency: a web-less profile must still get
 * the memory feature, and a missing route is only a debug fact.
 */
function registerRpc(plugin) {
  const register = (targetCtx) => {
    if (plugin.rpcRegistered) return true
    const connection = safeService(targetCtx, 'connection')
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') return false
    try {
      const dispose = connection.fetch.register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleApiRequest(plugin, request),
      })
      if (typeof dispose === 'function') plugin.disposers.push(dispose)
      plugin.rpcRegistered = true
      return true
    } catch (error) {
      log('RPC route registration failed: ' + errorText(error))
      return false
    }
  }

  if (register(plugin.ctx)) return
  if (typeof plugin.ctx.inject === 'function') {
    try {
      plugin.ctx.inject(['connection'], (serviceCtx) => {
        register(serviceCtx === undefined || serviceCtx === null ? plugin.ctx : serviceCtx)
      })
    } catch (error) {
      log('ctx.inject(connection) failed: ' + errorText(error))
    }
  }
  if (!plugin.rpcRegistered) debug(plugin, 'connection service is unavailable; the RPC route is not registered')
}

/**
 * Test seam: pure helpers and factories, with no mutable global state.
 * `test/extraction.test.mjs` and future Host tests drive these with plain
 * objects instead of a live Cordis context.
 */
export const __internals = {
  applyAssistantMessage,
  applyToolResult,
  applyUserMessage,
  blocksToText,
  cfg,
  collectArgumentStrings,
  collectStreamText,
  createLinkedSignal,
  displayTitle,
  failure,
  isCompletedTurn,
  isEligibleSession,
  isEnabled,
  loadSchemaModule,
  maxIndexChars,
  newTurnBuffer,
  normalizePathKey,
  normalizeResult,
  planExtractionWrites,
  schemaAnchorDirectories,
  schemaEntryCandidates,
  sessionIdOf,
  tailWithinBytes,
  workspaceRootOf,
}
