/**
 * Dream consolidation: the periodic reflective pass that merges recent signal
 * into the workspace memory directory.
 *
 * Ported from ZCode `dream.ts`. This module owns only the deterministic half —
 * the timing gates, the lock file, the prompt and the reply parser. Running the
 * model call and applying the writes stays in the Host.
 *
 * Adapted from ZCode apps/zcode-cli/packages/core/src/memory/dream.ts
 * (Apache-2.0). Changes: constants take the public `DREAM_`/`AUTO_DREAM_`
 * prefixes, `evaluateDreamTiming` replaces `evaluateAutoDreamTiming` and gains
 * the `newSessionCount` gate, the prompt is retargeted from CLAUDE.md to
 * AGENTS.md and from tool-driven exploration (`ls`/`grep`/`Write`, transcript
 * search) to inlined index, fact briefs and activity text, the reply is a JSON
 * contract instead of tool calls, and `collectDreamTouchedPaths` is dropped
 * (no tool-call stream to walk). Lock, restore and timing behavior are copied
 * verbatim.
 */

import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MEMORY_TYPES, conflictExcerpt, extractJsonObject } from './memory-core.js'

/** Lock file that marks a dream run in progress, inside the memory directory. */
export const DREAM_LOCK_FILE = '.consolidate-lock'

/** A lock younger than this whose PID is alive is considered owned (1 hour). */
export const DREAM_LOCK_FRESH_MS = 60 * 60 * 1000

/** No automatic dream runs while the last consolidation is younger than 24h. */
export const AUTO_DREAM_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Minimum gap between two session scans looking for dream work (10 minutes). */
export const AUTO_DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000

/** A dream only runs after this many new sessions since the last consolidation. */
export const AUTO_DREAM_MIN_SESSIONS = 5

/** Maximum number of memory updates one dream reply may carry. */
export const DREAM_MAX_UPDATES = 10

/** Maximum number of memory deletions one dream reply may carry. */
export const DREAM_MAX_DELETES = 10

/** Cap on the body excerpt inlined per existing fact file in the prompt. */
const FACT_BRIEF_EXCERPT_MAX_CHARS = 240

/* ------------------------------------------------------------------- timing */

/**
 * Decide whether an automatic dream should scan for work now.
 *
 * Gates, in order: the 24h minimum interval since the last consolidation, the
 * 10min scan throttle, then the 5-new-session threshold. A skipped scan repeats
 * the check on the next tick; nothing is written on a skip.
 * @param {{ nowMs?: number, lastConsolidatedAtMs?: number, lastScanAtMs?: number, newSessionCount?: number }} input
 * @returns {{ decision: 'scan' } | { decision: 'skip', reason: 'minimum-interval' | 'scan-throttled' | 'not-enough-sessions' }}
 */
export function evaluateDreamTiming(input) {
  const nowMs = Number.isFinite(input?.nowMs) ? input.nowMs : Date.now()
  const lastConsolidatedAtMs = Number.isFinite(input?.lastConsolidatedAtMs)
    ? input.lastConsolidatedAtMs
    : 0
  const lastScanAtMs = Number.isFinite(input?.lastScanAtMs) ? input.lastScanAtMs : 0
  const newSessionCount = Number.isSafeInteger(input?.newSessionCount) && input.newSessionCount > 0
    ? input.newSessionCount
    : 0

  if (nowMs - lastConsolidatedAtMs < AUTO_DREAM_MINIMUM_INTERVAL_MS) {
    return { decision: 'skip', reason: 'minimum-interval' }
  }
  if (nowMs - lastScanAtMs < AUTO_DREAM_SCAN_THROTTLE_MS) {
    return { decision: 'skip', reason: 'scan-throttled' }
  }
  if (newSessionCount < AUTO_DREAM_MIN_SESSIONS) {
    return { decision: 'skip', reason: 'not-enough-sessions' }
  }
  return { decision: 'scan' }
}

/* --------------------------------------------------------------------- lock */

/**
 * When the last consolidation finished, read off the lock file's mtime.
 * @param {string} memoryRoot absolute memory directory
 * @returns {Promise<number>} mtime in ms, or 0 when the lock does not exist
 */
