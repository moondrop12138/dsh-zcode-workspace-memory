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
 *      sandbox policy. A failed stage aborts the whole batch (facts first,
 *      then the index, then the deletes) and is journaled: no retry, no
 *      partial batch.
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

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MAX_INDEX_CHARS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  MAX_FACTS_PER_RUN,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_INDEX_LINES,
  MEMORY_SECTION_ORDER,
  MEMORY_TYPES,
  PROPOSALS_DIR,
  PROPOSAL_FACT_THRESHOLD,
  PROPOSAL_MARKER_VERSION,
  PROPOSAL_STALE_DAYS,
  INDEX_FILE,
  TRASH_KEEP,
  buildExtractionPrompt,
  buildConflictGuidance,
  buildManifest,
  buildTranscript,
  buildTranscriptSegments,
  deriveTitle,
  evaluateExtraction,
  evaluateIndexReplacement,
  factBodyText,
  factFileName,
  findContradictionCandidates,
  findNearDuplicateClusters,
  findNearDuplicateMatches,
  indexPath,
  isIndexFile,
  isProposalFileName,
  isValidMemoryName,
  memoryRoot,
  memoryRulesText,
  nowIsoTimestamp,
  parseExtractionResponse,
  parseFactFileName,
  parseFactFrontmatter,
  parseIndexPointers,
  parseProposalFile,
  pickRoute,
  proposalFileName,
  proposalsDirPath,
  queryTermsForRanking,
  removePointer,
  renderFactFile,
  renderMemorySection,
  renderPointer,
  renderProposalFile,
  safeMemoryPath,
  selectStaleFacts,
  selectTrashEvictions,
  timestampScalar,
  trashDirPath,
  upsertPointer,
} from './memory-core.js'
import {
  AGENT_MEMORY_INDEX,
  agentMemoryRulesText,
  resolveAgentKey,
  resolveAgentMemoryRoots,
  renderAgentMemoryBlock,
} from './agent-memory.js'
import {
  CURSOR_MAX_PENDING_CHARS,
  advanceCursor,
  emptyCursor,
  parseCursor,
  pendingWindow,
  serializeCursor,
} from './cursor.js'
import {
  DREAM_LOCK_FILE,
  acquireDreamLock,
  buildDreamPrompt,
  evaluateDreamTiming,
  parseDreamResponse,
  planDreamWrites,
  readDreamLastConsolidatedAt,
  releaseDreamLock,
  restoreDreamLockAfterFailure,
} from './dream.js'
import {
  RECALL_BUDGET_CHARS,
  buildRecallManifest,
  buildSelectorPrompt,
  filterRecallSelections,
  parseSelectorResponse,
  renderRecallBlock,
  retrievalBranch,
} from './recall.js'
import { rankRelatedMemories, renderRelatedMemories } from './related.js'
import {
  MEMORY_AGENT_MAX_TURNS,
  clampTurns,
  createMemoryJournal,
  journalToPlan,
  runMemoryAgent,
} from './memory-agent.js'

/**
 * Schemastery is only needed for `Config`, and the loader snapshots `Config`
 * synchronously when the plugin module registers, so the lookup must not
 * await. The bare require resolves when the bundle sits on a real path; a
 * locally installed bundle is a **symlink** into the profile, and Node
 * resolves the symlink to the authoring directory, whose `node_modules`
 * chain does not hold the harness packages. The fallback therefore walks the
 * profile and runtime directories for the real package entry. Failure is not
 * fatal: `Config` degrades to "no user-editable switches" and the defaults
 * still apply through `cfg()`.
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

/**
 * Synchronous schema discovery: the bare specifier first, then the walked
 * profile/runtime entries. The loader snapshots `Config` when the plugin
 * module registers, so this lookup must not await. `require` of the ESM
 * entries returns their namespace (Node ≥ 22), and both shapes pass through
 * `isSchemaModule` like the dynamic import did.
 */
function loadSchemaModule() {
  const attempted = new Set()
  const attempt = (specifier) => {
    if (typeof specifier !== 'string' || specifier.length === 0 || attempted.has(specifier)) return undefined
    attempted.add(specifier)
    try {
      const module = require(specifier)
      const resolved = module.default ?? module
      return isSchemaModule(resolved) ? resolved : undefined
    } catch (_ignored) {
      return undefined
    }
  }
  const bare = attempt(SCHEMA_PACKAGE)
  if (bare !== undefined) return bare
  for (const candidate of schemaEntryCandidates()) {
    const loaded = attempt(candidate)
    if (loaded !== undefined) return loaded
  }
  return undefined
}

const schemaModule = loadSchemaModule()

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
      extractMinIntervalMs: schemaModule.number().default(0).volatile(),
      extractDailyLimit: schemaModule.number().default(0).volatile(),
      extractProvider: schemaModule.string().default('').volatile(),
      extractModel: schemaModule.string().default('').volatile(),
      debugLog: schemaModule.boolean().default(false).volatile(),
      gitCommitEnabled: schemaModule.boolean().default(true).volatile(),
      extractionMode: schemaModule.string().default('agent').volatile(),
      agentMaxTurns: schemaModule.number().default(5).volatile(),
    })

/** Plugin identity used by log lines and RPC error messages. */
const PKG = 'dsh-workspace-memory'

/** RPC route the Client half posts to. */
const RPC_ENDPOINT = 'dsh-workspace-memory/call'
const RPC_PATH = '/api/' + RPC_ENDPOINT

/** Prompt section name (unique per registry layer). */
const SECTION_NAME = 'workspace-memory:instructions'

/** Best-effort Host journal in the OS temp directory. */
const DEFAULT_LOG_PATH = join(tmpdir(), 'workspace-memory-host.log')

/**
 * Path the journal appends to right now. A second Host process (or one test
 * file) can redirect it with `setJournalPath`, so two writers never interleave
 * in one temp file — rotation from one of them would otherwise rename lines
 * away from the other.
 */
let logPath = DEFAULT_LOG_PATH

/** Redirect the journal. The default path stays `DEFAULT_LOG_PATH`. */
function setJournalPath(next) {
  logPath = next
}

/** Current journal path. */
function journalPath() {
  return logPath
}

/** Size cap before the journal rotates; past it the current file becomes `.log.1`. */
const LOG_ROTATE_BYTES = 1048576

/** Previous generation of the journal; each rotation overwrites it (one kept). */
function rotatedJournalPath() {
  return logPath + '.1'
}

/** Tail cap for one file served over RPC (contract: 256 KiB). */
const READ_MAX_BYTES = 262144

/**
 * Activity entries kept per workspace memory root (roadmap C1). Append-only
 * in-memory ring buffer — restarts reset it, like the budgets.
 */
const ACTIVITY_KEEP = 50

/** Deadline for the awaited per-Agent index read at creation time. */
const INIT_READ_TIMEOUT_MS = 5000

/** Same-scale budget for the per-file reads inside one startup index repair. */
const REPAIR_READ_TIMEOUT_MS = 5000

/**
 * Same-scale budget for the per-file frontmatter reads inside one catalog
 * request (roadmap C4): type enrichment must never stall the panel RPC.
 */
const CATALOG_TYPE_TIMEOUT_MS = 5000

/**
 * Backoff waits between section-read retries after a failed init index read.
 * The first retry runs on the next section read; every further failure waits
 * one more step, and after the last step the Agent keeps its rules-only
 * section for the rest of its life.
 */
const RETRY_BACKOFF_MS = [1000, 4000, 16000]

/* --------------------------------------------------- export / import (D7) */

/** Directory-name prefix of one export snapshot: `workspace-memory-export-<iso>`. */
const EXPORT_DIR_PREFIX = 'workspace-memory-export-'

/** Manifest file at the root of every export snapshot. */
const EXPORT_MANIFEST_FILE = 'manifest.json'

/** Format tag the importer requires before it writes anything. */
const EXPORT_FORMAT = 'dsh-workspace-memory-export'

/** Manifest schema version understood by the importer. */
const EXPORT_VERSION = 1

/** Hard cap on the files one import/export may carry (a guard, not a quota). */
const EXPORT_MAX_FILES = 5000

/** Directory entries inside a memory root that are never facts. */
const NON_FACT_ENTRIES = new Set([PROPOSALS_DIR, 'trash'])

/** Wait for `git add`/`git commit` before giving up on one commit attempt. */
const GIT_TIMEOUT_MS = 15000

/** Tool names whose arguments can mention the memory root (write/edit family). */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Tool names whose arguments can name a memory file (read family, roadmap D2). */
const READ_TOOLS = new Set(['read', 'view', 'open'])

/**
 * Debounce window for the lazy `lastAccessedAt` flush (roadmap D2): hits
 * inside the window coalesce into one batched rewrite, so a burst of reads
 * costs one disk pass instead of one per tool result.
 */
const ACCESS_FLUSH_DELAY_MS = 3000

/* ------------------------------------------------------------------- locks */

/**
 * Per-workspace promise chains serializing MEMORY.md read-modify-write regions.
 * Keyed by `normalizePathKey(memoryRoot)`, because two sessions of one
 * workspace share the same index file but never the same scheduler slot.
 */
const workspaceLocks = new Map()

/**
 * Per-workspace extraction budget counters, keyed like `workspaceLocks` by
 * `normalizePathKey(memoryRoot)`: `{ day, count, lastAtMs }`. `day` is the
 * local-time date string the count belongs to; the entry resets when the day
 * rolls over. In-memory only — budgets restart on process restart.
 */
const workspaceBudgets = new Map()

/**
 * Per-workspace extraction activity entries (roadmap C1), keyed by
 * `normalizePathKey(memoryRoot)` and newest first: `{ at, workspace, wrote,
 * forgot, diffSummary }`. Appended only after a batch actually moved disk
 * state; capped at `ACTIVITY_KEEP` per workspace.
 */
const workspaceActivities = new Map()

/**
 * Pending fact-file read hits awaiting their batched `lastAccessedAt` rewrite
 * (roadmap D2), keyed by `normalizePathKey(memoryRoot)` → Map(fileName → true)
 * (the inner Map dedupes). Drained by one shared debounce timer; in-memory
 * only, so an unread hit simply keeps its previous timestamp.
 */
const pendingAccessHits = new Map()

/** Handle of the shared debounce timer draining `pendingAccessHits`. */
let accessFlushTimer = undefined

/**
 * Per-Agent section retry state, keyed by the Agent object: `{ attempts,
 * nextAtMs, pending }`. A failed init index read stores it so the (synchronous)
 * section provider can start one bounded retry per backoff step; the retry
 * itself is asynchronous, the next section read simply consumes the result.
 */
const sectionRetries = new WeakMap()

/* --------------------------------------------------------------------- log */

/**
 * Append one line to the Host journal; logging never affects the plugin. The
 * journal is size-capped: past `LOG_ROTATE_BYTES` the current file is renamed
 * to `rotatedJournalPath()` (replacing the previous generation) and a fresh
 * file starts. Sync fs calls because `log` must stay synchronous for its
 * callers.
 */
function log(message) {
  try {
    const stats = statSync(journalPath(), { throwIfNoEntry: false })
    if (stats !== undefined && stats.size > LOG_ROTATE_BYTES) {
      try {
        renameSync(journalPath(), rotatedJournalPath())
      } catch (_ignored) {
        // Rotation failing must not stop the append.
      }
    }
    appendFileSync(journalPath(), new Date().toISOString() + ' ' + message + '\n')
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

/**
 * Queue one task on a workspace's promise chain. The stored tail only ever
 * resolves (release never rejects), so a failed task cannot poison the chain,
 * and `release` deletes the key when the last holder leaves, keeping the map
 * free of idle entries.
 */
function acquireWorkspaceLock(key) {
  let settle
  const turn = new Promise((resolve) => {
    settle = resolve
  })
  const tail = workspaceLocks.get(key)
  workspaceLocks.set(key, turn)
  let released = false
  return {
    // Resolves when the previous holder releases; the first holder runs at once.
    promise: tail === undefined ? turn : tail,
    waited: tail !== undefined,
    release() {
      // Settle unconditionally so waiters drain even after a dispose cleared
      // the map; only the delete is skipped once the key is gone.
      if (released) return
      released = true
      settle()
      if (workspaceLocks.get(key) === turn) workspaceLocks.delete(key)
    },
  }
}

/** Run `task` while holding the workspace lock; the lock is always released. */
async function runWithWorkspaceLock(plugin, key, label, task) {
  const lock = acquireWorkspaceLock(key)
  try {
    if (lock.waited) {
      debug(plugin, 'workspace lock wait: ' + label)
      await lock.promise
    }
    return await task()
  } finally {
    lock.release()
  }
}

/**
 * Run `task` while holding one lock per memory root. Keys are deduped and
 * acquired in sorted order, so two callers asking for the same key set can
 * never interleave and deadlock.
 * @param {object} plugin plugin state
 * @param {string[]} keys `normalizePathKey` memory-root keys
 * @param {string} label debug label
 * @param {() => Promise<T>} task critical region
 * @returns {Promise<T>} the task's result
 */
async function runWithWorkspaceLocks(plugin, keys, label, task) {
  const ordered = [...new Set(keys)].sort()
  if (ordered.length === 1) return runWithWorkspaceLock(plugin, ordered[0], label, task)
  const locks = ordered.map((key) => acquireWorkspaceLock(key))
  try {
    for (let index = 0; index < locks.length; index += 1) {
      if (locks[index].waited) {
        debug(plugin, 'workspace lock wait: ' + label)
        await locks[index].promise
      }
    }
    return await task()
  } finally {
    for (const lock of locks) lock.release()
  }
}

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

/**
 * v0.4.0: which extraction engine runs. `'agent'` drives the five-turn
 * restricted-tool loop; `'json'` keeps the one-shot JSON request available for
 * troubleshooting and for profiles that want a single model call per turn.
 * @param {object} plugin plugin instance
 * @returns {'agent' | 'json'}
 */
function extractionModeOf(plugin) {
  return cfg(plugin, 'extractionMode', 'agent') === 'json' ? 'json' : 'agent'
}

/** Live turn budget for the agent engine, clamped by `clampTurns`. */
function agentMaxTurnsOf(plugin) {
  return clampTurns(cfg(plugin, 'agentMaxTurns', MEMORY_AGENT_MAX_TURNS))
}

/** Live `maxIndexChars` switch. */
function maxIndexChars(plugin) {
  const value = cfg(plugin, 'maxIndexChars', DEFAULT_MAX_INDEX_CHARS)
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_INDEX_CHARS
}

/**
 * Live extraction budget: minimum gap between two extractions of one workspace
 * (0 = no gap) and the daily cap (0 = unlimited). Nonsense values fall back to
 * the disabled defaults, matching `maxIndexChars`.
 */
function extractMinIntervalMs(plugin) {
  const value = cfg(plugin, 'extractMinIntervalMs', 0)
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Live daily cap on extractions per workspace; 0 keeps extraction unlimited. */
function extractDailyLimit(plugin) {
  const value = cfg(plugin, 'extractDailyLimit', 0)
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * The memory root of one session. Memory is per-workspace and independent: the
 * only root a session ever reads or writes is `<workspaceRoot>/.dsh/memory`.
 * @param {string} workspaceRoot session workspace root
 * @returns {{ root: string, key: string }}
 */
function memoryRootsOf(workspaceRoot) {
  const root = memoryRoot(workspaceRoot)
  return { root, key: normalizePathKey(root) }
}

/** Preset id that must stay the lightest: no memory read, no memory write. */
const MINIMAL_PRESET = 'minimal'

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
 * Preset id recorded on one session header, lower-cased; undefined when absent.
 */
function presetOf(session) {
  const header = session && typeof session === 'object' ? session.header : undefined
  if (!header || typeof header !== 'object') return undefined
  const preset = header.agentPreset
  if (typeof preset !== 'string') return undefined
  const text = preset.trim().toLowerCase()
  return text === '' ? undefined : text
}

/**
 * Whether one session runs the minimal preset. A minimal run stays as light as
 * possible: the memory index is never read and nothing is ever written, so the
 * plugin only pays for the guards themselves.
 */
function isMinimalSession(session) {
  return presetOf(session) === MINIMAL_PRESET
}

/**
 * Whether one session is a subagent / teammate / workflow-child session. These
 * get a read-only memory section (roadmap C7): they may read the index but
 * never write it — no extraction, no index repair, no directory creation.
 */
function isSubagentSession(session) {
  if (!session || typeof session !== 'object') return false
  const header = session.header
  if (!header || typeof header !== 'object') return false
  return header.origin === 'subagent'
}

/**
 * Whether one session participates in workspace memory at all. Subagent
 * sessions are eligible since C7 (read-only injection), so the only excluded
 * shapes are non-objects.
 */
function isEligibleSession(session) {
  return !!session && typeof session === 'object'
}

/** The user's home directory, or undefined when it cannot be resolved. */
function safeHomeDir() {
  try {
    const home = homedir()
    return typeof home === 'string' && home.length > 0 ? home : undefined
  } catch (_error) {
    return undefined
  }
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
    const content = renderFactFile({
      ...memory,
      originSessionId: origin,
      // Host-maintained timestamps (roadmap D2): keep the original createdAt on
      // update, refresh updatedAt on every write.
      createdAt: frontmatter?.createdAt,
      updatedAt: undefined,
    })
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

/** Resolve one path through ctx.fs, tolerating a missing provider or target. */
async function resolveTarget(fs, path, signal) {
  if (!fs || typeof fs.resolve !== 'function') return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  try {
    const target = signal === undefined ? await fs.resolve(path) : await fs.resolve(path, { signal })
    return target === undefined ? undefined : target
  } catch (error) {
    log('resolve failed for ' + path + ': ' + errorText(error))
    return undefined
  }
}

/** True when a filesystem error means the file is simply not there. */
function isMissingError(error) {
  if (!error || typeof error !== 'object') return false
  const code = typeof error.code === 'string' ? error.code : ''
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Read one file through ctx.fs and keep WHY it failed.
 *
 * Distinguishing missing from unreadable matters: the index writer used to read
 * an unreadable MEMORY.md as an empty one, then rewrite it with a single line and
 * drop every other pointer.
 *
 * @param {unknown} fs the ctx.fs service
 * @param {string} path absolute path
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ status: 'ok' | 'missing' | 'error', text: string, detail: string }>}
 */
async function readFileState(fs, path, signal) {
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    return { status: 'error', text: '', detail: 'fs provider unavailable' }
  }
  if (typeof path !== 'string' || path.length === 0) {
    return { status: 'error', text: '', detail: 'empty path' }
  }
  let target
  try {
    target = signal === undefined ? await fs.resolve(path) : await fs.resolve(path, { signal })
  } catch (error) {
    return { status: 'error', text: '', detail: 'resolve: ' + errorText(error) }
  }
  if (target === undefined) return { status: 'error', text: '', detail: 'resolve: no target' }
  if (typeof fs.stat === 'function') {
    try {
      const info = signal === undefined ? await fs.stat(target) : await fs.stat(target, signal)
      // A stat that finds nothing is the provider's way of saying missing.
      if (info === undefined || info === null) {
        return { status: 'missing', text: '', detail: 'stat: not found' }
      }
      if (info.type !== 'file') {
        const kind = typeof info.type === 'string' ? info.type : 'unknown'
        return { status: 'error', text: '', detail: 'stat: type ' + kind }
      }
    } catch (error) {
      const detail = 'stat: ' + errorText(error)
      return { status: isMissingError(error) ? 'missing' : 'error', text: '', detail }
    }
  }
  try {
    const text = signal === undefined ? await fs.readText(target) : await fs.readText(target, signal)
    // The read itself may report absence instead of throwing.
    if (text === undefined || text === null) {
      return { status: 'missing', text: '', detail: 'readText: not found' }
    }
    if (typeof text !== 'string') return { status: 'error', text: '', detail: 'readText: non-string' }
    return { status: 'ok', text, detail: '' }
  } catch (error) {
    const detail = 'readText: ' + errorText(error)
    return { status: isMissingError(error) ? 'missing' : 'error', text: '', detail }
  }
}

/** Read one file's text; undefined when absent, or unreadable (logged). */
async function readFileText(fs, path, signal) {
  const state = await readFileState(fs, path, signal)
  if (state.status === 'ok') return state.text
  if (state.status === 'error') log('read failed for ' + path + ' (' + state.detail + ')')
  return undefined
}

/** Read one memory file by name; undefined when absent or unreadable. */
async function readMemoryFileText(fs, root, fileName, signal) {
  const path = safeMemoryPath(root, fileName)
  if (path === undefined) return undefined
  return readFileText(fs, path, signal)
}

/**
 * Move one forgotten fact into `<root>/trash/` instead of deleting it.
 *
 * The copy goes through `ctx.fs.writeText` (the seam has no move/rename) and the
 * original is unlinked with node fs only after the copy succeeded, so a failed
 * trash write never loses the fact. Returns whether the original was removed.
 */
async function forgetToTrash(plugin, fs, root, fileName, signal, policy) {
  const path = safeMemoryPath(root, fileName)
  if (path === undefined) return false
  const content = await readFileText(fs, path, signal)
  if (content === undefined) {
    // Already gone: the previous unlink-free contract treated missing files as
    // a successful no-op.
    return false
  }
  const trashPath = join(trashDirPath(root), fileName)
  const trashTarget = await resolveTarget(fs, trashPath)
  if (trashTarget === undefined) {
    log('failed to trash ' + fileName + ': ' + trashPath + ' is outside the sandbox')
    return false
  }
  try {
    // The trash directory may not exist yet; the fs seam has no mkdir, but the
    // memory root itself was created with node fs under the same policy.
    await mkdir(trashDirPath(root), { recursive: true })
    await fs.writeText(trashTarget, content, undefined, signal, policy)
  } catch (error) {
    log('failed to trash ' + fileName + ': ' + errorText(error))
    return false
  }
  try {
    await unlink(path)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') debug(plugin, `failed to delete ${fileName}: ${errorText(error)}`)
    return false
  }
  return true
}

/** Evict the oldest trash files beyond the retention cap. */
async function trimTrash(plugin, root) {
  const trashDir = trashDirPath(root)
  let names
  try {
    names = await readdir(trashDir)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') log('failed to list trash: ' + errorText(error))
    return
  }
  const entries = []
  for (const name of names) {
    try {
      const info = await stat(join(trashDir, name))
      if (info.isFile()) entries.push({ name, mtimeMs: info.mtimeMs })
    } catch (_ignored) {
      // Raced with another eviction; the next forget re-checks the cap.
    }
  }
  for (const name of selectTrashEvictions(entries, TRASH_KEEP)) {
    try {
      await unlink(join(trashDir, name))
    } catch (error) {
      debug(plugin, 'failed to evict trash/' + name + ': ' + errorText(error))
    }
  }
}

/**
 * Read the memory directory's raw index, keeping the failure reason.
 *
 * @param {object} plugin plugin instance
 * @param {object} record workspace record
 * @param {AbortSignal} [signal]
 * @param {string} [root] memory root to read; defaults to the record's own
 * @returns {Promise<{ status: 'ok' | 'missing' | 'error', text: string, detail: string }>}
 */
async function readIndexState(plugin, record, signal, root) {
  const fs = safeService(plugin.ctx, 'fs')
  const memoryRootPath = typeof root === 'string' && root.length > 0 ? root : record.memoryRoot
  const path = safeMemoryPath(memoryRootPath, 'MEMORY.md')
  if (path === undefined) {
    return { status: 'error', text: '', detail: 'index path outside the memory root' }
  }
  return readFileState(fs, path, signal)
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
    if (isMinimalSession(session)) {
      debug(plugin, 'memory disabled for ' + (sessionIdOf(session) ?? '(unknown)') + ' (minimal preset: no read, no write)')
      return
    }
    if (!isEnabled(plugin)) return

    // Roadmap C7: a subagent / teammate session reads memory but never writes
    // it. It gets the index section like a main session, but its record is
    // flagged read-only: no directory creation, no turn observation (events
    // never route to it), no extraction, no reaction to tools/result.
    const readOnly = isSubagentSession(session)

    const root = workspaceRootOf(session)
    const memory = memoryRootsOf(root)
    // W5 (ZCode custom-agent memory): a session that runs a non-default agent
    // preset reads and writes its own memory root, so one persona's memories do
    // not leak into the workspace-wide agent. A `subagent` keeps the shared root
    // and gets its own scope injected read-only instead.
    const agentKey = resolveAgentKey(session)
    const agentRoots = agentKey === undefined
      ? undefined
      : resolveAgentMemoryRoots({ workspaceRoot: root, homeDir: safeHomeDir(), agentKey })
    const ownRoot = agentKey !== undefined && agentKey !== 'subagent'
      && agentRoots !== undefined && typeof agentRoots.local === 'string'
      ? agentRoots.local
      : memory.root
    const record = {
      agent,
      session,
      sessionId: sessionIdOf(session),
      root,
      memoryRoot: ownRoot,
      rootKey: normalizePathKey(ownRoot),
      agentKey,
      agentRoots,
      abort: new AbortController(),
      running: false,
      pending: null,
      buffer: newTurnBuffer(),
      // Volatile session state (roadmap C2): never persisted, one toggle.
      skipTurnExtraction: false,
      // Roadmap C7: subagent sessions observe nothing and write nothing.
      readOnly,
      // Roadmap D3: the first keyword-bearing user message becomes the query
      // the injected index is ranked against; undefined until then.
      query: undefined,
      // W4 (ZCode extraction cursor): the durable per-session boundary plus the
      // not-yet-extracted messages, so a failed run retries the same window
      // instead of losing the turn.
      cursor: emptyCursor(),
      cursorLoaded: false,
      pendingMessages: [],
      messageSeq: 0,
    }
    plugin.byAgent.set(agent, record)
    if (!readOnly && record.sessionId !== undefined) plugin.bySession.set(record.sessionId, record)

    if (readOnly) {
      debug(plugin, 'read-only memory for ' + (record.sessionId ?? '(unknown)') + ' (subagent: index injected, no extraction, no writes)')
    } else {
      await ensureDirectory(plugin, record)
      await loadCursor(plugin, record)
    }

    const rendered = await loadAgentSection(plugin, record)
    plugin.sectionCache.set(agent, rendered.text)
    if (!rendered.indexOk) {
      // Rules-only section because the index was unreadable: remember the
      // failure so the next section read can retry with backoff.
      sectionRetries.set(agent, { attempts: 0, nextAtMs: 0, pending: false })
    }
    debug(plugin, `section ready for ${record.sessionId ?? '(unknown)'} (index lines: ${rendered.indexLineCount})`)
  } catch (error) {
    // A failed init read caches a failure state instead of nothing, so the
    // next section read can retry with backoff instead of leaving the Agent
    // without an index for its whole life.
    if (agent && !plugin.disposed) {
      plugin.sectionCache.set(agent, false)
      sectionRetries.set(agent, { attempts: 0, nextAtMs: 0, pending: false })
    }
    log('initializeAgent failed: ' + errorText(error))
  }
}

/**
 * One bounded read → repair → render pass for a session's memory state, holding
 * the workspace lock like applyExtraction does. Resolves the rendered section
 * with an `indexOk` flag: an unreadable index still renders the rules-only
 * section instead of rejecting, so the caller can record the failure and retry
 * later.
 */
async function loadAgentSection(plugin, record) {
  // The awaited serial creation listener must never stall a session on a slow
  // filesystem provider, so the initial index read is bounded.
  const readSignal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(INIT_READ_TIMEOUT_MS)
    : undefined
  // The read → repair → write region races with concurrent extractions on the
  // same root, so it holds the workspace lock like applyExtraction does.
  let indexOk = true
  let rawIndex = ''
  await runWithWorkspaceLocks(
    plugin,
    [record.rootKey],
    'index repair ' + (record.sessionId ?? '(unknown)'),
    async () => {
      const state = await readIndexState(plugin, record, readSignal, record.memoryRoot)
      if (state.status === 'error') {
        indexOk = false
        log('index unreadable for ' + (record.sessionId ?? '(unknown)') + ' (' + state.detail + '); injecting rules only')
      }
      rawIndex = state.status === 'ok' ? state.text : ''
      const repaired = await repairIndex(plugin, safeService(plugin.ctx, 'fs'), record, rawIndex, REPAIR_READ_TIMEOUT_MS, record.memoryRoot)
      if (repaired !== undefined) {
        const stored = await writeIndexFile(plugin, record, repaired.text, rawIndex, record.memoryRoot)
        if (stored) {
          debug(plugin, 'index repaired for ' + (record.sessionId ?? '(unknown)') + ': +' + repaired.added + ' pointer(s)')
          rawIndex = repaired.text
        }
      }
    },
  )
  // W2 (ZCode alignment): the two retrieval branches are mutually exclusive.
  // The semantic branch renders rules-only and appends the selector result
  // cached for this session; the default branch keeps the index exactly as
  // before (the shipped constant selects it, so this is inert by default).
  const recallText = retrievalBranch() === 'semantic-recall'
    ? plugin.recall.get(record.sessionId)
    : undefined
  const rendered = renderMemorySection({
    root: record.memoryRoot,
    rawIndex: typeof recallText === 'string' ? '' : rawIndex,
    maxChars: maxIndexChars(plugin),
    query: record.query,
  })
  if (typeof recallText === 'string' && recallText.length > 0) {
    rendered.text = rendered.text.length === 0 ? recallText : rendered.text + '\n\n' + recallText
  }
  rendered.indexOk = indexOk
  // W5: a read-only subagent also sees its own agent-scope index when one
  // exists; a custom preset already runs on its own root above.
  const agentBlock = await agentMemoryBlockFor(plugin, record)
  if (agentBlock.length > 0) {
    rendered.text = rendered.text.length === 0 ? agentBlock : rendered.text + '\n\n' + agentBlock
  }
  return rendered
}

/**
 * Synchronous part of the retry: the section provider stays sync — a read
 * that finds the failure cache entry only schedules the asynchronous retry
 * once the backoff step has elapsed; the next read consumes the result.
 */
function scheduleSectionRetry(plugin, agent) {
  const state = sectionRetries.get(agent)
  if (!state || state.pending) return
  if (Date.now() < state.nextAtMs) return
  state.pending = true
  setTimeout(() => {
    void retryAgentSection(plugin, agent)
  }, 0)
}

/**
 * Backoff retry for a failed init index read, started fire-and-forget from the
 * synchronous section provider. On success the rendered section replaces the
 * failure cache entry; on failure the backoff advances, and after the last
 * step the Agent keeps its rules-only section for the rest of its life.
 */
async function retryAgentSection(plugin, agent) {
  const state = sectionRetries.get(agent)
  const record = plugin.byAgent.get(agent)
  if (!state || !record || plugin.disposed) {
    sectionRetries.delete(agent)
    return
  }
  try {
    const rendered = await loadAgentSection(plugin, record)
    plugin.sectionCache.set(agent, rendered.text)
    if (rendered.indexOk) {
      sectionRetries.delete(agent)
      debug(plugin, `section ready for ${record.sessionId ?? '(unknown)'} (index lines: ${rendered.indexLineCount}, retry ${state.attempts + 1})`)
    } else {
      recordRetryFailure(record, agent, state)
    }
  } catch (error) {
    recordRetryFailure(record, agent, state, error)
  } finally {
    state.pending = false
  }
}

/** Consume one backoff step after a failed retry; the last step stops retrying. */
function recordRetryFailure(record, agent, state, error) {
  state.attempts += 1
  const wait = RETRY_BACKOFF_MS[Math.min(state.attempts - 1, RETRY_BACKOFF_MS.length - 1)]
  state.nextAtMs = Date.now() + wait
  const detail = error === undefined ? 'index unreadable' : errorText(error)
  if (state.attempts >= RETRY_BACKOFF_MS.length) {
    // The backoff table is exhausted; keep the current section and stop.
    sectionRetries.delete(agent)
  }
  log('index retry failed for ' + (record.sessionId ?? '(unknown)') + ' (attempt ' + state.attempts + ', next in ' + wait + 'ms): ' + detail)
}

/**
 * Roadmap C6: after an extraction writes new memories, re-read and re-render
 * the Agent's section so the next turn already contains the fresh pointers —
 * a session no longer has to be restarted to see what it just recorded. This
 * runs fire-and-forget: a failed refresh keeps the current cached section and
 * never touches the B3 retry backoff (the retry machine owns that path), so
 * the two mechanisms coexist — success invalidates and refills, failure keeps
 * the last good text and the existing backoff schedule.
 */
async function refreshAgentSection(plugin, record) {
  if (plugin.disposed) return
  try {
    const rendered = await loadAgentSection(plugin, record)
    if (plugin.disposed) return
    if (rendered.indexOk) {
      plugin.sectionCache.set(record.agent, rendered.text)
      // The fresh read succeeded, so any pending backoff for an earlier
      // unreadable index is obsolete: the retry machine would only re-read
      // the same healthy index again.
      sectionRetries.delete(record.agent)
      debug(plugin, `section refreshed for ${record.sessionId ?? '(unknown)'} (index lines: ${rendered.indexLineCount})`)
    } else {
      debug(plugin, `section refresh kept the last good text for ${record.sessionId ?? '(unknown)'} (index unreadable)`)
    }
  } catch (error) {
    // The session keeps its last good section, but the promised "next turn
    // sees the new memories" silently broke: journal it like other
    // background-call failures, not only under debugLog.
    log('section refresh failed for ' + (record.sessionId ?? '(unknown)') + ': ' + errorText(error))
  }
}

/** Best-effort directory creation, never under a read-only policy. */
async function ensureDirectory(plugin, record) {
  const gate = resolvePolicy(plugin, record)
  if (gate === undefined || !gate.writable) {
    debug(plugin, 'memory directory not created (read-only session or no sandbox policy)')
    return
  }
  // Memory is per-workspace: the one directory this session owns must exist.
  try {
    await mkdir(record.memoryRoot, { recursive: true })
  } catch (error) {
    debug(plugin, 'mkdir failed for ' + record.memoryRoot + ': ' + errorText(error))
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

/**
 * Best-effort index write outside a session turn (the repair path).
 * `root` names the memory root; it defaults to the record's own root.
 */
async function writeIndexFile(plugin, record, text, previousText, root) {
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function') return false
  // Roadmap C7: a read-only (subagent) record must never write, even inside a
  // writable sandbox — the index repair is a write path it cannot initialize.
  if (record.readOnly) {
    debug(plugin, 'index repair not written (read-only subagent session)')
    return false
  }
  const gate = resolvePolicy(plugin, record)
  if (gate === undefined || !gate.writable) {
    debug(plugin, 'index repair not written (read-only session or no sandbox policy)')
    return false
  }
  const layerRoot = typeof root === 'string' && root.length > 0 ? root : record.memoryRoot
  const target = await resolveTarget(fs, indexPath(layerRoot))
  if (target === undefined) return false
  if (typeof previousText === 'string' && previousText.length > 0) {
    const backupTarget = await resolveTarget(fs, join(layerRoot, 'MEMORY.md.prev'))
    if (backupTarget !== undefined) {
      try {
        await fs.writeText(backupTarget, previousText, undefined, plugin.controller.signal, gate.policy)
      } catch (error) {
        debug(plugin, 'failed to back up MEMORY.md: ' + errorText(error))
      }
    }
  }
  try {
    await fs.writeText(target, text, undefined, plugin.controller.signal, gate.policy)
    return true
  } catch (error) {
    log('failed to write repaired MEMORY.md: ' + errorText(error))
    return false
  }
}

/**
 * Pointers one memory directory's index should have but does not.
 *
 * A fact file that no pointer line references is unreachable, because the model
 * only ever sees the index. Fewer pointer lines than fact files therefore means
 * damaged data (an external overwrite, a crashed write), not an editorial choice,
 * so the missing links are rebuilt from the fact frontmatter before injection.
 * Each index is repaired against its own facts.
 *
 * @returns {Promise<{ text: string, added: number } | undefined>} repaired text
 */
async function repairIndex(plugin, fs, record, currentIndex, budgetMs = REPAIR_READ_TIMEOUT_MS, root) {
  if (!fs || typeof fs.listDir !== 'function') return undefined
  const layerRoot = typeof root === 'string' && root.length > 0 ? root : record.memoryRoot
  const rootTarget = await resolveTarget(fs, layerRoot)
  if (rootTarget === undefined) return undefined
  let entries
  try {
    entries = await fs.listDir(rootTarget)
  } catch (error) {
    debug(plugin, 'index repair skipped (listDir: ' + errorText(error) + ')')
    return undefined
  }
  const factNames = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (isNonFactEntry(entry.name)) continue
    if (isIndexFile(entry.name)) continue
    if (parseFactFileName(entry.name) === undefined) continue
    factNames.push(entry.name)
  }
  if (factNames.length === 0) return undefined
  const pointers = parseIndexPointers(typeof currentIndex === 'string' ? currentIndex : '')
  const linked = new Set(pointers.map((pointer) => pointer.file))
  const missing = factNames.filter((name) => !linked.has(name)).sort()
  if (missing.length === 0) return undefined
  if (pointers.length + missing.length > MAX_INDEX_LINES) {
    log('index repair skipped for ' + (record.sessionId ?? '(unknown)') + ': ' + factNames.length
      + ' fact(s) exceed ' + MAX_INDEX_LINES + ' index lines')
    return undefined
  }
  // Startup must not stall on a huge memory dir: bound the whole read walk.
  const deadline = Date.now() + budgetMs
  const added = []
  for (const name of missing) {
    if (added.length > 0 && Date.now() >= deadline) {
      debug(plugin, 'index repair budget of ' + budgetMs + 'ms exhausted; '
        + added.length + ' of ' + missing.length + ' pointer(s) rebuilt')
      break
    }
    const content = await readMemoryFileText(fs, layerRoot, name)
    const front = parseFactFrontmatter(typeof content === 'string' ? content : '')
    const fallback = parseFactFileName(name)
    const base = front && typeof front.name === 'string' && front.name.length > 0 ? front.name : fallback
    const hook = front && typeof front.description === 'string' ? front.description : ''
    added.push(renderPointer({ title: deriveTitle(base), file: name, hook }))
  }
  if (added.length === 0) return undefined
  const body = typeof currentIndex === 'string' ? currentIndex.trim() : ''
  const text = (body.length === 0 ? '' : body + '\n') + added.join('\n') + '\n'
  return { text, added: added.length }
}
/* ----------------------------------------------------------------- events */

/**
 * Roadmap D3: the first user message that carries a keyword signal becomes
 * this session's ranking query. The current index is re-rendered in the
 * background so the ranking takes effect without waiting for a write; the
 * ordering only shapes the injected copy and never reaches `MEMORY.md`.
 * @param {object} plugin
 * @param {{ query?: string, buffer?: object }} record the owning session record
 * @param {object} buffer the turn buffer `applyUserMessage` just returned
 */
function noteSessionQuery(plugin, record, buffer) {
  if (record.query !== undefined) return
  const messages = buffer && Array.isArray(buffer.messages) ? buffer.messages : []
  const latest = messages.length > 0 ? messages[messages.length - 1] : undefined
  if (!latest || typeof latest.text !== 'string' || latest.text.length === 0) return
  if (queryTermsForRanking(latest.text).length === 0) return
  record.query = latest.text
  void refreshAgentSection(plugin, record)
}

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
        noteSessionQuery(plugin, record, applyUserMessage(record.buffer, event.data))
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
    // Roadmap C7: subagent sessions never react to tool results — the buffer
    // only feeds extraction, which a read-only record must never start.
    if (record.readOnly) return
    // A direct write into the memory directory skips extraction for this turn.
    applyToolResult(record.buffer, record.rootKey, exec)
    // Roadmap D2: a read tool that touched a fact file marks it for the lazy
    // batched `lastAccessedAt` rewrite.
    noteAccessHits(plugin, record.rootKey, exec)
  } catch (error) {
    debug(plugin, 'tools/result handler failed: ' + errorText(error))
  }
}

/**
 * Record one `tools/result` as a fact-file read hit when the tool is a read
 * family member and one of its string arguments names a `.md` fact file under
 * `root` (roadmap D2). Index files never get `lastAccessedAt`. Returns the
 * file names recorded this call (deduped), for tests.
 * @param {unknown} plugin
 * @param {string} root memory root key (normalizePathKey output)
 * @param {unknown} exec tools/result payload `{ name, arguments, agent }`
 * @returns {string[]}
 */
function noteAccessHits(plugin, root, exec) {
  if (!exec || typeof exec !== 'object') return []
  const toolName = typeof exec.name === 'string' ? exec.name.toLowerCase() : ''
  if (!READ_TOOLS.has(toolName)) return []
  const key = normalizePathKey(root)
  if (key.length === 0) return []
  // Roadmap C-series exec shape: `arguments` may arrive as an object or as a
  // pre-serialized JSON string; normalize before the string walk.
  let args = exec.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch (_ignored) {
      return []
    }
  }

  const candidates = []
  collectArgumentStrings(args, candidates, 0)
  const hits = new Set()
  for (const value of candidates) {
    const base = baseNameOf(value)
    if (isIndexFile(base)) continue
    const factName = parseFactFileName(base)
    if (factName === undefined) continue
    // A bare `name.md` argument counts only when the session actually lives in
    // this memory root — the same heuristic write detection uses for the root key.
    // A path-shaped argument must mention the memory root to count.
    if (value !== base && !normalizePathKey(value).includes(key)) continue
    hits.add(factName)
  }
  if (hits.size === 0) return []

  let pending = pendingAccessHits.get(key)
  if (pending === undefined) {
    pending = new Set()
    pendingAccessHits.set(key, pending)
  }
  for (const factName of hits) pending.add(factName)
  scheduleAccessFlush(plugin)
  return [...hits]
}