export async function readDreamLastConsolidatedAt(memoryRoot) {
  try {
    return (await stat(dreamLockPath(memoryRoot))).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Take the dream lock, unless a live run already holds it.
 *
 * A lock younger than {@link DREAM_LOCK_FRESH_MS} written by a live PID blocks
 * the attempt (`null`). Anything else — missing, unreadable, stale, or a dead
 * owner — is taken over: this run writes its own PID and reads it back to
 * confirm ownership, which keeps two racing runs from both proceeding.
 * @param {{ memoryRoot: string, nowMs?: number, pid?: number }} input
 * @returns {Promise<number | null>} prior lock mtime (0 when there was none, to
 *   hand to {@link restoreDreamLockAfterFailure}), or null when not acquired
 */
export async function acquireDreamLock(input) {
  const lockPath = dreamLockPath(input.memoryRoot)
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now()
  const pid = Number.isSafeInteger(input.pid) ? input.pid : process.pid
  let priorMtimeMs
  let priorPid

  try {
    const [lockStat, content] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf8')])
    priorMtimeMs = lockStat.mtimeMs
    const parsedPid = Number.parseInt(content.trim(), 10)
    if (Number.isFinite(parsedPid)) priorPid = parsedPid
  } catch {
    // Missing or unreadable counts as "no owner"; the write-readback decides.
  }

  if (
    priorMtimeMs !== undefined &&
    nowMs - priorMtimeMs < DREAM_LOCK_FRESH_MS &&
    priorPid !== undefined &&
    isLiveProcess(priorPid)
  ) {
    return null
  }

  await mkdir(input.memoryRoot, { recursive: true })
  await writeFile(lockPath, String(pid), 'utf8')
  let writtenPid
  try {
    writtenPid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
  } catch {
    return null
  }
  if (writtenPid !== pid) return null
  return priorMtimeMs ?? 0
}

/**
 * Put the lock back the way it was after a failed run, so the 24h interval is
 * not reset by a crash. A prior mtime of 0 means "there was no lock": remove it.
 * @param {{ memoryRoot: string, priorMtimeMs: number }} input
 * @returns {Promise<void>}
 */
export async function restoreDreamLockAfterFailure(input) {
  const lockPath = dreamLockPath(input.memoryRoot)
  if (input.priorMtimeMs === 0) {
    await removeIfPresent(lockPath)
    return
  }
  await writeFile(lockPath, '', 'utf8')
  const priorSeconds = input.priorMtimeMs / 1000
  await utimes(lockPath, priorSeconds, priorSeconds)
}

/**
 * Drop the lock after a successful run. The file's final mtime is what records
 * the last consolidation time, so callers must write it once and not touch it
 * again; a missing lock is not an error.
 * @param {{ memoryRoot: string }} input
 * @returns {Promise<void>}
 */
export async function releaseDreamLock(input) {
  await removeIfPresent(dreamLockPath(input.memoryRoot))
}

function dreamLockPath(memoryRoot) {
  return join(memoryRoot, DREAM_LOCK_FILE)
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath)
  } catch {
    // Already gone — releasing twice is a no-op.
  }
}