/** Basename of a path-like string, tolerating both slash directions. */
function baseNameOf(value) {
  const text = typeof value === 'string' ? value : ''
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut < 0 ? text : text.slice(cut + 1)
}

/** Arm the shared debounce timer that drains `pendingAccessHits`, once. */
function scheduleAccessFlush(plugin) {
  if (plugin.disposed) return
  if (accessFlushTimer !== undefined) return
  accessFlushTimer = setTimeout(() => {
    accessFlushTimer = undefined
    void flushAccessHits(plugin)
  }, ACCESS_FLUSH_DELAY_MS)
}

/**
 * Rewrite `metadata.lastAccessedAt` for every pending hit, root by root,
 * under that memory root's workspace lock. One batched pass per debounce window —
 * never one write per read. Rewrites only the frontmatter timestamp line and
 * skips files whose content changed shape underneath us.
 * @param {unknown} plugin
 */
async function flushAccessHits(plugin) {
  if (plugin.disposed) return
  const fs = safeService(plugin.ctx, 'fs')
  if (fs === undefined) return

  // Snapshot and clear up front so hits recorded during the flush join the
  // next batch instead of racing this one.
  const batches = [...pendingAccessHits.entries()]
  pendingAccessHits.clear()
  if (batches.length === 0) return

  for (const [rootKey, names] of batches) {
    const root = resolveMemoryRootByKey(plugin, rootKey)
    if (root === undefined) continue
    try {
      await runWithWorkspaceLocks(plugin, [rootKey], 'access-flush', async () => {
        for (const name of names) {
          // `names` holds fact names (no extension); safeMemoryPath wants file names.
          const filePath = safeMemoryPath(root, factFileName(name))
          if (filePath === undefined) continue
          const state = await readFileState(fs, filePath, undefined)
          if (state.status !== 'ok') continue
          const updated = touchLastAccessed(state.text)
          if (updated === undefined || updated === state.text) continue
          const target = await resolveTarget(fs, filePath, undefined)
          if (target === undefined) continue
          await fs.writeText(target, updated, undefined, undefined, undefined)
        }
      })
    } catch (error) {
      log('access flush failed for ' + rootKey + ': ' + errorText(error))
    }
  }
}

/**
 * Find the real memory root path for a stored path key by asking the plugin's
 * records; undefined when no live record owns that key.
 * @param {unknown} plugin
 * @param {string} rootKey
 * @returns {string | undefined}
 */
function resolveMemoryRootByKey(plugin, rootKey) {
  const byAgent = plugin.byAgent
  if (byAgent !== undefined && typeof byAgent.values === 'function') {
    for (const record of byAgent.values()) {
      if (record.rootKey === rootKey) return record.memoryRoot
    }
  } else if (byAgent !== undefined) {
    // WeakMap (no iteration): probe each record we can reach another way.
    for (const record of collectTrackedRecords(plugin)) {
      if (record.rootKey === rootKey) return record.memoryRoot
    }
  }
  return undefined
}

/**
 * Records reachable without WeakMap iteration: bySession values (which map to
 * the same records byAgent holds) plus any initialAgentRef hooks.
 * @param {unknown} plugin
 * @returns {Array<object>}
 */
function collectTrackedRecords(plugin) {
  const records = []
  if (plugin.bySession instanceof Map) {
    for (const record of plugin.bySession.values()) {
      if (record && typeof record === 'object') records.push(record)
    }
  }
  return records
}

/**
 * Rewrite only the `metadata.lastAccessedAt` line of one fact file's
 * frontmatter. Returns undefined when the text is not a parseable fact file —
 * in that case the flush leaves the file alone rather than re-rendering it.
 * @param {string} text
 * @returns {string | undefined}
 */
function touchLastAccessed(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return undefined
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return undefined
  const stamp = nowIsoTimestamp()
  const line = '  lastAccessedAt: ' + stamp
  const lines = normalized.slice(0, end).split('\n')
  let replaced = false
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s+)lastAccessedAt\s*:/.exec(lines[i])
    if (match === null) continue
    lines[i] = match[1] + 'lastAccessedAt: ' + stamp
    replaced = true
    changed = true
    break
  }
  if (!replaced) {
    // Insert at the end of the metadata block (the slice stops right before
    // the closing fence, so the last entry is the array's tail).
    if (!lines.some((entry) => entry === 'metadata:')) return undefined
    lines.push(line)
    changed = true
  }
  if (!changed) return undefined
  return lines.join('\n') + normalized.slice(end)
}

/** A completed turn: decide, buffer, and schedule one extraction. */
function onCompletedTurn(plugin, record) {
  const buffer = record.buffer
  record.buffer = newTurnBuffer()
  if (isMinimalSession(record.session)) return
  // Roadmap C7: a read-only (subagent) record is never routed turn events, so
  // this guard is defense in depth — it can never schedule an extraction even
  // if a session id collides or events are replayed.
  if (record.readOnly) return
  // Session-level incognito toggle (roadmap C2): the panel sets this volatile
  // per-session flag and the turn path drops out before any budget counting.
  if (record.skipTurnExtraction === true) {
    debug(plugin, `extraction skipped for ${record.sessionId ?? '(unknown session)'} (this turn: no extraction)`)
    return
  }
  if (!isEnabled(plugin) || !isAutoExtract(plugin)) return

  const decision = evaluateExtraction({ userBlocks: buffer.userBlocks, directWrite: buffer.directWrite })
  if (!decision.run) {
    debug(plugin, `extraction skipped for ${record.sessionId ?? '(unknown session)'} (${decision.reason ?? 'unknown'})`)
    return
  }
  const gate = resolvePolicy(plugin, record)
  if (gate === undefined || !gate.writable) {
    debug(plugin, `extraction skipped for ${record.sessionId ?? '(unknown session)'} (read-only session or no sandbox policy)`)
    return
  }
  if (!reserveExtractionBudget(plugin, record)) return
  // W4 (ZCode alignment): the turn is appended to this session's pending
  // backlog, and only the window after the last settled boundary is extracted,
  // capped at CURSOR_MAX_PENDING_CHARS. A turn that failed last time is retried
  // with the same messages instead of being lost.
  record.pendingMessages = appendPendingMessages(record, buffer.messages)
  // One turn is never truncated by the cursor: the window keeps at least the
  // segmentation capacity (roadmap D6), so an oversized turn still reaches the
  // model head-and-tail through buildTranscriptSegments instead of losing its
  // oldest content here.
  const pendingBudget = Math.max(CURSOR_MAX_PENDING_CHARS, MAX_TRANSCRIPT_CHARS * MAX_TRANSCRIPT_SEGMENTS)
  const window = pendingWindow(record.pendingMessages, record.cursor, {
    sessionId: record.sessionId ?? '',
    maxChars: pendingBudget,
  })
  const pending = window.messages.length > 0 ? window.messages : record.pendingMessages
  const boundaryId = pending.length > 0 ? pending[pending.length - 1].id : undefined
  // W2: the semantic branch refreshes its selector result for the next section
  // read. The default branch (the shipped one) does nothing here.
  if (retrievalBranch() === 'semantic-recall') {
    void refreshRecall(plugin, record, buffer.userBlocks[buffer.userBlocks.length - 1])
  }
  scheduleExtraction(plugin, record, {
    messages: pending.map((message) => ({ role: message.role, text: message.text })),
    messageCount: pending.length,
    policy: gate.policy,
    boundaryId,
  })
}

/* -------------------------------------------------------------- extraction */

/**
 * Budget gate for one qualifying turn: enforces `extractDailyLimit` and
 * `extractMinIntervalMs` per workspace and records the attempt. Counting is
 * unconditional — the panel shows today's activity even with the unlimited
 * defaults; 0 only means "no ceiling", not "no counter". The reservation
 * happens synchronously at schedule time, before the queued snapshot can run,
 * so pending turns cannot dodge the counter. Returns false when the budget is
 * exhausted and journals the skip.
 */
function reserveExtractionBudget(plugin, record) {
  const limit = extractDailyLimit(plugin)
  const minIntervalMs = extractMinIntervalMs(plugin)

  const key = record.rootKey
  const nowMs = Date.now()
  const day = localDayKey(nowMs)
  const entry = workspaceBudgets.get(key)
  const count = entry && entry.day === day ? entry.count : 0
  const label = record.sessionId ?? '(unknown session)'

  if (limit > 0 && count >= limit) {
    debug(plugin, `extraction skipped for ${label} (daily limit reached: ${count}/${limit} today)`)
    return false
  }
  if (minIntervalMs > 0 && entry && entry.day === day && entry.lastAtMs > 0
    && nowMs - entry.lastAtMs < minIntervalMs) {
    debug(plugin, `extraction skipped for ${label} (min interval not elapsed: ${nowMs - entry.lastAtMs}ms < ${minIntervalMs}ms)`)
    return false
  }

  workspaceBudgets.set(key, { day, count: count + 1, lastAtMs: nowMs })
  return true
}