function isLiveProcess(pid) {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------- prompt */

/**
 * Build the four-phase consolidation prompt.
 *
 * The run has no tools, so everything the model needs — the current index, one
 * brief per existing fact file, and the recent session activity — is inlined
 * here, and the reply is a single JSON object the Host applies.
 * @param {{
 *   memoryRoot: string,
 *   indexText?: string,
 *   factBriefs?: Array<{ name: string, description?: string, type?: string, body?: string } | string>,
 *   sessionIds?: string[],
 *   activityText?: string
 * }} input
 * @returns {string}
 */
export function buildDreamPrompt(input) {
  const memoryRoot = typeof input?.memoryRoot === 'string' ? input.memoryRoot : ''
  const indexText = typeof input?.indexText === 'string' ? input.indexText.trim() : ''
  const activityText = typeof input?.activityText === 'string' ? input.activityText.trim() : ''
  const sessionIds = Array.isArray(input?.sessionIds)
    ? input.sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0)
    : []

  const sessionLines = sessionIds.length === 0
    ? '- (none recorded)'
    : sessionIds.map((sessionId) => `- ${sessionId}`).join('\n')
  const indexBlock = indexText.length === 0
    ? '_(MEMORY.md does not exist yet — the index is empty)_'
    : indexText
  const activityBlock = activityText.length === 0
    ? '_(no new session activity since the last consolidation)_'
    : activityText
  const briefs = renderFactBriefs(input?.factBriefs)
  const briefBlock = briefs.length === 0
    ? '_(no fact files exist yet)_'
    : briefs.join('\n')

  const contract =
    'Return exactly one JSON object and nothing else: ' +
    '{"updates":[{"name":"...","title":"...","type":"user|feedback|project|reference",' +
    '"description":"...","body":"...","why":"...","howToApply":"..."}],"deletes":["<name>"]}. ' +
    `At most ${DREAM_MAX_UPDATES} updates and ${DREAM_MAX_DELETES} deletes. ` +
    'Reuse an existing name to update it. ' +
    'If nothing needs consolidation, return {"updates":[],"deletes":[]}.'

  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}/\`

**No tools in this run.** Do not assume there is a tool to list, grep, read or write the memory files. The current index, the existing fact files and recent session activity are all inlined below; your reply is a JSON object that the host applies to disk.

---

## Phase 1 — Orient

The index and every existing fact file are already inlined here — read them before proposing anything, and improve an existing file rather than creating a near-duplicate.

### Current index (\`MEMORY.md\`)

\`\`\`text
${indexBlock}
\`\`\`

### Existing fact files

${briefBlock}

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Recent session activity** (inlined below; one block per session, each line prefix-coded: \`>\` user, \`<\` assistant, \`.\` tool call)
2. **Existing memories that drifted** — facts that contradict what the activity shows
3. **Durable context** in the sessions listed below that no memory file captures yet

Recent activity:

\`\`\`text
${activityBlock}
\`\`\`

Sessions since the last consolidation (${sessionIds.length}):
${sessionLines}

Don't try to cover everything. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, propose an update in the JSON reply described at the end of this prompt. Follow the memory file format and type conventions from your system prompt's memory section — it is the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing memory files rather than creating near-duplicates (reuse the existing \`name\` to update it)
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's activity disproves an old memory, list its \`name\` in \`deletes\`

## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under 200 lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

The index itself is not part of the JSON reply — the host re-renders it from the fact files.

### Reconcile memories against AGENTS.md

Project AGENTS.md instructions are loaded in your system prompt. For each \`feedback\` or \`project\` memory, check whether it contradicts an AGENTS.md instruction on the same topic:

- **Memory is stale** — AGENTS.md and the memory describe different procedures for the same task: AGENTS.md is the maintained, checked-in source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **AGENTS.md may be stale** — the memory is clearly dated after AGENTS.md and explicitly corrects it: do NOT edit AGENTS.md during a dream. Annotate the memory with "contradicts AGENTS.md — verify which is current" and list it in your summary so the user can update AGENTS.md.
- **Not a conflict** — the memory adds detail AGENTS.md doesn't cover, or narrows an AGENTS.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than AGENTS.md — AGENTS.md may have been updated since.

---

${contract}`
}

/**
 * One prompt line per existing fact file: `- name [type]: description` plus a
 * short body excerpt, so the model can merge into the right file without I/O.
 * @param {Array<{ name?: unknown, description?: unknown, type?: unknown, body?: unknown } | string> | undefined} factBriefs
 * @returns {string[]}
 */
function renderFactBriefs(factBriefs) {
  const briefs = Array.isArray(factBriefs) ? factBriefs : []
  const lines = []
  for (const brief of briefs) {
    if (typeof brief === 'string') {
      const text = brief.replace(/\s+/gu, ' ').trim()
      if (text.length > 0) lines.push(`- ${text}`)
      continue
    }
    if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) continue
    const name = typeof brief.name === 'string' ? brief.name.trim() : ''
    if (name.length === 0) continue
    const type = MEMORY_TYPES.includes(brief.type) ? ` [${brief.type}]` : ''
    const description = typeof brief.description === 'string'
      ? brief.description.replace(/\s+/gu, ' ').trim()
      : ''
    const excerpt = typeof brief.body === 'string' && brief.body.trim().length > 0
      ? conflictExcerpt(brief.body, FACT_BRIEF_EXCERPT_MAX_CHARS)
      : ''
    const head = description.length === 0 ? `- ${name}${type}` : `- ${name}${type}: ${description}`
    lines.push(excerpt.length === 0 ? head : `${head}\n  ${excerpt}`)
  }
  return lines
}

/* -------------------------------------------------------------------- reply */