/** Local-time date string of one epoch-ms timestamp (`YYYY-MM-DD`). */
function localDayKey(nowMs) {
  const date = new Date(nowMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayOfMonth}`
}

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
      let status = 'error'
      try {
        status = await extractOnce(plugin, record, snapshot)
      } catch (error) {
        debug(plugin, 'extraction failed: ' + errorText(error))
      }
      // W4: only success / no-op / skip advance the durable boundary; a failed
      // attempt keeps the window so the next qualifying turn retries it with
      // the same messages (ZCode's cursor rule).
      await settleExtractionCursor(plugin, record, status, snapshot.boundaryId)
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

/* ------------------------------------------------- extraction cursor (W4) */

/** Where one session's durable extraction cursor lives (never inside the index). */
function cursorFilePath(record) {
  return join(record.root, '.dsh', 'memory-state', 'cursor.json')
}

/**
 * Load one session's cursor. A missing file is a fresh session; an unreadable or
 * foreign-version file downgrades to an empty cursor, which replays the backlog
 * instead of silently disabling extraction.
 */
async function loadCursor(plugin, record) {
  const fs = safeService(plugin.ctx, 'fs')
  const state = await readFileState(fs, cursorFilePath(record))
  if (state.status === 'ok') record.cursor = parseCursor(state.text)
  record.cursorLoaded = true
}

/** Persist one session's cursor; a failure is journaled, never thrown. */
async function persistCursor(plugin, record) {
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function' || typeof fs.resolve !== 'function') return
  const path = cursorFilePath(record)
  try {
    const target = await fs.resolve(path)
    if (target === undefined) return
    await mkdir(dirname(path), { recursive: true })
    await fs.writeText(target, serializeCursor(record.cursor))
  } catch (error) {
    debug(plugin, 'cursor write failed: ' + errorText(error))
  }
}

/**
 * Append one turn's messages to the session backlog and drop everything already
 * covered by the durable boundary, so the backlog stays proportional to what is
 * still unextracted instead of the whole session.
 * @param {object} record live session record
 * @param {Array<{ role: string, text: string }>} messages this turn's messages
 * @returns {Array<{ id: string, role: string, text: string }>}
 */
function appendPendingMessages(record, messages) {
  const sessionKey = record.sessionId ?? ''
  const boundaryId = record.cursor.sessions[sessionKey]?.boundaryId
  if (boundaryId !== undefined) {
    const index = record.pendingMessages.findIndex((entry) => entry.id === boundaryId)
    if (index >= 0) record.pendingMessages = record.pendingMessages.slice(index + 1)
  }
  const appended = []
  for (const message of Array.isArray(messages) ? messages : []) {
    record.messageSeq += 1
    appended.push({ id: sessionKey + ':' + record.messageSeq, role: message.role, text: message.text })
  }
  // A session that never settles must not grow without bound: the oldest
  // messages fall off once the backlog is far past one extraction window.
  const combined = record.pendingMessages.concat(appended)
  return combined.length > 400 ? combined.slice(combined.length - 400) : combined
}

/** Advance (or hold) the durable boundary after one attempt and persist it. */
async function settleExtractionCursor(plugin, record, status, boundaryId) {
  const sessionKey = record.sessionId ?? ''
  try {
    record.cursor = advanceCursor(record.cursor, { sessionId: sessionKey, status, boundaryId })
  } catch (error) {
    debug(plugin, 'cursor advance rejected: ' + errorText(error))
    return
  }
  await persistCursor(plugin, record)
}

/* ------------------------------------------------------ semantic recall (W2) */

/** Stat one path's mtime in epoch ms; 0 when the provider cannot report it. */
async function fileMtimeMs(fs, path) {
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function') return 0
  try {
    const target = await fs.resolve(path)
    if (target === undefined) return 0
    const info = await fs.stat(target)
    if (!info || typeof info !== 'object') return 0
    if (typeof info.mtimeMs === 'number' && Number.isFinite(info.mtimeMs)) return info.mtimeMs
    const mtime = info.mtime
    if (mtime instanceof Date) return mtime.getTime()
    return 0
  } catch (_error) {
    return 0
  }
}

/** Every fact file of one root as `{ filePath, content, mtimeMs }` records. */
async function readFactRecords(plugin, record) {
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.listDir !== 'function') return []
  const rootTarget = await resolveTarget(fs, record.memoryRoot)
  if (rootTarget === undefined) return []
  let entries = []
  try {
    entries = await fs.listDir(rootTarget)
  } catch (_error) {
    return []
  }
  const records = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (isNonFactEntry(entry.name)) continue
    if (parseFactFileName(entry.name) === undefined) continue
    const path = safeMemoryPath(record.memoryRoot, entry.name)
    if (path === undefined) continue
    const content = await readMemoryFileText(fs, record.memoryRoot, entry.name)
    if (typeof content !== 'string') continue
    records.push({ filePath: path, content, mtimeMs: await fileMtimeMs(fs, path) })
  }
  return records
}

/**
 * Roadmap W2: ask the selector which existing facts bear on the new user
 * message, then cache the rendered block for the next section read. Every
 * failure is silent (debug) so a selector problem never breaks a turn.
 */
async function refreshRecall(plugin, record, queryText) {
  if (typeof queryText !== 'string' || queryText.trim() === '') return
  if (record.sessionId === undefined) return
  const route = extractRoute(plugin, record)
  if (route === undefined) return
  try {
    const records = await readFactRecords(plugin, record)
    if (records.length === 0) return
    const manifest = buildRecallManifest(records)
    if (manifest.length === 0) return
    const prompt = buildSelectorPrompt({ query: queryText, manifest })
    const reply = await callModel(plugin, record, route, prompt.system + '\n\n' + prompt.user)
    const selected = parseSelectorResponse(reply)
    if (selected === undefined) return
    const previous = plugin.recall.get(record.sessionId)
    const picked = filterRecallSelections({
      manifest,
      selectedFilenames: selected.selectedMemories,
      recalledPaths: previous === undefined ? [] : previous.recalledPaths,
    })
    const byPath = new Map(records.map((entry) => [entry.filePath, entry]))
    const memories = picked.map((entry) => byPath.get(entry.filePath)).filter(Boolean)
    if (memories.length === 0) return
    const text = renderRecallBlock(memories, { nowMs: Date.now(), budgetChars: RECALL_BUDGET_CHARS })
    plugin.recall.set(record.sessionId, {
      text,
      recalledPaths: memories.map((entry) => entry.filePath),
    })
    void refreshAgentSection(plugin, record)
  } catch (error) {
    debug(plugin, 'recall selector failed: ' + errorText(error))
  }
}

/* ---------------------------------------------------------- dream (W3) */

/**
 * One manual consolidation run (ZCode's Dream, one-shot JSON instead of a
 * 50-turn agent loop). Automatic triggering stays off, matching the shipped
 * upstream product; a run is requested explicitly over the RPC.
 */
async function runDream(plugin, record, options = {}) {
  if (plugin.dream.running) return { started: false, reason: 'busy' }
  const nowMs = Date.now()
  if (record.readOnly) return { started: false, reason: 'read-only-session' }
  const lastConsolidatedAtMs = await readDreamLastConsolidatedAt(record.memoryRoot)
  const timing = evaluateDreamTiming({
    nowMs,
    lastConsolidatedAtMs,
    lastScanAtMs: plugin.dream.lastScanAtMs,
    newSessionCount: plugin.bySession.size,
  })
  plugin.dream.lastScanAtMs = nowMs
  if (options.force !== true && timing.decision !== 'scan') {
    return { started: false, reason: timing.reason ?? 'gated' }
  }
  const gate = resolvePolicy(plugin, record)
  if (gate === undefined || !gate.writable) return { started: false, reason: 'not-writable' }
  const priorMtimeMs = await acquireDreamLock({ memoryRoot: record.memoryRoot, nowMs, pid: process.pid })
  if (priorMtimeMs === null) return { started: false, reason: 'locked' }
  plugin.dream.running = true
  plugin.dream.lastError = undefined
  try {
    const route = extractRoute(plugin, record)
    if (route === undefined) throw new Error('no provider/model route')
    const fs = safeService(plugin.ctx, 'fs')
    const indexState = await readIndexState(plugin, record, undefined, record.memoryRoot)
    const manifest = await readManifest(plugin, fs, record)
    const prompt = buildDreamPrompt({
      memoryRoot: record.memoryRoot,
      indexText: indexState.status === 'ok' ? indexState.text : '',
      factBriefs: manifest.map((entry) => ({
        name: entry.name,
        type: entry.type,
        description: entry.description,
        body: entry.excerpt,
      })),
      sessionIds: [...plugin.bySession.keys()],
      activityText: '',
    })
    const reply = await callModel(plugin, record, route, prompt)
    const parsed = parseDreamResponse(reply ?? '')
    const plan = planDreamWrites(parsed)
    const result = {
      started: true,
      updates: plan.memories.length,
      deletes: plan.forget.length,
      applied: false,
    }
    if (plan.memories.length === 0 && plan.forget.length === 0) {
      plugin.dream.lastRunAtMs = Date.now()
      plugin.dream.lastResult = result
      return result
    }
    const applied = await runWithWorkspaceLocks(
      plugin,
      [record.rootKey],
      'dream ' + (record.sessionId ?? 'session'),
      () => applyExtraction(plugin, record, plan, gate.policy),
    )
    result.applied = applied.changed
    if (applied.changed) {
      recordActivity(record, applied)
      await refreshAgentSection(plugin, record)
      maybeGitCommit(plugin, record.memoryRoot, 'workspace-memory: consolidation')
    }
    plugin.dream.lastRunAtMs = Date.now()
    plugin.dream.lastResult = result
    return result
  } catch (error) {
    plugin.dream.lastError = errorText(error)
    log('dream failed: ' + errorText(error))
    // The lock file doubles as the "last consolidated" marker, so a failed run
    // restores its previous mtime instead of pretending consolidation happened.
    await restoreDreamLockAfterFailure({ memoryRoot: record.memoryRoot, priorMtimeMs })
    return { started: true, applied: false, error: plugin.dream.lastError }
  } finally {
    plugin.dream.running = false
  }
}

/** Read-only consolidation status for the panel. */
async function buildDreamStatus(plugin, record) {
  const lastConsolidatedAtMs = record === undefined
    ? 0
    : await readDreamLastConsolidatedAt(record.memoryRoot)
  const nowMs = Date.now()
  const timing = evaluateDreamTiming({
    nowMs,
    lastConsolidatedAtMs,
    lastScanAtMs: plugin.dream.lastScanAtMs,
    newSessionCount: plugin.bySession.size,
  })
  return {
    autoEnabled: false,
    running: plugin.dream.running,
    lastConsolidatedAt: lastConsolidatedAtMs,
    lastRunAt: plugin.dream.lastRunAtMs,
    lastError: plugin.dream.lastError,
    lastResult: plugin.dream.lastResult,
    nextDecision: timing.decision,
    nextReason: timing.reason ?? '',
    lockPath: record === undefined ? '' : join(record.memoryRoot, DREAM_LOCK_FILE),
  }
}

/* --------------------------------------------------- agent-scoped memory (W5) */

/**
 * The extra read-only agent-scope section of one session: empty unless the
 * session is a subagent whose scope already holds an index.
 */
async function agentMemoryBlockFor(plugin, record) {
  if (!record.agentKey || !record.agentRoots) return ''
  const scopeRoot = record.agentRoots.local
  if (typeof scopeRoot !== 'string' || scopeRoot.length === 0) return ''
  if (normalizePathKey(scopeRoot) === normalizePathKey(record.memoryRoot)) return ''
  const fs = safeService(plugin.ctx, 'fs')
  const text = await readFileText(fs, join(scopeRoot, AGENT_MEMORY_INDEX))
  if (typeof text !== 'string' || text.trim() === '') return ''
  return renderAgentMemoryBlock({
    agentKey: record.agentKey,
    indexText: text,
    rulesText: agentMemoryRulesText(scopeRoot),
  })
}

/** One extraction attempt: route, prompt, model call, parse, apply. */
async function extractOnce(plugin, record, snapshot) {
  const route = extractRoute(plugin, record)
  if (route === undefined) {
    debug(plugin, `extraction skipped for ${record.sessionId ?? '(unknown session)'} (no provider/model route)`)
    return 'error'
  }
  const label = record.sessionId ?? '(unknown session)'
  const fs = safeService(plugin.ctx, 'fs')
  const manifest = await readManifest(plugin, fs, record)
  // Roadmap D6: a turn longer than one prompt window is extracted in up to
  // MAX_TRANSCRIPT_SEGMENTS contiguous segments, so its oldest content is not
  // dropped by the tail cap. A normal turn yields one segment and therefore
  // exactly one model call, unchanged. The budget was already reserved once for
  // this turn, so any number of segments still counts as one extraction.
  const segments = buildTranscriptSegments(snapshot.messages, MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_SEGMENTS)
  const transcript = buildTranscript(snapshot.messages, MAX_TRANSCRIPT_CHARS)
  const segmentTexts = segments.length === 0 ? [''] : segments
  // W1 (ZCode alignment): one-shot extraction cannot list or grep the memory
  // directory the way ZCode's memory agent can, so the transcript's own terms
  // select the existing facts that may already cover a fact. The block is ''
  // for a fresh workspace, so a first run's prompt is unchanged.
  const relatedGuidance = renderRelatedMemories(rankRelatedMemories(manifest, transcript.text))
  const agentMode = extractionModeOf(plugin) === 'agent'
  // v0.4.0: the agent engine runs first when configured. It can read, grep and
  // list the memory directory, so it dedupes by inspection instead of from a
  // truncated list. Any failure falls through to the one-shot request below.
  if (agentMode) {
    const agent = await runAgentExtractionPath(plugin, record, route, {
      manifest,
      relatedGuidance,
      segmentTexts,
      snapshot,
      label,
      fs,
    })
    if (agent !== undefined) {
      // A journal plan already went through the agent's own inspection, so it
      // needs no conflict re-ask; a JSON-in-text reply is still refined exactly
      // like the one-shot engine does.
      const plan = agent.fromText
        ? await refinePlanWithConflicts(plugin, record, route, {
            plan: agent.plan,
            manifest,
            snapshot,
            relatedGuidance,
            transcript,
            label,
          })
        : agent.plan
      return settleExtraction(
        plugin,
        record,
        plan,
        snapshot,
        label,
        `mode=agent turns=${agent.turns} toolCalls=${agent.toolCalls}`,
        { engine: 'agent', turns: agent.turns, toolCalls: agent.toolCalls },
      )
    }
    debug(plugin, `agent extraction produced no plan for ${label}; falling back to the one-shot request`)
  }
  const prompt = buildExtractionPrompt({ messageCount: snapshot.messageCount, manifest, relatedGuidance })
  const plans = []
  for (const segment of segmentTexts) {
    const text = await callModel(plugin, record, route, `${prompt}\n${segment}`)
    if (text === undefined) {
      // A background model call is a cost event: its failure is always
      // journaled, not only under debugLog.
      log(`extraction request failed for ${label} (${route.provider}/${route.model})`)
      continue
    }
    const segmentPlan = parseExtractionResponse(text, { maxFacts: MAX_FACTS_PER_RUN })
    if (segmentPlan === undefined) {
      log(`extraction reply was not a valid plan for ${label}; nothing written`)
      continue
    }
    plans.push(segmentPlan)
  }
  // No segment produced a usable plan: nothing to write. A partial success
  // still applies what was parsed — through a single guarded write pass below.
  if (plans.length === 0) return 'error'
  const parsed = plans.length === 1 ? plans[0] : mergeExtractionPlans(plans)
  const plan = await refinePlanWithConflicts(plugin, record, route, {
    plan: parsed,
    manifest,
    snapshot,
    relatedGuidance,
    transcript,
    label,
  })
  return settleExtraction(plugin, record, plan, snapshot, label, `mode=json segments=${segments.length}`, { engine: 'json' })
}

/**
 * Roadmap D4: when a plan names files that closely match existing memories
 * (shared prefix or edit distance ≤ 2), re-ask once with those entries' body
 * excerpts so the model updates in place instead of accumulating a
 * near-duplicate file. A second unparseable reply falls back to the first
 * plan; a conflict-free first reply costs nothing.
 *
 * @param {object} plugin plugin instance
 * @param {object} record workspace record
 * @param {{ provider: string, model: string }} route
 * @param {{
 *   plan: { memories: Array<object>, forget: string[] },
 *   manifest: Array<{ name: string, description: string, excerpt?: string }>,
 *   snapshot: { messageCount: number },
 *   relatedGuidance: string,
 *   transcript: { text: string },
 *   label: string
 * }} context
 * @returns {Promise<{ memories: Array<object>, forget: string[] }>}
 */
async function refinePlanWithConflicts(plugin, record, route, context) {
  const conflicts = findNearDuplicateMatches(
    context.plan.memories.map((memory) => memory.name),
    context.manifest,
  )
  if (conflicts.size === 0) return context.plan
  const details = new Map(context.manifest
    .filter((entry) => conflicts.has(entry.name))
    .map((entry) => [entry.name, { excerpt: entry.excerpt }]))
  const guidance = buildConflictGuidance(conflicts, details)
  const rePrompt = buildExtractionPrompt({
    messageCount: context.snapshot.messageCount,
    manifest: context.manifest,
    relatedGuidance: context.relatedGuidance,
    conflictGuidance: guidance,
  })
  debug(plugin, `extraction conflict re-ask for ${context.label}: ${[...conflicts.keys()].join(', ')}`)
  const reText = await callModel(plugin, record, route, `${rePrompt}\n${context.transcript.text}`)
  const reParsed = reText === undefined
    ? undefined
    : parseExtractionResponse(reText, { maxFacts: MAX_FACTS_PER_RUN })
  if (reParsed === undefined) {
    debug(plugin, `conflict re-ask reply unusable for ${context.label}; keeping the first plan`)
    return context.plan
  }
  return reParsed
}

/**
 * v0.4.0: drive the restricted-tool memory agent and translate what it did into
 * an extraction plan.
 *
 * One loop runs per transcript segment (roadmap D6), so an oversized turn keeps
 * its oldest content and costs one model call per segment, exactly like the
 * one-shot engine. The journal is fed by the host's own guarded readers, so the
 * agent can only ever see and touch files inside this workspace's memory root.
 * A reply that is a parseable JSON plan is still honoured — the one-shot
 * contract stays supported, which is also what the existing fixtures reply with.
 *
 * @param {object} plugin plugin instance
 * @param {object} record workspace record
 * @param {{ provider: string, model: string }} route
 * @param {{
 *   manifest: Array<{ name: string, description: string, excerpt?: string }>,
 *   relatedGuidance: string,
 *   segmentTexts: string[],
 *   snapshot: { messageCount: number, policy: object },
 *   label: string,
 *   fs: object
 * }} context
 * @returns {Promise<{
 *   plan: { memories: Array<object>, forget: string[] },
 *   turns: number,
 *   toolCalls: number,
 *   fromText: boolean
 * } | undefined>}
 */
async function runAgentExtractionPath(plugin, record, route, context) {
  const basePrompt = buildExtractionPrompt({
    messageCount: context.snapshot.messageCount,
    manifest: context.manifest,
    relatedGuidance: context.relatedGuidance,
    agentMode: true,
  })
  const plans = []
  let turns = 0
  let toolCalls = 0
  let fromText = false
  for (const segment of context.segmentTexts) {
    const journal = createMemoryJournal({
      read: (fileName) => readMemoryFileText(context.fs, record.memoryRoot, fileName),
      list: async () => {
        try {
          const target = await resolveTarget(context.fs, record.memoryRoot)
          if (target === undefined) return []
          const entries = await context.fs.listDir(target)
          return (Array.isArray(entries) ? entries : [])
            .filter((entry) => entry && entry.type === 'file' && parseFactFileName(entry.name) !== undefined)
            .map((entry) => entry.name)
        } catch (_error) {
          return []
        }
      },
    })
    const result = await runMemoryAgent({
      journal,
      prompt: `${basePrompt}\n${segment}`,
      system: memoryRulesText(record.memoryRoot),
      provider: route.provider,
      model: route.model,
      maxTurns: agentMaxTurnsOf(plugin),
      callTurn: (request) => callAgentTurn(plugin, record, route, request),
    })
    if (!result.ok) {
      log(`agent extraction failed for ${context.label} (${result.reason ?? 'unknown'}${result.detail ? ': ' + result.detail : ''})`)
      return undefined
    }
    turns += result.turns
    toolCalls += result.toolCalls
    const textPlan = parseExtractionResponse(result.text, { maxFacts: MAX_FACTS_PER_RUN })
    const journaled = journalToPlan(journal)
    if (textPlan !== undefined) {
      plans.push(textPlan)
      fromText = true
      continue
    }
    if (journaled.memories.length > 0 || journaled.forget.length > 0) {
      plans.push(journaled)
      continue
    }
    if (result.text.trim().length > 0) {
      // The model answered without writing anything: a settled no-op, exactly
      // like the one-shot engine's empty plan.
      plans.push({ memories: [], forget: [] })
    }
  }
  if (plans.length === 0) {
    // A silent loop that never wrote anything is not a settled boundary: let the
    // one-shot path retry once rather than advancing the cursor on nothing.
    return undefined
  }
  const plan = plans.length === 1 ? plans[0] : mergeExtractionPlans(plans)
  return { plan, turns, toolCalls, fromText }
}

/**
 * v0.4.0: the shared tail of every extraction engine — one guarded write pass,
 * the activity journal, the section refresh, the optional git commit and the
 * consolidation proposals. Returns the cursor status for this attempt.
 *
 * @param {object} plugin plugin instance
 * @param {object} record workspace record
 * @param {{ memories: Array<object>, forget: string[] }} plan
 * @param {{ policy: object }} snapshot
 * @param {string} label session label for logs
 * @param {string} note engine summary (`mode=… turns=…`)
 * @param {{ engine?: string, turns?: number, toolCalls?: number }} [meta]
 * @returns {Promise<'success' | 'no-op'>}
 */
async function settleExtraction(plugin, record, plan, snapshot, label, note, meta) {
  // The index reads inside applyExtraction and its final writes are
  // read-modify-write regions shared by every session of the workspace; the
  // per-root lock keeps two interleaved extractions from losing writes.
  const applied = await runWithWorkspaceLocks(
    plugin,
    [record.rootKey],
    'extraction ' + label,
    () => applyExtraction(plugin, record, plan, snapshot.policy),
  )
  // One line per settled extraction: this journal is the only trace of a
  // background request that never enters the session log, so it is debug-gated
  // like the skip lines — errors stay unconditional.
  debug(plugin, `extraction done for ${label}: ${note} memories=${plan.memories.length} forget=${plan.forget.length} applied=${String(applied.changed)}`)
  if (applied.changed) {
    recordActivity(record, applied, meta)
    // Roadmap C6: the workspace now holds memories this session did not see
    // at startup — invalidate and refill the cached section so the next turn
    // is injected with the fresh index. Fire-and-forget: the refresh holds
    // the workspace lock again, but the turn never waits for it.
    void refreshAgentSection(plugin, record)
    // Roadmap D7: a memory root that is already a git repository gets its
    // writes committed. Spawned detached — the turn never waits, and a missing
    // git binary or a non-repo root is a silent no-op.
    maybeGitCommit(plugin, record.memoryRoot, 'workspace-memory: extraction ' + label)
    // Roadmap D8: consolidation is a review artifact, produced only after the
    // memory directory crossed the fact threshold, and never applied automatically.
    try {
      await maybeWriteProposals(plugin, record, applied)
    } catch (error) {
      debug(plugin, 'consolidation proposals failed: ' + errorText(error))
    }
  }
  // W4: a parsed plan that changed nothing is still a settled boundary — the
  // same messages must not be re-extracted on every following turn.
  return applied.changed ? 'success' : 'no-op'
}

/**
 * Roadmap D6: fold the per-segment plans of one turn into one plan. A repeated
 * `name` keeps the latest segment's entry (a later statement supersedes an
 * earlier one) while the first-seen position keeps the index order stable; the
 * `forget` lists union in order and drop any name a later segment rewrites.
 * @param {Array<{ memories: Array<object>, forget: string[] }>} plans
 * @returns {{ memories: Array<object>, forget: string[] }}
 */
function mergeExtractionPlans(plans) {
  const byName = new Map()
  const forget = []
  const forgot = new Set()
  for (const plan of Array.isArray(plans) ? plans : []) {
    for (const memory of Array.isArray(plan?.memories) ? plan.memories : []) {
      const name = memory?.name
      if (typeof name !== 'string' || name.length === 0) continue
      byName.set(name, memory)
      forgot.delete(name)
    }
    for (const name of Array.isArray(plan?.forget) ? plan.forget : []) {
      if (typeof name !== 'string' || name.length === 0) continue
      forget.push(name)
      forgot.add(name)
    }
  }
  return { memories: [...byName.values()], forget: forget.filter((name) => forgot.has(name)) }
}

/** Planned fact file names (in reply order, valid names only). */
function planWroteNames(parsed) {  const memories = parsed && Array.isArray(parsed.memories) ? parsed.memories : []
  const names = []
  for (const memory of memories) {
    if (memory && isValidMemoryName(memory.name)) names.push(factFileName(memory.name))
  }
  return names
}

/** Planned forgotten file names (deduped, valid names only), as written to the reply. */
function planForgotNames(parsed) {
  const forget = parsed && Array.isArray(parsed.forget) ? parsed.forget : []
  return [...new Set(forget.filter((entry) => isValidMemoryName(entry)))].map(factFileName)
}

/** One-line summary the panel expands the diff under: counts + pointer delta. */
function describeExtractionDiff(parsed) {
  const wrote = planWroteNames(parsed).length
  const forgot = planForgotNames(parsed).length
  const parts = []
  if (wrote > 0) parts.push('+' + wrote)
  if (forgot > 0) parts.push('-' + forgot)
  return parts.join(' ')
}

/**
 * Apply outcome: whether disk moved plus what the panel activity entry needs.
 * `wrote`/`forgot` are file-name lists actually applied, `indexBefore` /
 * `indexAfter` the index texts around the swap (for the client diff), and
 * `diffSummary` the one-line counts. `layer` is always 'workspace' now that
 * memory is per-workspace; it stays in the shape for panel compatibility.
 */
function noExtractionChange() {
  return {
    changed: false,
    wrote: [],
    forgot: [],
    diffSummary: '',
    indexBefore: '',
    indexAfter: '',
    layer: '',
  }
}

/** Append one activity entry to the record's workspace buffer (ring, newest first). */
function recordActivity(record, entry, meta) {
  const key = normalizePathKey(record.memoryRoot)
  const list = workspaceActivities.get(key) ?? []
  const diffSummary = typeof entry.diffSummary === 'string' && entry.diffSummary !== '' ? entry.diffSummary : '(no index change)'
  const next = {
    at: Date.now(),
    workspace: record.root,
    wrote: Array.isArray(entry.wrote) ? entry.wrote : [],
    forgot: Array.isArray(entry.forgot) ? entry.forgot : [],
    diffSummary,
    indexBefore: typeof entry.indexBefore === 'string' ? entry.indexBefore : '',
    indexAfter: typeof entry.indexAfter === 'string' ? entry.indexAfter : '',
  }
  // v0.4.0: which engine produced this extraction and what it cost. Older
  // entries without these fields stay valid for the panel.
  if (meta && typeof meta === 'object') {
    if (meta.engine === 'agent' || meta.engine === 'json') next.engine = meta.engine
    if (Number.isSafeInteger(meta.turns)) next.turns = meta.turns
    if (Number.isSafeInteger(meta.toolCalls)) next.toolCalls = meta.toolCalls
  }
  list.unshift(next)
  if (list.length > ACTIVITY_KEEP) list.length = ACTIVITY_KEEP
  workspaceActivities.set(key, list)
  return next
}

/**
 * Route precedence: configured extraction route → request context → request
 * header → agent options → default. Roadmap D5: `extractProvider` /
 * `extractModel` pin the background extraction to its own model; an empty
 * field falls back to the session route it would otherwise have used, and
 * setting both works even when the session has no resolvable route.
 */
function extractRoute(plugin, record) {
  const session = record.session
  const agentDefaultModel = safeService(plugin.ctx, 'agentDefaultModel')
  const requestContext = callQuietly(() => (typeof session.requestContext === 'function' ? session.requestContext() : undefined))
  const requestHeader = callQuietly(() => (typeof session.requestHeader === 'function' ? session.requestHeader() : undefined))
  const resolved = pickRoute({
    requestContext,
    requestHeader,
    agentOptions: record.agent.options,
    defaultSelection: callQuietly(() => (
      agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
        ? agentDefaultModel.currentSelection()
        : undefined
    )),
  })
  const providerValue = cfg(plugin, 'extractProvider', '')
  const modelValue = cfg(plugin, 'extractModel', '')
  const configuredProvider = typeof providerValue === 'string' ? providerValue.trim() : ''
  const configuredModel = typeof modelValue === 'string' ? modelValue.trim() : ''
  if (configuredProvider === '' && configuredModel === '') return resolved
  if (resolved === undefined && (configuredProvider === '' || configuredModel === '')) return undefined
  return {
    provider: configuredProvider === '' ? resolved.provider : configuredProvider,
    model: configuredModel === '' ? resolved.model : configuredModel,
  }
}

/** Call a reader that may throw (fake sessions, absent services). */
function callQuietly(reader) {
  try {
    return reader()
  } catch (_ignored) {
    return undefined
  }
}

/**
 * Whether one directory entry is a bookkeeping entry rather than a memory file
 * (roadmap D8): `proposals/` and `trash/` live inside the memory root but are
 * never facts, never injected, never exported, and never repaired into the
 * index. Everything that scans a memory root for facts must use this guard.
 * @param {unknown} name entry name
 * @returns {boolean}
 */
function isNonFactEntry(name) {
  return typeof name === 'string' && NON_FACT_ENTRIES.has(name)
}

/**
 * Existing facts (name + description) for the extraction prompt. Memory is
 * per-workspace, so the manifest is always this session's own directory.
 */
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
    if (isNonFactEntry(entry.name)) continue
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

/**
 * v0.4.0: the tool-aware sibling of {@link collectStreamText}. It assembles the
 * same text while also collecting every `tool-call` block, and accepts the two
 * finish reasons a tool loop can end on: `stop` (a final answer) and
 * `tool-calls` (the model wants results before continuing).
 * @param {AsyncIterable<object>} stream chunk stream from `ctx.llm.stream`
 * @returns {Promise<{ ok: boolean, text: string, toolCalls: Array<{ id: string, name: string, arguments: string }>, reason?: string, detail?: string }>}
 */
async function collectStreamTurn(stream) {
  let text = ''
  const calls = new Map()
  let finishKind = ''
  let detail = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'tool-call-delta') {
      const key = typeof chunk.index === 'number' ? chunk.index : calls.size
      const current = calls.get(key) ?? { id: '', name: '', arguments: '' }
      if (typeof chunk.id === 'string' && chunk.id.length > 0) current.id = chunk.id
      if (typeof chunk.name === 'string' && chunk.name.length > 0) current.name = chunk.name
      if (typeof chunk.argumentsDelta === 'string') current.arguments += chunk.argumentsDelta
      calls.set(key, current)
      continue
    }
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
      const key = typeof chunk.index === 'number' ? chunk.index : calls.size
      const block = chunk.block
      calls.set(key, {
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        arguments: typeof block.arguments === 'string' ? block.arguments : '',
      })
      continue
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason
      finishKind = reason && typeof reason.kind === 'string' ? reason.kind : ''
      detail = reason && reason.failure && typeof reason.failure.message === 'string' ? reason.failure.message : ''
    }
  }
  const toolCalls = [...calls.values()].filter((call) => call.name.length > 0)
  if (finishKind !== 'stop' && finishKind !== 'tool-calls') {
    return { ok: false, text: '', toolCalls: [], reason: finishKind === '' ? 'no-finish' : finishKind, detail }
  }
  return { ok: true, text, toolCalls }
}

/**
 * v0.4.0: one loop turn — a model request carrying the tool schemas, resolved
 * into text plus requested calls. Failures are values so the loop can stop
 * cleanly and the caller can fall back to the one-shot path.
 * @param {object} plugin plugin instance
 * @param {object} record workspace record
 * @param {{ provider: string, model: string }} route
 * @param {{ messages: object[], tools: Array<object>, system?: string }} request
 * @returns {Promise<{ ok: boolean, text?: string, toolCalls?: Array<object>, reason?: string, detail?: string }>}
 */
async function callAgentTurn(plugin, record, route, request) {
  const llm = safeService(plugin.ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'no-llm', detail: 'ctx.llm is unavailable' }
  }
  const linked = createLinkedSignal([plugin.controller.signal, record.abort.signal])
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      system: typeof request.system === 'string' ? request.system : memoryRulesText(record.memoryRoot),
      messages: request.messages,
      tools: request.tools,
      maxTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    }
    if (record.sessionId !== undefined) options.sessionId = record.sessionId
    if (linked.signal !== undefined) options.signal = linked.signal
    return await collectStreamTurn(llm.stream(options))
  } catch (error) {
    return { ok: false, reason: 'error', detail: errorText(error) }
  } finally {
    linked.dispose()
  }
}

/**
 * Write one parsed extraction plan through `ctx.fs` under the session policy.
 *
 * Memory is per-workspace: one plan, one root, one staged pipeline. Stage order
 * matters: every fact file first, then the index, then the deletes. A failure
 * at any stage aborts the batch — the index never references a fact that was
 * not written, and forgotten files are only trashed once their pointers are
 * gone from the index.
 */
async function applyExtraction(plugin, record, parsed, policy) {
  if (isMinimalSession(record.session)) return noExtractionChange()
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function') return noExtractionChange()

  const linked = createLinkedSignal([plugin.controller.signal, record.abort.signal])
  const outcome = noExtractionChange()
  try {
    if (typeof record.memoryRoot !== 'string' || record.memoryRoot.length === 0) return outcome
    const applied = await applyWorkspaceExtraction(
      plugin,
      record,
      fs,
      { root: record.memoryRoot, plan: parsed },
      policy,
      linked.signal,
    )
    if (!applied.changed) return outcome
    outcome.changed = true
    outcome.layer = 'workspace'
    outcome.wrote.push(...applied.wrote)
    outcome.forgot.push(...applied.forgot)
    outcome.indexBefore = applied.indexBefore
    outcome.indexAfter = applied.indexAfter
    if (outcome.changed) {
      outcome.diffSummary = describeExtractionDiff({
        memories: outcome.wrote.map((fileName) => ({ name: parseFactFileName(fileName) })),
        forget: outcome.forgot.map((fileName) => parseFactFileName(fileName) ?? fileName),
      })
      await trimTrash(plugin, record.memoryRoot)
    }
  } finally {
    linked.dispose()
  }
  return outcome
}

/**
 * The staged write pipeline for the workspace's memory root: read its index,
 * plan against its own facts, write facts → swap index → trash the forgets.
 */
async function applyWorkspaceExtraction(plugin, record, fs, target, policy, signal) {
  const outcome = noExtractionChange()
  const label = 'workspace memory'
  const indexState = await readIndexState(plugin, record, undefined, target.root)
  if (indexState.status === 'error') {
    // An unreadable index is NOT an empty one: upsertPointer would then rewrite
    // MEMORY.md with only this run's pointers and drop every other line.
    log('extraction aborted for ' + (record.sessionId ?? '(unknown)') + ' (' + label + '): index unreadable (' + indexState.detail + ')')
    return outcome
  }
  const currentIndex = indexState.text

  const files = {}
  for (const memory of target.plan.memories) {
    if (!memory || !isValidMemoryName(memory.name)) continue
    const fileName = factFileName(memory.name)
    if (Object.hasOwn(files, fileName)) continue
    const content = await readMemoryFileText(fs, target.root, fileName)
    files[fileName] = content === undefined ? '' : content
  }

  const plan = planExtractionWrites({
    parsed: target.plan,
    files,
    indexText: currentIndex,
    sessionId: record.sessionId ?? '',
  })
  if (plan === undefined) return outcome

  // Stage 1: write every fact. Any failure aborts the batch before the
  // index or the deletes move; facts already written stay on disk without
  // a pointer and the next repairIndex run links them back in.
  for (const write of plan.writes) {
    const path = safeMemoryPath(target.root, write.fileName)
    const resolved = path === undefined ? undefined : await resolveTarget(fs, path)
    if (resolved === undefined) {
      log('extraction aborted for ' + (record.sessionId ?? '(unknown)') + ' (' + label + '): cannot resolve ' + write.fileName)
      return outcome
    }
    try {
      await fs.writeText(resolved, write.content, undefined, signal, policy)
      outcome.wrote.push(write.fileName)
      outcome.changed = true
    } catch (error) {
      log('extraction aborted for ' + (record.sessionId ?? '(unknown)') + ' (' + label + '): failed to write ' + write.fileName + ' (' + errorText(error) + ')')
      return outcome
    }
  }
  // Stage 2: swap the index. A refusal or a failed write also skips the
  // deletes — trashing a file while its pointer survives in the index
  // would leave a dangling pointer.
  if (plan.indexChanged) {
    const verdict = evaluateIndexReplacement(currentIndex, plan.indexText, plan.deletes, plan.writes.map((write) => write.fileName))
    if (!verdict.ok) {
      log('index write refused for ' + (record.sessionId ?? '(unknown)') + ' (' + label + '): ' + verdict.reason)
      return outcome
    }
    const indexTarget = await resolveTarget(fs, indexPath(target.root))
    if (indexTarget === undefined) {
      log('extraction aborted for ' + (record.sessionId ?? '(unknown)') + ' (' + label + '): cannot resolve MEMORY.md')
      return outcome
    }
    // Keep one rollback copy of the index before it is replaced.
    const backupTarget = await resolveTarget(fs, join(target.root, 'MEMORY.md.prev'))
    if (backupTarget !== undefined && currentIndex.length > 0) {
      try {
        await fs.writeText(backupTarget, currentIndex, undefined, signal, policy)
      } catch (error) {
        debug(plugin, 'failed to back up MEMORY.md: ' + errorText(error))
      }
    }
    try {
      await fs.writeText(indexTarget, plan.indexText, undefined, signal, policy)
      outcome.indexBefore = currentIndex
      outcome.indexAfter = plan.indexText
      outcome.changed = true
    } catch (error) {
      log('extraction aborted for ' + (record.sessionId ?? '(unknown)') + ' (' + label + '): failed to update MEMORY.md (' + errorText(error) + ')')
      return outcome
    }
  }
  // Stage 3: the deletes. Their pointers are already gone from the index.
  // Forgetting is exact-match: a name only disappears when this memory root
  // actually holds the file.
  for (const fileName of plan.deletes) {
    if (await forgetToTrash(plugin, fs, target.root, fileName, signal, policy)) {
      outcome.forgot.push(fileName)
      outcome.changed = true
    }
  }
  return outcome
}

/* --------------------------------- export / import / consolidation (D7, D8) */

/** Deadline for reading every fact's frontmatter while building proposals. */
const PROPOSAL_READ_BUDGET_MS = 20000

/**
 * Filesystem-safe stamp for an export directory name: ISO timestamps carry `:`
 * (and a `.` before the milliseconds), which Windows rejects inside a file name.
 * @param {unknown} at ISO timestamp
 * @returns {string}
 */
function exportStamp(at) {
  const iso = typeof at === 'string' && at.length > 0 ? at : nowIsoTimestamp()
  return iso.replace(/:/gu, '-').replace(/\./gu, '-')
}

/** Content digest attached to every exported file. @param {string} text */
function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The one memory root a catalog/export/import call may touch, resolved from the
 * session's visible workspaces. Memory is per-workspace: the request names a
 * workspace path and the only root that can come back is that workspace's
 * `<workspaceRoot>/.dsh/memory`.
 * @param {object} plugin
 * @param {object} payload RPC payload carrying `path`
 */
function snapshotRootFor(plugin, payload) {
  const requested = typeof payload?.path === 'string' ? payload.path.trim() : ''
  if (requested.length === 0) return { error: failure('invalid-path', 'path is required') }
  const key = normalizePathKey(requested)
  for (const candidate of collectWorkspaceCandidates(plugin, sourceSessionId(payload))) {
    if (normalizePathKey(candidate.path) !== key) continue
    return { root: memoryRoot(candidate.path) }
  }
  return { error: failure('unknown-path', 'workspace is not visible to this session') }
}

/**
 * Read one memory root's exportable files (index + facts) through the filesystem
 * seam. `proposals/` and `trash/` are bookkeeping, never part of a snapshot.
 * @returns {Promise<Array<{ name: string, kind: string, content: string }>>}
 */
async function collectExportFiles(plugin, fs, root) {
  const rootTarget = await resolveTarget(fs, root)
  if (rootTarget === undefined || typeof fs.listDir !== 'function') return []
  let entries
  try {
    entries = await fs.listDir(rootTarget)
  } catch (_error) {
    return []
  }
  const files = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (isNonFactEntry(entry.name)) continue
    const kind = isIndexFile(entry.name) ? 'index' : parseFactFileName(entry.name) === undefined ? undefined : 'fact'
    if (kind === undefined) continue
    if (files.length >= EXPORT_MAX_FILES) break
    const content = await readMemoryFileText(fs, root, entry.name)
    if (content === undefined) {
      debug(plugin, 'export skipped unreadable file ' + entry.name + ' in ' + root)
      continue
    }
    files.push({ name: entry.name, kind, content })
  }
  return files
}

/**
 * Roadmap D7: write one snapshot directory
 * `<targetDir>/workspace-memory-export-<iso>/` holding `workspace/MEMORY.md`,
 * the fact files, and `manifest.json`. Zero dependencies: plain files copied by
 * the Host, no archiver.
 * @param {object} plugin
 * @param {object} payload `{ path, targetDir }`
 */
async function exportMemory(plugin, payload) {
  if (!isEnabled(plugin)) return failure('disabled', PKG + ' is disabled')
  const resolved = snapshotRootFor(plugin, payload)
  if (resolved.error !== undefined) return resolved.error
  const targetDir = typeof payload?.targetDir === 'string' ? payload.targetDir.trim() : ''
  if (targetDir.length === 0) return failure('invalid-target', 'targetDir is required')
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.readText !== 'function') return failure('unavailable', 'filesystem service is unavailable')
  const createdAt = nowIsoTimestamp()
  const dir = join(targetDir, EXPORT_DIR_PREFIX + exportStamp(createdAt))
  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    createdAt,
    source: { workspace: typeof payload?.path === 'string' ? payload.path : '' },
    layers: [],
  }
  try {
    await mkdir(dir, { recursive: true })
    const files = await collectExportFiles(plugin, fs, resolved.root)
    if (files.length > 0) {
      const layerDir = join(dir, 'workspace')
      await mkdir(layerDir, { recursive: true })
      const written = []
      for (const file of files) {
        await writeFile(join(layerDir, file.name), file.content, 'utf8')
        written.push({
          name: file.name,
          kind: file.kind,
          bytes: Buffer.byteLength(file.content, 'utf8'),
          sha256: sha256Text(file.content),
        })
      }
      manifest.layers.push({ layer: 'workspace', root: resolved.root, files: written })
    }
    await writeFile(join(dir, EXPORT_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  } catch (error) {
    return failure('export-failed', 'failed to write the snapshot', { dir, detail: errorText(error) })
  }
  const fileCount = manifest.layers.reduce((total, layer) => total + layer.files.length, 0)
  debug(plugin, 'export wrote ' + fileCount + ' files to ' + dir)
  return {
    ok: true,
    value: {
      dir,
      manifestPath: join(dir, EXPORT_MANIFEST_FILE),
      createdAt,
      fileCount,
      layers: manifest.layers.map((layer) => ({ layer: layer.layer, root: layer.root, files: layer.files.length })),
    },
  }
}

/**
 * One manifest entry's problem, or `undefined` when it is well-formed.
 * Memory is per-workspace, so the only entry kind a snapshot carries is
 * `workspace`. Validation is pure: it never touches the destination root.
 * @param {unknown} entry
 * @returns {string | undefined}
 */
function manifestLayerProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'memory entry is not an object'
  if (entry.layer !== 'workspace') return 'unknown memory kind: ' + String(entry.layer)
  if (!Array.isArray(entry.files) || entry.files.length === 0) return 'layer ' + entry.layer + ' carries no files'
  if (entry.files.length > EXPORT_MAX_FILES) return 'layer ' + entry.layer + ' carries too many files'
  const seen = new Set()
  for (const file of entry.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return 'invalid file entry in layer ' + entry.layer
    const name = file.name
    if (typeof name !== 'string' || name.length === 0) return 'file entry without a name in layer ' + entry.layer
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return 'unsafe file name: ' + name
    if (!isIndexFile(name) && parseFactFileName(name) === undefined) return 'not a memory file name: ' + name
    if (seen.has(name)) return 'duplicate file name in layer ' + entry.layer + ': ' + name
    seen.add(name)
    const kind = isIndexFile(name) ? 'index' : 'fact'
    if (file.kind !== kind) return 'kind mismatch for ' + name + ' (expected ' + kind + ')'
    if (file.sha256 !== undefined && typeof file.sha256 !== 'string') return 'invalid sha256 for ' + name
    if (file.bytes !== undefined && typeof file.bytes !== 'number') return 'invalid byte count for ' + name
  }
  return undefined
}

/**
 * Roadmap D7: import one snapshot written by `exportMemory`. The manifest is
 * validated and every file is read before the first write, so a bad snapshot
 * leaves the memory roots untouched. Writes reuse the unified guarded path:
 * per-root mutex, content diff (identical files are skipped, not rewritten),
 * `MEMORY.md.prev` backup, and trash (never delete) on conflicts.
 * @param {object} plugin
 * @param {object} payload `{ path, dir, layers? }`
 */
async function importMemory(plugin, payload) {
  if (!isEnabled(plugin)) return failure('disabled', PKG + ' is disabled')
  const resolved = snapshotRootFor(plugin, payload)
  if (resolved.error !== undefined) return resolved.error
  const dir = typeof payload?.dir === 'string' ? payload.dir.trim() : ''
  if (dir.length === 0) return failure('invalid-source', 'dir is required')
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function' || typeof fs.readText !== 'function') {
    return failure('unavailable', 'filesystem service is unavailable')
  }
  // Phase 1 — read and validate everything. No writes happen below this point.
  let manifestText
  try {
    manifestText = await readFile(join(dir, EXPORT_MANIFEST_FILE), 'utf8')
  } catch (error) {
    return failure('invalid-manifest', 'manifest.json is missing or unreadable', { dir, detail: errorText(error) })
  }
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (_error) {
    return failure('invalid-manifest', 'manifest.json is not valid JSON', { dir })
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return failure('invalid-manifest', 'manifest.json is not an object', { dir })
  }
  if (manifest.format !== EXPORT_FORMAT) {
    return failure('invalid-manifest', 'unexpected format: ' + String(manifest.format), { dir })
  }
  if (manifest.version !== EXPORT_VERSION) {
    return failure('invalid-manifest', 'unsupported manifest version: ' + String(manifest.version), { dir })
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    return failure('invalid-manifest', 'manifest carries no memory files', { dir })
  }
  for (const listed of manifest.layers) {
    const problem = manifestLayerProblem(listed)
    if (problem !== undefined) return failure('invalid-manifest', problem, { dir })
  }
  const byLayer = new Map()
  for (const entry of manifest.layers) byLayer.set(entry.layer, entry)
  let staged
  const entry = byLayer.get('workspace')
  if (entry !== undefined) {
    const files = []
    for (const file of entry.files) {
      let content
      try {
        content = await readFile(join(dir, 'workspace', file.name), 'utf8')
      } catch (error) {
        return failure('invalid-snapshot', 'missing file in snapshot: ' + file.name, { dir, detail: errorText(error) })
      }
      if (typeof file.sha256 === 'string' && file.sha256 !== sha256Text(content)) {
        return failure('invalid-snapshot', 'checksum mismatch for ' + file.name, { dir })
      }
      files.push({ name: file.name, content })
    }
    staged = { root: resolved.root, files }
  }
  if (staged === undefined) return failure('nothing-to-import', 'the snapshot carries no workspace memory this session can import', { dir })

  const record = plugin.bySession.get(sourceSessionId(payload)) ?? { session: { header: { cwd: resolved.root } } }
  if (record.readOnly === true) return failure('read-only', 'this memory is read-only')
  const gate = resolvePolicy(plugin, record)
  if (gate !== undefined && gate.writable !== true) return failure('read-only', 'the sandbox policy forbids writes')
  const policy = gate === undefined ? undefined : gate.policy
  const signal = plugin.controller.signal

  // Phase 2 — apply through the guarded write path under the workspace lock.
  const keys = [normalizePathKey(resolved.root)]
  return runWithWorkspaceLocks(plugin, keys, 'import', async () => {
    const outcome = { root: staged.root, applied: [], skipped: [], trashed: [], failed: [] }
    const finish = () => {
      trimTrash(plugin, staged.root)
      void refreshAgentSection(plugin, record)
      return {
        ok: true,
        value: {
          dir,
          layers: [outcome],
          applied: outcome.applied.length,
          skipped: outcome.skipped.length,
          failed: outcome.failed.length,
        },
      }
    }
    try {
      await mkdir(staged.root, { recursive: true })
    } catch (error) {
      outcome.failed.push({ name: '*', reason: errorText(error) })
      return finish()
    }
    for (const file of staged.files) {
      const state = await readFileState(fs, join(staged.root, file.name), signal)
      if (state.status === 'error') {
        outcome.failed.push({ name: file.name, reason: state.detail ?? 'unreadable' })
        continue
      }
      if (state.status === 'ok' && state.text === file.content) {
        outcome.skipped.push(file.name)
        continue
      }
      if (state.status === 'ok') {
        if (isIndexFile(file.name)) {
          const backupTarget = await resolveTarget(fs, join(staged.root, 'MEMORY.md.prev'), signal)
          if (backupTarget !== undefined) {
            try {
              await fs.writeText(backupTarget, state.text, undefined, signal, policy)
            } catch (error) {
              debug(plugin, 'import failed to back up MEMORY.md: ' + errorText(error))
            }
          }
        } else if (!(await forgetToTrash(plugin, fs, staged.root, file.name, signal, policy))) {
          outcome.failed.push({ name: file.name, reason: 'could not move the existing file to trash' })
          continue
        }
        if (!isIndexFile(file.name)) outcome.trashed.push(file.name)
      }
      const target = await resolveTarget(fs, join(staged.root, file.name), signal)
      if (target === undefined) {
        outcome.failed.push({ name: file.name, reason: 'path could not be resolved' })
        continue
      }
      try {
        await fs.writeText(target, file.content, undefined, signal, policy)
        outcome.applied.push(file.name)
      } catch (error) {
        outcome.failed.push({ name: file.name, reason: errorText(error) })
      }
    }
    if (outcome.applied.length > 0 || outcome.trashed.length > 0) {
      maybeGitCommit(plugin, staged.root, 'workspace-memory: import ' + outcome.applied.length + ' file(s)')
    }
    return finish()
  })
}

/**
 * Roadmap D7: commit a memory root that is ALREADY a git repository. Never runs
 * `git init`, never blocks the turn (the child is detached with stdio ignored),
 * and any failure is only logged: git is a convenience, never a dependency.
 * @param {object} plugin
 * @param {string} root memory root
 * @param {string} message commit subject
 * @returns {boolean} whether a commit was attempted
 */
function maybeGitCommit(plugin, root, message) {
  if (!isTrue(cfg(plugin, 'gitCommitEnabled', true))) return false
  if (typeof root !== 'string' || root.length === 0) return false
  try {
    if (!statSync(join(root, '.git')).isDirectory()) return false
  } catch (_error) {
    return false
  }
  const subject = typeof message === 'string' && message.length > 0 ? message : 'workspace-memory: update'
  /** Run one git command detached; only failures are logged. */
  const run = (args, label) => {
    let child
    try {
      child = spawn('git', ['-C', root, ...args], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      debug(plugin, 'git ' + label + ' could not start: ' + errorText(error))
      return undefined
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_error) {
        // The child already exited.
      }
    }, GIT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (error) => {
      clearTimeout(timer)
      debug(plugin, 'git ' + label + ' failed: ' + errorText(error))
    })
    if (typeof child.unref === 'function') child.unref()
    return child
  }
  const add = run(['add', '-A'], 'add')
  if (add === undefined) return false
  add.on('exit', (code) => {
    if (code !== 0) {
      debug(plugin, 'git add exited ' + String(code) + ' in ' + root)
      return
    }
    const commit = run(['commit', '-m', subject, '--no-verify'], 'commit')
    if (commit === undefined) return
    commit.on('exit', (commitCode) => {
      if (commitCode !== 0) debug(plugin, 'git commit exited ' + String(commitCode) + ' in ' + root)
    })
  })
  return true
}

/** Count the fact files one memory root holds; `proposals/` and `trash/` excluded. */
async function countFactsIn(plugin, fs, root) {
  const target = await resolveTarget(fs, root)
  if (target === undefined || typeof fs.listDir !== 'function') return 0
  let entries
  try {
    entries = await fs.listDir(target)
  } catch (_error) {
    return 0
  }
  let count = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (isNonFactEntry(entry.name)) continue
    if (parseFactFileName(entry.name) === undefined) continue
    count += 1
  }
  return count
}

/**
 * Frontmatter of every fact in one root, deadline-bounded: a proposal is a
 * review artifact, so a slow read yields a partial (still useful) picture
 * rather than blocking the pass.
 * @returns {Promise<Array<{ name: string, description: string, type: string, updatedAt: string, lastAccessedAt: string }>>}
 */
async function readFactStats(fs, root, budgetMs) {
  const target = await resolveTarget(fs, root)
  if (target === undefined || typeof fs.listDir !== 'function') return []
  let entries
  try {
    entries = await fs.listDir(target)
  } catch (_error) {
    return []
  }
  const deadline = Date.now() + (typeof budgetMs === 'number' ? budgetMs : PROPOSAL_READ_BUDGET_MS)
  const facts = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
    if (isNonFactEntry(entry.name)) continue
    const name = parseFactFileName(entry.name)
    if (name === undefined) continue
    if (Date.now() > deadline) break
    const text = await readMemoryFileText(fs, root, entry.name)
    if (text === undefined) continue
    const meta = parseFactFrontmatter(text)
    facts.push({
      name,
      description: typeof meta?.description === 'string' ? meta.description : '',
      type: typeof meta?.type === 'string' ? meta.type : '',
      updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : '',
      lastAccessedAt: typeof meta?.lastAccessedAt === 'string' ? meta.lastAccessedAt : '',
    })
  }
  return facts
}

/**
 * Write one consolidation proposal file under `<root>/proposals/`.
 * @returns {Promise<{ layer: string, root: string, fileName: string, factCount: number, counts: object } | undefined>}
 */
async function writeProposalFile(plugin, fs, root, facts, policy) {
  const createdAt = nowIsoTimestamp()
  const layer = 'workspace'
  const nearDuplicates = findNearDuplicateClusters(facts.map((fact) => fact.name))
  const contradictions = findContradictionCandidates(facts)
  const stale = selectStaleFacts(facts, Date.now(), PROPOSAL_STALE_DAYS)
  const fileName = proposalFileName(createdAt)
  const text = renderProposalFile({
    createdAt,
    layer,
    root,
    factCount: facts.length,
    threshold: PROPOSAL_FACT_THRESHOLD,
    nearDuplicates,
    contradictions,
    stale,
  })
  const dir = proposalsDirPath(root)
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    debug(plugin, 'could not create ' + dir + ': ' + errorText(error))
    return undefined
  }
  const target = await resolveTarget(fs, join(dir, fileName), plugin.controller.signal)
  if (target === undefined) return undefined
  try {
    await fs.writeText(target, text, undefined, plugin.controller.signal, policy)
  } catch (error) {
    debug(plugin, 'could not write proposal ' + fileName + ': ' + errorText(error))
    return undefined
  }
  return {
    layer,
    root,
    fileName,
    factCount: facts.length,
    counts: { nearDuplicates: nearDuplicates.length, contradictions: contradictions.length, stale: stale.length },
  }
}

/**
 * Roadmap D8: after a successful extraction, a memory root that crossed the
 * fact threshold gets a fresh proposal file. Never auto-applied; a review
 * artifact.
 * @returns {Promise<Array<object>>} proposals written (empty below threshold)
 */
async function maybeWriteProposals(plugin, record, applied) {
  if (record.readOnly === true) return []
  if (!Array.isArray(applied?.wrote) && !Array.isArray(applied?.forgot)) return []
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.listDir !== 'function' || typeof fs.writeText !== 'function') return []
  const gate = resolvePolicy(plugin, record)
  if (gate !== undefined && gate.writable !== true) return []
  const policy = gate === undefined ? undefined : gate.policy
  const written = []
  const root = record.memoryRoot
  if (typeof root === 'string' && root.length > 0) {
    const factCount = await countFactsIn(plugin, fs, root)
    if (factCount > PROPOSAL_FACT_THRESHOLD) {
      const facts = await readFactStats(fs, root, PROPOSAL_READ_BUDGET_MS)
      if (facts.length > 0) {
        const proposal = await writeProposalFile(plugin, fs, root, facts, policy)
        if (proposal !== undefined) written.push(proposal)
      }
    }
  }
  if (written.length > 0) {
    debug(plugin, 'consolidation proposals written: ' + written.map((entry) => entry.fileName).join(', '))
  }
  return written
}

/** Read one proposal file's text through the seam. @returns {Promise<string | undefined>} */
async function readProposalText(fs, root, name, signal) {
  const state = await readFileState(fs, join(proposalsDirPath(root), name), signal)
  return state.status === 'ok' ? state.text : undefined
}

/**
 * Roadmap D8 list endpoint: every proposal file of the workspace's memory,
 * newest first, with the machine-readable summary (counts + accepted marker).
 * @param {object} plugin
 * @param {object} payload `{ path }`
 */
async function listProposals(plugin, payload) {
  if (!isEnabled(plugin)) return failure('disabled', PKG + ' is disabled')
  const resolved = snapshotRootFor(plugin, payload)
  if (resolved.error !== undefined) return resolved.error
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.readText !== 'function' || typeof fs.listDir !== 'function') {
    return failure('unavailable', 'filesystem service is unavailable')
  }
  const signal = plugin.controller.signal
  const proposals = []
  const target = { root: resolved.root }
  const dirTarget = await resolveTarget(fs, proposalsDirPath(target.root), signal)
  if (dirTarget !== undefined) {
    let entries
    try {
      entries = await fs.listDir(dirTarget)
    } catch (_error) {
      entries = []
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.name !== 'string' || entry.type !== 'file') continue
      if (!isProposalFileName(entry.name)) continue
      const text = await readProposalText(fs, target.root, entry.name, signal)
      if (text === undefined) continue
      const parsed = parseProposalFile(text)
      proposals.push({
        layer: 'workspace',
        root: target.root,
        name: entry.name,
        createdAt: parsed?.createdAt ?? '',
        factCount: parsed?.factCount ?? 0,
        threshold: parsed?.threshold ?? PROPOSAL_FACT_THRESHOLD,
        counts: parsed?.counts ?? { nearDuplicates: 0, contradictions: 0, stale: 0 },
        acceptedAt: parsed?.acceptedAt ?? '',
        items: parsed?.items ?? [],
      })
    }
  }
  proposals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return {
    ok: true,
    value: {
      proposals,
      layers: [{ layer: 'workspace', root: resolved.root }],
      threshold: PROPOSAL_FACT_THRESHOLD,
    },
  }
}

/** Mark one proposal file accepted, keeping its prose intact. */
function markProposalAccepted(text, acceptedAt, dropped) {
  const markerPattern = /```json\n([\s\S]*?)\n```/u
  const match = markerPattern.exec(text)
  if (match === null) return undefined
  let marker
  try {
    marker = JSON.parse(match[1])
  } catch (_error) {
    return undefined
  }
  if (!marker || typeof marker !== 'object') return undefined
  marker.acceptedAt = acceptedAt
  marker.acceptedItems = dropped
  const withoutMarker = text.replace(markerPattern, '').replace(/\s+$/u, '')
  return withoutMarker + '\n\n' + '```json\n' + JSON.stringify(marker, null, 2) + '\n```\n'
}

/**
 * Roadmap D8 accept endpoint: apply the near-duplicate drops of ONE proposal
 * through the guarded write path. The proposal file is marked accepted; the
 * drops are index pointers removed plus files moved to trash. Contradiction and
 * stale sections stay informational: they need a human decision.
 * @param {object} plugin
 * @param {object} payload `{ path, name, keep? }`
 */
async function acceptProposal(plugin, payload) {
  if (!isEnabled(plugin)) return failure('disabled', PKG + ' is disabled')
  const resolved = snapshotRootFor(plugin, payload)
  if (resolved.error !== undefined) return resolved.error
  const name = typeof payload?.name === 'string' ? payload.name : ''
  if (!isProposalFileName(name)) return failure('invalid-proposal', 'name is not a proposal file name')
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function' || typeof fs.readText !== 'function') {
    return failure('unavailable', 'filesystem service is unavailable')
  }
  const record = plugin.bySession.get(sourceSessionId(payload)) ?? { session: { header: { cwd: resolved.root } } }
  if (record.readOnly === true) return failure('read-only', 'this memory is read-only')
  const gate = resolvePolicy(plugin, record)
  if (gate !== undefined && gate.writable !== true) return failure('read-only', 'the sandbox policy forbids writes')
  const policy = gate === undefined ? undefined : gate.policy
  const signal = plugin.controller.signal

  // Locate the proposal file under the workspace's memory root before locking.
  const located = { root: resolved.root, layer: 'workspace' }
  const text = await readProposalText(fs, located.root, name, signal)
  if (text === undefined) return failure('not-found', 'no such proposal: ' + name)
  const parsed = parseProposalFile(text)
  if (parsed === undefined) return failure('invalid-proposal', 'the proposal marker is unreadable')
  if (typeof parsed.acceptedAt === 'string' && parsed.acceptedAt.length > 0) {
    return failure('already-accepted', 'this proposal was accepted at ' + parsed.acceptedAt)
  }
  const pairs = parsed.items.filter((item) => Array.isArray(item.drop) && item.drop.length > 0)
  if (pairs.length === 0) return failure('nothing-to-accept', 'the proposal carries no near-duplicate drops')

  const root = located.root
  const key = normalizePathKey(root)
  return runWithWorkspaceLocks(plugin, [key], 'accept proposal', async () => {
    const indexState = await readFileState(fs, join(root, INDEX_FILE), signal)
    if (indexState.status === 'error') {
      return failure('index-unreadable', 'could not read MEMORY.md', { detail: indexState.detail ?? '' })
    }
    const before = indexState.status === 'ok' ? indexState.text : ''
    const drops = []
    for (const pair of pairs) {
      const keepFile = typeof payload?.keep === 'string' && payload.keep.length > 0 ? payload.keep : pair.keep
      const keepText = await readMemoryFileText(fs, root, factFileName(keepFile), signal)
      if (keepText === undefined) {
        debug(plugin, 'proposal ' + name + ': keeping ' + keepFile + ' is impossible (missing), skipping its drops')
        continue
      }
      for (const dropName of pair.drop) {
        if (parseFactFileName(factFileName(dropName)) === undefined) continue
        if (drops.includes(dropName)) continue
        drops.push(dropName)
      }
    }
    if (drops.length === 0) return failure('nothing-to-accept', 'no droppable name survived validation')
    let after = before
    for (const dropName of drops) after = removePointer(after, factFileName(dropName))
    const verdict = evaluateIndexReplacement(before, after, drops.map((dropName) => factFileName(dropName)), [])
    if (verdict.ok !== true) {
      return failure('write-refused', verdict.reason ?? 'the index guard rejected the drop', { drops })
    }
    if (before.length > 0) {
      const backupTarget = await resolveTarget(fs, join(root, 'MEMORY.md.prev'), signal)
      if (backupTarget !== undefined) {
        try {
          await fs.writeText(backupTarget, before, undefined, signal, policy)
        } catch (error) {
          debug(plugin, 'acceptProposal failed to back up MEMORY.md: ' + errorText(error))
        }
      }
    }
    if (after !== before) {
      const indexTarget = await resolveTarget(fs, join(root, INDEX_FILE), signal)
      if (indexTarget === undefined) return failure('write-failed', 'could not resolve MEMORY.md')
      try {
        await fs.writeText(indexTarget, after, undefined, signal, policy)
      } catch (error) {
        return failure('write-failed', errorText(error))
      }
    }
    const forgotten = []
    for (const dropName of drops) {
      if (await forgetToTrash(plugin, fs, root, factFileName(dropName), signal, policy)) forgotten.push(dropName)
    }
    trimTrash(plugin, root)
    const acceptedAt = nowIsoTimestamp()
    const marked = markProposalAccepted(text, acceptedAt, forgotten)
    const proposalTarget = await resolveTarget(fs, join(proposalsDirPath(root), name), signal)
    if (marked !== undefined && proposalTarget !== undefined) {
      try {
        await fs.writeText(proposalTarget, marked, undefined, signal, policy)
      } catch (error) {
        debug(plugin, 'could not mark ' + name + ' accepted: ' + errorText(error))
      }
    }
    maybeGitCommit(plugin, root, 'workspace-memory: accept ' + name)
    void refreshAgentSection(plugin, record)
    return {
      ok: true,
      value: { proposal: name, layer: located.layer, root, acceptedAt, dropped: forgotten, kept: drops.length - forgotten.length },
    }
  })
}

/* ------------------------------------------------- panel fact CRUD + trash */

/** Longest description one panel-written fact may carry (characters). */
const FACT_DESCRIPTION_MAX = 300
/** Longest body one panel-written fact may carry (characters). */
const FACT_BODY_MAX = 20000
/** Trash entries one `trash-list` response carries. */
const TRASH_LIST_MAX = 100

/**
 * Fact slug for a payload field that may carry the slug (`prefers-tabs`) or the
 * file name (`prefers-tabs.md`). Undefined when it is neither, so no caller can
 * smuggle a filesystem path through the name field.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function factSlugFrom(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) return undefined
  if (isIndexFile(raw)) return undefined
  if (raw.endsWith('.md')) return parseFactFileName(raw)
  return isValidMemoryName(raw) ? raw : undefined
}

/** Trimmed string payload field, or undefined when the field is not a string. */
function trimmedField(value) {
  return typeof value === 'string' ? value.trim() : undefined
}

/** Pointer count of one index text. */
function pointerCountOf(text) {
  return parseIndexPointers(text).length
}

/**
 * Shared preamble for the panel's fact endpoints: the switch, workspace
 * resolution against what this session may see, the fs seam and the sandbox
 * policy. `payload.path` is only ever matched against known workspace roots.
 * @param {object} plugin
 * @param {object} payload
 * @param {boolean} [needsWrite] enforce the read-only gates
 * @returns {{ root: string, fs: object, record: object, tracked: boolean,
 *   policy: object | undefined, signal: AbortSignal, key: string } | { error: object }}
 */
function factContext(plugin, payload, needsWrite) {
  if (!isEnabled(plugin)) return { error: failure('disabled', PKG + ' is disabled') }
  const resolved = snapshotRootFor(plugin, payload)
  if (resolved.error !== undefined) return { error: resolved.error }
  const fs = safeService(plugin.ctx, 'fs')
  if (!fs || typeof fs.writeText !== 'function' || typeof fs.readText !== 'function') {
    return { error: failure('unavailable', 'filesystem service is unavailable') }
  }
  const sessionId = sourceSessionId(payload)
  const tracked = plugin.bySession.get(sessionId)
  const record = tracked ?? { session: { header: { cwd: resolved.root } }, memoryRoot: resolved.root }
  if (needsWrite === true) {
    if (record.readOnly === true) return { error: failure('read-only', 'this memory is read-only') }
    const gate = resolvePolicy(plugin, record)
    if (gate !== undefined && gate.writable !== true) {
      return { error: failure('read-only', 'the sandbox policy forbids writes to this memory') }
    }
    return {
      root: resolved.root,
      fs,
      record,
      tracked: tracked !== undefined,
      policy: gate === undefined ? undefined : gate.policy,
      signal: plugin.controller.signal,
      key: normalizePathKey(resolved.root),
    }
  }
  return {
    root: resolved.root,
    fs,
    record,
    tracked: tracked !== undefined,
    policy: undefined,
    signal: plugin.controller.signal,
    key: normalizePathKey(resolved.root),
  }
}

/**
 * Parsed editor prefill for one fact file's text.
 * @param {string} slug
 * @param {string} text
 * @returns {object} the `fact-read` value shape
 */
function describeFact(slug, text) {
  const frontmatter = parseFactFrontmatter(text) ?? {}
  return {
    name: slug,
    fileName: factFileName(slug),
    type: MEMORY_TYPES.includes(frontmatter.type) ? frontmatter.type : 'user',
    description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    body: factBodyText(text),
    originSessionId: typeof frontmatter.originSessionId === 'string' ? frontmatter.originSessionId : '',
    createdAt: typeof frontmatter.createdAt === 'string' ? frontmatter.createdAt : '',
    updatedAt: typeof frontmatter.updatedAt === 'string' ? frontmatter.updatedAt : '',
  }
}

/**
 * Swap one memory root's index for `after`, keeping a single `.prev` rollback
 * copy, under the caller's lock. Timestamps and the agent section stay with the
 * caller so a failed index write reports honestly.
 * @returns {Promise<undefined | { ok: false, error: object }>} undefined on success
 */
async function replaceIndexText(fs, root, before, after, policy, signal) {
  if (after === before) return undefined
  if (before.length > 0) {
    const backupTarget = await resolveTarget(fs, indexPath(root) + '.prev', signal)
    if (backupTarget !== undefined) {
      try {
        await fs.writeText(backupTarget, before, undefined, signal, policy)
      } catch (error) {
        debug(null, 'failed to back up MEMORY.md: ' + errorText(error))
      }
    }
  }
  const indexTarget = await resolveTarget(fs, indexPath(root), signal)
  if (indexTarget === undefined) return failure('write-failed', 'could not resolve ' + INDEX_FILE)
  try {
    await fs.writeText(indexTarget, after, undefined, signal, policy)
  } catch (error) {
    return failure('write-failed', errorText(error))
  }
  return undefined
}

/**
 * Read one fact for the panel editor (`fact-read`).
 * @param {object} plugin
 * @param {object} payload `{ path, name }`
 */
async function readFact(plugin, payload) {
  const context = factContext(plugin, payload, false)
  if (context.error !== undefined) return context.error
  const slug = factSlugFrom(payload?.name)
  if (slug === undefined) {
    return failure('invalid-name', 'name must be kebab-case: 1-48 characters, not "memory"')
  }
  const text = await readMemoryFileText(context.fs, context.root, factFileName(slug), context.signal)
  if (text === undefined) return failure('not-found', 'no such fact: ' + slug, { name: slug })
  return { ok: true, value: describeFact(slug, text) }
}

/**
 * Roadmap C3: create or update one fact from the panel (`fact-save`). The fact
 * file and the MEMORY.md pointer move inside one workspace lock, behind the same
 * index guard every other write uses.
 * @param {object} plugin
 * @param {object} payload `{ path, name, type, description, body }`
 */
async function saveFact(plugin, payload) {
  const context = factContext(plugin, payload, true)
  if (context.error !== undefined) return context.error
  const slug = factSlugFrom(payload?.name)
  if (slug === undefined) {
    return failure('invalid-name', 'name must be kebab-case: 1-48 characters, not "memory"')
  }
  const type = trimmedField(payload?.type) ?? ''
  if (!MEMORY_TYPES.includes(type)) {
    return failure('invalid-type', 'type must be one of: ' + MEMORY_TYPES.join(', '))
  }
  const description = trimmedField(payload?.description)
  if (description === undefined || description.length === 0) {
    return failure('invalid-fact', 'description is required')
  }
  if (description.length > FACT_DESCRIPTION_MAX) {
    return failure('invalid-fact', 'description is longer than ' + FACT_DESCRIPTION_MAX + ' characters')
  }
  const body = trimmedField(payload?.body)
  if (body === undefined || body.length === 0) return failure('invalid-fact', 'body is required')
  if (body.length > FACT_BODY_MAX) {
    return failure('invalid-fact', 'body is longer than ' + FACT_BODY_MAX + ' characters')
  }

  const { root, fs, policy, signal } = context
  const fileName = factFileName(slug)
  return runWithWorkspaceLocks(plugin, [context.key], 'save fact', async () => {
    const indexState = await readIndexState(plugin, context.record, signal, root)
    if (indexState.status === 'error') {
      return failure('index-unreadable', 'could not read ' + INDEX_FILE, { detail: indexState.detail ?? '' })
    }
    const before = indexState.status === 'ok' ? indexState.text : ''
    const existingText = await readMemoryFileText(fs, root, fileName, signal)
    const existing = typeof existingText === 'string' ? parseFactFrontmatter(existingText) : undefined
    const content = renderFactFile({
      name: slug,
      description,
      type,
      body,
      // Host-maintained history: an update keeps the original creation stamp and
      // origin session, and gets a fresh updatedAt from the renderer.
      originSessionId: existing?.originSessionId,
      createdAt: existing?.createdAt,
      updatedAt: undefined,
    })
    if (content.length === 0) {
      return failure('invalid-fact', 'the fact could not be rendered; check every field')
    }
    const after = upsertPointer(before, { title: deriveTitle(slug), file: fileName, hook: description })
    const verdict = evaluateIndexReplacement(before, after, [], [fileName])
    if (!verdict.ok) {
      return failure('write-refused', verdict.reason, { beforeCount: verdict.beforeCount, afterCount: verdict.afterCount })
    }
    const grew = pointerCountOf(after) > pointerCountOf(before)
    if (grew && pointerCountOf(after) > MAX_INDEX_LINES) {
      return failure('index-full', INDEX_FILE + ' already holds ' + MAX_INDEX_LINES + ' pointers')
    }
    const factPath = safeMemoryPath(root, fileName)
    const factTarget = factPath === undefined ? undefined : await resolveTarget(fs, factPath, signal)
    if (factTarget === undefined) return failure('write-failed', 'could not resolve ' + fileName)
    try {
      await fs.writeText(factTarget, content, undefined, signal, policy)
    } catch (error) {
      return failure('write-failed', errorText(error))
    }
    const indexFailure = await replaceIndexText(fs, root, before, after, policy, signal)
    if (indexFailure !== undefined) return indexFailure
    const written = parseFactFrontmatter(content) ?? {}
    maybeGitCommit(plugin, root, 'workspace-memory: save ' + fileName)
    if (context.tracked) void refreshAgentSection(plugin, context.record)
    return {
      ok: true,
      value: {
        name: slug,
        fileName,
        created: existingText === undefined,
        createdAt: typeof written.createdAt === 'string' ? written.createdAt : '',
        updatedAt: typeof written.updatedAt === 'string' ? written.updatedAt : '',
        indexChanged: after !== before,
      },
    }
  })
}

/**
 * Roadmap C3: delete one fact from the panel (`fact-delete`). The pointer goes
 * first and the file lands in `trash/`, so a failed trash move leaves a fact
 * without a pointer (which the next index repair links back in) rather than a
 * pointer to a missing file.
 * @param {object} plugin
 * @param {object} payload `{ path, name }`
 */
async function deleteFact(plugin, payload) {
  const context = factContext(plugin, payload, true)
  if (context.error !== undefined) return context.error
  const slug = factSlugFrom(payload?.name)
  if (slug === undefined) {
    return failure('invalid-name', 'name must be kebab-case: 1-48 characters, not "memory"')
  }
  const { root, fs, policy, signal } = context
  const fileName = factFileName(slug)
  return runWithWorkspaceLocks(plugin, [context.key], 'delete fact', async () => {
    const indexState = await readIndexState(plugin, context.record, signal, root)
    if (indexState.status === 'error') {
      return failure('index-unreadable', 'could not read ' + INDEX_FILE, { detail: indexState.detail ?? '' })
    }
    const before = indexState.status === 'ok' ? indexState.text : ''
    const existingText = await readMemoryFileText(fs, root, fileName, signal)
    if (existingText === undefined) return failure('not-found', 'no such fact: ' + slug, { name: slug })
    // `removePointer` drops every line for the file, so account for each dropped
    // line: the guard counts entries, not files, and a duplicated pointer line is
    // a line this run deliberately removes.
    const dropped = parseIndexPointers(before).filter((pointer) => pointer.file === fileName)
    const after = removePointer(before, fileName)
    const verdict = evaluateIndexReplacement(before, after, new Array(dropped.length).fill(fileName), [])
    if (!verdict.ok) {
      return failure('write-refused', verdict.reason, { beforeCount: verdict.beforeCount, afterCount: verdict.afterCount })
    }
    const indexFailure = await replaceIndexText(fs, root, before, after, policy, signal)
    if (indexFailure !== undefined) return indexFailure
    if (!(await forgetToTrash(plugin, fs, root, fileName, signal, policy))) {
      return failure('trash-failed', 'could not move ' + fileName + ' into trash/')
    }
    await trimTrash(plugin, root)
    maybeGitCommit(plugin, root, 'workspace-memory: trash ' + fileName)
    if (context.tracked) void refreshAgentSection(plugin, context.record)
    return {
      ok: true,
      value: { name: slug, fileName, trashed: true, indexChanged: after !== before, removedPointers: dropped.length },
    }
  })
}

/**
 * Roadmap C3: list one workspace's trash (`trash-list`), newest first. Trash is
 * node-fs bookkeeping exactly like `trimTrash`, because the fs seam cannot list a
 * directory that does not exist yet.
 * @param {object} plugin
 * @param {object} payload `{ path }`
 */
async function listTrash(plugin, payload) {
  const context = factContext(plugin, payload, false)
  if (context.error !== undefined) return context.error
  const trashDir = trashDirPath(context.root)
  let names
  try {
    names = await readdir(trashDir)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return failure('read-failed', errorText(error))
    names = []
  }
  const entries = []
  for (const name of names) {
    const slug = parseFactFileName(name)
    if (slug === undefined) continue
    let info
    try {
      info = await stat(join(trashDir, name))
    } catch (_error) {
      continue
    }
    if (!info.isFile()) continue
    entries.push({ name: slug, fileName: name, size: info.size, modifiedAt: Math.round(info.mtimeMs) })
  }
  entries.sort((left, right) => right.modifiedAt - left.modifiedAt || (left.fileName < right.fileName ? -1 : 1))
  return { ok: true, value: { root: context.root, entries: entries.slice(0, TRASH_LIST_MAX), keep: TRASH_KEEP } }
}

/**
 * Roadmap C3: move one trashed fact back into the memory root and re-link its
 * pointer (`trash-restore`). Refuses when a fact with that name exists again,
 * rather than overwriting it.
 * @param {object} plugin
 * @param {object} payload `{ path, name }`
 */
async function restoreTrash(plugin, payload) {
  const context = factContext(plugin, payload, true)
  if (context.error !== undefined) return context.error
  const slug = factSlugFrom(payload?.name)
  if (slug === undefined) {
    return failure('invalid-name', 'name must be kebab-case: 1-48 characters, not "memory"')
  }
  const { root, fs, policy, signal } = context
  const fileName = factFileName(slug)
  return runWithWorkspaceLocks(plugin, [context.key], 'restore fact', async () => {
    // The trash copy decides not-found: a missing file is reported as such even
    // when a live fact with the same name exists.
    const trashPath = join(trashDirPath(root), fileName)
    const trashTarget = await resolveTarget(fs, trashPath, signal)
    if (trashTarget === undefined) return failure('not-found', 'no trashed fact named ' + slug, { name: slug })
    let content
    try {
      content = await fs.readText(trashTarget, signal)
    } catch (error) {
      if (error && error.code === 'ENOENT') return failure('not-found', 'no trashed fact named ' + slug, { name: slug })
      return failure('read-failed', errorText(error))
    }
    if (content === undefined) return failure('not-found', 'no trashed fact named ' + slug, { name: slug })
    if (typeof content !== 'string' || content.length === 0) {
      return failure('read-failed', 'the trashed file is empty or not UTF-8 text')
    }
    if ((await readMemoryFileText(fs, root, fileName, signal)) !== undefined) {
      return failure(
        'already-exists',
        'a fact named ' + slug + ' already exists in this workspace; rename or delete it first',
        { name: slug },
      )
    }
    const frontmatter = parseFactFrontmatter(content) ?? {}
    const indexState = await readIndexState(plugin, context.record, signal, root)
    if (indexState.status === 'error') {
      return failure('index-unreadable', 'could not read ' + INDEX_FILE, { detail: indexState.detail ?? '' })
    }
    const before = indexState.status === 'ok' ? indexState.text : ''
    const after = upsertPointer(before, {
      title: deriveTitle(slug),
      file: fileName,
      hook: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    })
    const verdict = evaluateIndexReplacement(before, after, [], [fileName])
    if (!verdict.ok) {
      return failure('write-refused', verdict.reason, { beforeCount: verdict.beforeCount, afterCount: verdict.afterCount })
    }
    const grew = pointerCountOf(after) > pointerCountOf(before)
    if (grew && pointerCountOf(after) > MAX_INDEX_LINES) {
      return failure('index-full', INDEX_FILE + ' already holds ' + MAX_INDEX_LINES + ' pointers')
    }
    const factPath = safeMemoryPath(root, fileName)
    const factTarget = factPath === undefined ? undefined : await resolveTarget(fs, factPath, signal)
    if (factTarget === undefined) return failure('write-failed', 'could not resolve ' + fileName)
    try {
      await fs.writeText(factTarget, content, undefined, signal, policy)
    } catch (error) {
      return failure('write-failed', errorText(error))
    }
    try {
      await unlink(trashPath)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        log('restored ' + fileName + ' but could not remove the trash copy: ' + errorText(error))
      }
    }
    const indexFailure = await replaceIndexText(fs, root, before, after, policy, signal)
    if (indexFailure !== undefined) return indexFailure
    maybeGitCommit(plugin, root, 'workspace-memory: restore ' + fileName)
    if (context.tracked) void refreshAgentSection(plugin, context.record)
    return { ok: true, value: { name: slug, fileName, restored: true, indexChanged: after !== before } }
  })
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

/* ---------------------------------------------------- consolidation RPC (W3) */

/**
 * The record one workspace-scoped RPC runs against: a live session when the id
 * hint matches, otherwise a synthetic record for a whitelisted workspace, so a
 * consolidation can be requested without an open session.
 */
function recordForWorkspace(plugin, payload) {
  const sessionId = sourceSessionId(payload)
  const workspace = typeof payload.workspace === 'string' ? payload.workspace : ''
  if (sessionId !== undefined) {
    const record = plugin.bySession.get(sessionId)
    if (record !== undefined
      && (workspace === '' || normalizePathKey(record.root) === normalizePathKey(workspace))) {
      return record
    }
  }
  if (workspace === '') return undefined
  const allowed = collectWorkspaceCandidates(plugin, sessionId)
    .some((candidate) => normalizePathKey(candidate.path) === normalizePathKey(workspace))
  if (!allowed) return undefined
  const memory = memoryRootsOf(workspace)
  return {
    agent: undefined,
    session: undefined,
    sessionId,
    root: workspace,
    memoryRoot: memory.root,
    rootKey: memory.key,
    agentKey: undefined,
    agentRoots: undefined,
    abort: plugin.controller,
    running: false,
    pending: null,
    buffer: newTurnBuffer(),
    skipTurnExtraction: false,
    readOnly: false,
    query: undefined,
    cursor: emptyCursor(),
    cursorLoaded: true,
    pendingMessages: [],
    messageSeq: 0,
  }
}

/** `dream-run` endpoint: one explicit consolidation pass. */
async function runDreamEndpoint(plugin, payload) {
  const record = recordForWorkspace(plugin, payload)
  if (record === undefined) {
    return failure('unknown-workspace', 'no live session or whitelisted workspace for ' + String(payload.workspace ?? ''))
  }
  const result = await runDream(plugin, record, { force: payload.force === true })
  return { ok: true, value: result }
}

/** `dream-status` endpoint. */
async function dreamStatusEndpoint(plugin, payload) {
  const record = recordForWorkspace(plugin, payload)
  return { ok: true, value: await buildDreamStatus(plugin, record) }
}

/** Endpoint dispatch. */
async function dispatch(plugin, endpoint, payload) {
  if (endpoint === 'catalog') return { ok: true, value: await buildCatalog(plugin, payload) }
  if (endpoint === 'read') return readMemoryFile(plugin, payload)
  if (endpoint === 'activities') return { ok: true, value: await buildActivities(plugin, payload) }
  if (endpoint === 'session-state') return { ok: true, value: buildSessionState(plugin, payload) }
  if (endpoint === 'export') return exportMemory(plugin, payload)
  if (endpoint === 'import') return importMemory(plugin, payload)
  if (endpoint === 'proposals') return listProposals(plugin, payload)
  if (endpoint === 'proposals-accept') return acceptProposal(plugin, payload)
  if (endpoint === 'fact-read') return readFact(plugin, payload)
  if (endpoint === 'fact-save') return saveFact(plugin, payload)
  if (endpoint === 'fact-delete') return deleteFact(plugin, payload)
  if (endpoint === 'trash-list') return listTrash(plugin, payload)
  if (endpoint === 'trash-restore') return restoreTrash(plugin, payload)
  if (endpoint === 'dream-run') return runDreamEndpoint(plugin, payload)
  if (endpoint === 'dream-status') return dreamStatusEndpoint(plugin, payload)
  if (endpoint === 'retrieval') {
    return {
      ok: true,
      value: {
        branch: retrievalBranch(),
        active: retrievalBranch() === 'semantic-recall',
        recallBudgetChars: RECALL_BUDGET_CHARS,
      },
    }
  }
  return failure('unknown-endpoint', 'unknown ' + PKG + ' endpoint: ' + String(endpoint), { endpoint: String(endpoint) })
}

/**
 * Session id hint carried by the caller. The transport carries no session
 * identity, so this is only a hint: it must resolve to a live tracked session
 * before it widens visibility.
 */
function sourceSessionId(payload) {
  const id = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  return id.length > 0 ? id : undefined
}

/**
 * Workspaces visible to one RPC request: the registry whitelist plus the
 * source session's own workspace. Session cwds are deliberately not
 * enumerated — a forged request must not discover newly opened workspaces.
 */
function collectWorkspaceCandidates(plugin, sessionId) {
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
  const record = sessionId === undefined ? undefined : plugin.bySession.get(sessionId)
  if (record && typeof record.root === 'string' && record.root.length > 0) {
    const key = normalizePathKey(record.root)
    if (!candidates.has(key)) candidates.set(key, { path: record.root, title: displayTitle(record.root) })
  }
  return [...candidates.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Files of one workspace's memory directory. */
async function listMemoryFiles(plugin, fs, workspacePath, rootOverride) {
  const root = typeof rootOverride === 'string' && rootOverride.length > 0
    ? rootOverride
    : memoryRoot(workspacePath)
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
    if (isNonFactEntry(entry.name)) continue
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
  return annotateFactTypes(fs, files, workspacePath, root)
}

/**
 * Fill each fact's memory `type` (roadmap C4) and the three host-maintained
 * timestamps (roadmap D2) from its frontmatter so the panel can filter and can
 * show created/updated/last-accessed. The index has no type and keeps
 * `type: undefined`; a fact whose frontmatter is unreadable or carries an
 * unknown type stays `undefined` — the panel treats that as "all". Timestamps
 * arrive as epoch ms (0 when absent/invalid, matching the `updatedAt`
 * placeholder shape). Bounded like the index repair: the whole walk must not
 * stall the RPC. `root` overrides the memory root derived from the workspace.
 */
async function annotateFactTypes(fs, files, workspacePath, rootOverride) {
  const facts = files.filter((file) => file.kind === 'fact')
  if (facts.length === 0) return files
  const root = typeof rootOverride === 'string' && rootOverride.length > 0
    ? rootOverride
    : memoryRoot(workspacePath)
  const deadline = Date.now() + CATALOG_TYPE_TIMEOUT_MS
  for (const fact of facts) {
    if (Date.now() >= deadline) break
    const content = await readMemoryFileText(fs, root, fact.name)
    const front = parseFactFrontmatter(typeof content === 'string' ? content : '')
    const type = front && typeof front.type === 'string' ? front.type : ''
    if (MEMORY_TYPES.includes(type)) fact.type = type
    fact.createdAt = front === undefined ? 0 : timestampMs(front.createdAt)
    fact.updatedAt = front === undefined ? 0 : timestampMs(front.updatedAt)
    fact.lastAccessedAt = front === undefined ? 0 : timestampMs(front.lastAccessedAt)
  }
  return files
}

/**
 * Epoch ms of one ISO 8601 timestamp string, 0 when absent or unparseable —
 * the same "0 when unknown" contract the catalog already documents for
 * `updatedAt`.
 * @param {string | undefined} value
 * @returns {number}
 */
function timestampMs(value) {
  if (typeof value !== 'string' || value.length === 0) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** The `catalog` value. */
async function buildCatalog(plugin, payload) {
  const config = {
    enabled: isEnabled(plugin),
    autoExtract: isAutoExtract(plugin),
  }
  if (!isEnabled(plugin)) return { config, workspaces: [] }
  const fs = safeService(plugin.ctx, 'fs')
  const workspaces = []
  if (fs) {
    for (const candidate of collectWorkspaceCandidates(plugin, sourceSessionId(payload))) {
      const files = await listMemoryFiles(plugin, fs, candidate.path)
      if (files.length === 0) continue
      const budget = workspaceBudgets.get(normalizePathKey(memoryRoot(candidate.path)))
      workspaces.push({
        path: candidate.path,
        title: candidate.title,
        memoryRoot: memoryRoot(candidate.path),
        layer: 'workspace',
        files,
        todayCount: budget && budget.day === localDayKey(Date.now()) ? budget.count : 0,
        lastAt: budget && typeof budget.lastAtMs === 'number' ? budget.lastAtMs : 0,
      })
    }
    // Memory is per-workspace: the catalog lists only the visible workspaces'
    // own `<workspaceRoot>/.dsh/memory` directories.
  }
  return { config, session: sessionStateValue(plugin, payload), workspaces }
}

/** The volatile `session-state` value (roadmap C2), or undefined sessions yield `null`. */
function sessionStateValue(plugin, payload) {
  const record = plugin.bySession.get(sourceSessionId(payload))
  if (!record) return null
  return { sessionId: record.sessionId, skipTurnExtraction: record.skipTurnExtraction === true }
}

/**
 * Read or set the per-session incognito toggle (roadmap C2). The flag lives
 * only on the in-memory session record: it is never written to disk, and it
 * dies with the session. An unknown or untracked session answers `null` —
 * a forged sessionId cannot create state.
 */
function buildSessionState(plugin, payload) {
  const record = plugin.bySession.get(sourceSessionId(payload))
  if (!record) return { sessionId: null, skipTurnExtraction: false }
  if (payload.skipTurnExtraction !== undefined) {
    record.skipTurnExtraction = payload.skipTurnExtraction === true
    debug(plugin, `session state for ${record.sessionId ?? '(unknown session)'}: `
      + (record.skipTurnExtraction ? 'no extraction this session' : 'extraction resumes'))
  }
  return { sessionId: record.sessionId, skipTurnExtraction: record.skipTurnExtraction === true }
}

/**
 * The `activities` value (roadmap C1): the in-memory extraction history of the
 * visible workspaces, newest first. Same visibility rules as `catalog` —
 * the whitelist plus a resolvable source session's workspace.
 */
async function buildActivities(plugin, payload) {
  const activities = []
  for (const candidate of collectWorkspaceCandidates(plugin, sourceSessionId(payload))) {
    const list = workspaceActivities.get(normalizePathKey(memoryRoot(candidate.path)))
    for (const entry of Array.isArray(list) ? list : []) {
      activities.push({ ...entry, workspace: candidate.path })
    }
  }
  activities.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return { activities }
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
  for (const candidate of collectWorkspaceCandidates(plugin, sourceSessionId(payload))) {
    if (normalizePathKey(candidate.path) === requestedKey) {
      workspacePath = candidate.path
      break
    }
  }
  if (workspacePath === undefined) {
    return failure('invalid-path', 'unknown workspace')
  }

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

/**
 * Test seam: the plugin instance created for a root context. The Host loader
 * ignores `apply`'s return value, so endpoint tests look the plugin up here
 * instead of relying on a return value the runtime never reads.
 */
const pluginsByContext = new WeakMap()

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
    // W2 (ZCode alignment): the last semantic-recall block per session id. Only
    // read when `retrievalBranch()` reports 'semantic-recall', which the shipped
    // constant leaves off, so the default path never touches this map.
    recall: new Map(),
    // W3 (ZCode alignment): one consolidation slot per plugin, mirroring the
    // single running Dream the upstream scheduler allows.
    dream: { running: false, lastScanAtMs: 0, lastRunAtMs: 0, lastError: undefined, lastResult: undefined },
  }
  pluginsByContext.set(ctx, plugin)

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
              if (sectionRetries.has(agent)) scheduleSectionRetry(plugin, agent)
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
      // Queued lock waiters die with the controller; dropping the chains keeps
      // a disposed plugin from leaving keys behind across reloads.
      workspaceLocks.clear()
      workspaceBudgets.clear()
      workspaceActivities.clear()
      resetPendingAccessHits()
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
  acceptProposal,
  applyAssistantMessage,
  applyToolResult,
  applyUserMessage,
  blocksToText,
  buildCatalog,
  buildSessionState,
  cfg,
  collectArgumentStrings,
  collectExportFiles,
  collectStreamText,
  countFactsIn,
  createLinkedSignal,
  debug,
  displayTitle,
  dispatch,
  exportMemory,
  extractDailyLimit,
  extractMinIntervalMs,
  failure,
  importMemory,
  isCompletedTurn,
  isEligibleSession,
  isEnabled,
  isMinimalSession,
  isNonFactEntry,
  isSubagentSession,
  listMemoryFiles,
  listProposals,
  loadSchemaModule,
  log,
  manifestLayerProblem,
  maxIndexChars,
  maybeGitCommit,
  maybeWriteProposals,
  newTurnBuffer,
  normalizePathKey,
  normalizeResult,
  planExtractionWrites,
  readFactStats,
  readManifest,
  recordActivity,
  refreshAgentSection,
  repairIndex,
  runWithWorkspaceLocks,
  schemaAnchorDirectories,
  schemaEntryCandidates,
  sessionIdOf,
  tailWithinBytes,
  workspaceActivitiesOf,
  workspaceBudgetOf,
  workspaceLockSize,
  workspaceRootOf,
  resetWorkspaceActivities,
  noteAccessHits,
  flushAccessHits,
  touchLastAccessed,
  pendingAccessHitsOf,
  resetPendingAccessHits,
  accessFlushDelay,
  agentMemoryBlockFor,
  appendPendingMessages,
  buildDreamStatus,
  cursorFilePath,
  dreamStatusEndpoint,
  loadCursor,
  persistCursor,
  pluginForContext: (ctx) => pluginsByContext.get(ctx),
  recordForWorkspace,
  refreshRecall,
  runDream,
  runDreamEndpoint,
  settleExtractionCursor,
  ACTIVITY_KEEP,
  EXPORT_DIR_PREFIX,
  EXPORT_FORMAT,
  EXPORT_MANIFEST_FILE,
  EXPORT_MAX_FILES,
  EXPORT_VERSION,
  GIT_TIMEOUT_MS,
  LOG_ROTATE_BYTES,
  DEFAULT_LOG_PATH,
  journalPath,
  rotatedJournalPath,
  setJournalPath,
  NON_FACT_ENTRIES,
  PROPOSAL_FACT_THRESHOLD,
  REPAIR_READ_TIMEOUT_MS,
}

/** Test seam: number of workspaces currently holding or queued on the lock. */
function workspaceLockSize() {
  return workspaceLocks.size
}

/** Test seam: the recorded `{ day, count, lastAtMs }` of one workspace key. */
function workspaceBudgetOf(rootKey) {
  return workspaceBudgets.get(rootKey)
}

/** Test seam: the activity entries of one workspace memory-root key, newest first. */
function workspaceActivitiesOf(rootKey) {
  return workspaceActivities.get(rootKey) ?? []
}

/** Test seam: drop every recorded activity (between tests). */
function resetWorkspaceActivities() {
  workspaceActivities.clear()
}

/** Test seam: pending fact read hits of one memory-root key, as a sorted list. */
function pendingAccessHitsOf(rootKey) {
  return [...(pendingAccessHits.get(rootKey) ?? [])].sort()
}

/** Test seam: drop every pending read hit and disarm the flush timer (between tests). */
function resetPendingAccessHits() {
  pendingAccessHits.clear()
  if (accessFlushTimer !== undefined) {
    clearTimeout(accessFlushTimer)
    accessFlushTimer = undefined
  }
}

/** Test seam: the debounce window of the lazy lastAccessedAt flush. */
function accessFlushDelay() {
  return ACCESS_FLUSH_DELAY_MS
}

/** Test seam: the section retry state `{ attempts, nextAtMs, pending }` of one Agent. */
export function sectionRetryStateOf(agent) {
  return sectionRetries.get(agent)
}