/**
 * Validate a dream reply. Surrounding prose and code fences are tolerated.
 *
 * Updates that fail validation (unknown type, missing name/title/description/
 * body, path-like name) are dropped individually; the rest are deduped by name
 * (a later entry replaces an earlier one) and capped at
 * {@link DREAM_MAX_UPDATES}. Deletes keep string names only, deduped and capped
 * at {@link DREAM_MAX_DELETES}.
 * @param {unknown} text model reply text
 * @returns {{ updates: Array<{ name: string, title: string, type: string, description: string, body: string, why: string, howToApply: string }>, deletes: string[], parsed: boolean }}
 *   `parsed: false` when no JSON object could be read out of the reply
 */
export function parseDreamResponse(text) {
  const parsed = extractJsonObject(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { updates: [], deletes: [], parsed: false }
  }
  const rawUpdates = parsed.updates === undefined ? [] : parsed.updates
  if (!Array.isArray(rawUpdates)) return { updates: [], deletes: [], parsed: false }

  const canonical = new Map()
  for (const raw of rawUpdates) {
    const update = normalizeDreamUpdate(raw)
    if (update !== undefined) canonical.set(update.name, update)
  }
  const updates = [...canonical.values()].slice(0, DREAM_MAX_UPDATES)

  const rawDeletes = parsed.deletes === undefined ? [] : parsed.deletes
  const deletes = []
  if (Array.isArray(rawDeletes)) {
    for (const raw of rawDeletes) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (name.length === 0 || deletes.includes(name)) continue
      deletes.push(name)
    }
  }
  return { updates, deletes: deletes.slice(0, DREAM_MAX_DELETES), parsed: true }
}

/**
 * Normalize one dream update into the extraction fact shape. Mirrors the field
 * set of memory-core's extraction normalizer; `why`/`howToApply` are optional.
 * @param {unknown} raw
 * @returns {{ name: string, title: string, type: string, description: string, body: string, why: string, howToApply: string } | undefined}
 */
function normalizeDreamUpdate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (!MEMORY_TYPES.includes(raw.type)) return undefined
  const name = dreamName(raw.name)
  if (name === undefined) return undefined
  const title = collapsedText(raw.title)
  const description = collapsedText(raw.description)
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  if (title.length === 0 || description.length === 0 || body.length === 0) return undefined
  return {
    name,
    title,
    type: raw.type,
    description,
    body,
    why: typeof raw.why === 'string' ? raw.why.trim() : '',
    howToApply: typeof raw.howToApply === 'string' ? raw.howToApply.trim() : '',
  }
}

/**
 * Accept a memory name unless it is empty or could escape the memory directory.
 * Dream updates target existing files, so one weird name is a bad entry, not a
 * name to repair.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function dreamName(value) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  if (name.length === 0) return undefined
  if (name === '.' || name === '..') return undefined
  if (/[\\/\0]/.test(name)) return undefined
  return name
}

function collapsedText(value) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/gu, ' ').trim() : ''
}

/**
 * Plan the writes a dream reply implies, in the shape the extraction plan uses
 * (`{ memories, forget }`), so the Host applies one code path for both.
 * @param {{ updates?: unknown, deletes?: unknown }} [plan] parsed dream reply
 * @returns {{ memories: Array<{ name: string, title: string, type: string, description: string, body: string, why: string, howToApply: string }>, forget: string[] }}
 */
export function planDreamWrites(plan) {
  const updates = Array.isArray(plan?.updates) ? plan.updates : []
  const deletes = Array.isArray(plan?.deletes) ? plan.deletes : []
  const memories = []
  for (const update of updates) {
    if (update === null || typeof update !== 'object' || Array.isArray(update)) continue
    const name = dreamName(update.name)
    const body = typeof update.body === 'string' ? update.body.trim() : ''
    if (name === undefined || body.length === 0) continue
    memories.push({
      name,
      title: collapsedText(update.title),
      type: update.type,
      description: collapsedText(update.description),
      body,
      why: typeof update.why === 'string' ? update.why.trim() : '',
      howToApply: typeof update.howToApply === 'string' ? update.howToApply.trim() : '',
    })
  }
  const forget = []
  for (const name of deletes) {
    if (typeof name !== 'string') continue
    const trimmed = name.trim()
    if (trimmed.length === 0 || forget.includes(trimmed)) continue
    forget.push(trimmed)
  }
  return { memories, forget }
}
