/**
 * Persistent extraction cursor: which message of which session background
 * extraction has already consumed, plus a bounded pending window.
 *
 * // Adapted from ZCode apps/zcode-cli/packages/core/src/memory/extraction.ts (Apache-2.0). Changes: this is a new standalone module — ZCode keeps the cursor in an in-memory `let cursor: MessageId | undefined` per scheduler. Here the position is a serializable, per-session snapshot (`{ boundaryId?, at, attempts }`) owned by the workspace file, so a restart or a second process does not re-extract the same turn, and the "run" decision is followed by a bounded `pendingWindow` the caller turns into a transcript. Semantics kept from upstream: only `success`/`no-op` (and `skip`) move the boundary; `error`/`abort` leave it in place. Added: `skip` is an explicit status, `attempts` counts failed advances for backoff, a lookup miss degrades to "no boundary" (upstream `messagesAfterFoundCursor` returns `undefined` and callers fall back to the whole list), and the window is capped by characters instead of the 24000-char transcript cap applied later.
 *
 * Pure and dependency free: no I/O, no clock reads except the `Date.now()`
 * fallback in {@link advanceCursor} when the caller omits `nowMs`; every other
 * function is deterministic and covered by `test/cursor.test.mjs`.
 *
 * No helper in `lib/memory-core.js` covers cursor state, so nothing there is
 * reused. The character cap intentionally mirrors `MAX_TRANSCRIPT_CHARS`
 * (24000): the window decides *which* messages enter a transcript, the
 * transcript decides *how much text* survives once they are rendered.
 */

/** Schema version of the persisted cursor. Bump only with a migration. */
export const CURSOR_VERSION = 1

/** Default character budget for one pending window (mirrors `MAX_TRANSCRIPT_CHARS`). */
export const CURSOR_MAX_PENDING_CHARS = 24000

/** Statuses that move the boundary forward and clear the failure counter. */
const ADVANCING_STATUSES = Object.freeze(['success', 'no-op', 'skip'])

/** Statuses that keep the boundary where it is and bump the failure counter. */
const HOLDING_STATUSES = Object.freeze(['error', 'abort'])

/**
 * A cursor that has extracted nothing yet.
 *
 * @returns {{ version: number, sessions: Record<string, { boundaryId?: string, at: number, attempts: number }> }}
 */
export function emptyCursor() {
  return { version: CURSOR_VERSION, sessions: {} }
}

/**
 * Revive a persisted cursor, tolerating anything that is not a current,
 * well-formed snapshot. Unknown or malformed session entries are dropped
 * instead of failing the whole load: losing one session's position only costs
 * a re-extraction, while throwing would disable extraction for the workspace.
 *
 * @param {unknown} text raw file content
 * @returns {{ version: number, sessions: Record<string, { boundaryId?: string, at: number, attempts: number }> }} a fresh `emptyCursor()` when unusable
 */
export function parseCursor(text) {
  if (typeof text !== 'string' || text.length === 0) return emptyCursor()

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyCursor()
  }

  if (!isPlainObject(parsed)) return emptyCursor()
  if (parsed.version !== CURSOR_VERSION) return emptyCursor()

  const sessions = {}
  if (isPlainObject(parsed.sessions)) {
    for (const [sessionId, raw] of Object.entries(parsed.sessions)) {
      if (sessionId.length === 0) continue
      const entry = normalizeEntry(raw)
      if (entry !== null) sessions[sessionId] = entry
    }
  }

  return { version: CURSOR_VERSION, sessions }
}

/**
 * Stable serialization: byte-identical output for semantically identical
 * state, so the file only changes when the cursor actually changes (and a
 * round-trip through {@link parseCursor} is lossless). Keys are emitted in a
 * fixed order — `version`, then `sessions` sorted ascending by session id by
 * code unit — because the default object key order would reorder integer-like
 * ids and make diffs noisy.
 *
 * @param {{ version?: number, sessions?: object }} state
 * @returns {string}
 */
export function serializeCursor(state) {
  const normalized = normalizeState(state)
  const ids = Object.keys(normalized.sessions).sort()
  const body = ids
    .map((sessionId) => `${JSON.stringify(sessionId)}:${serializeEntry(normalized.sessions[sessionId])}`)
    .join(',')
  return `{"version":${CURSOR_VERSION},"sessions":{${body}}}`
}

/**
 * Record one extraction outcome for a session and return the next cursor.
 *
 * `success` / `no-op` / `skip` move the boundary to the snapshot end (a skip
 * still consumed the turn) and reset `attempts`; `error` / `abort` keep the
 * boundary and increment `attempts` so the caller can back off. The input is
 * never mutated, and `at` always records when this outcome was recorded.
 *
 * @param {{ version?: number, sessions?: object } | undefined} state
 * @param {{ sessionId: string, status: 'success' | 'no-op' | 'skip' | 'error' | 'abort', boundaryId?: string, nowMs?: number }} input
 * @returns {{ version: number, sessions: Record<string, { boundaryId?: string, at: number, attempts: number }> }}
 */
export function advanceCursor(state, input) {
  const { sessionId, status, boundaryId, nowMs } = input ?? {}

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('advanceCursor: sessionId must be a non-empty string')
  }
  const advances = ADVANCING_STATUSES.includes(status)
  if (!advances && !HOLDING_STATUSES.includes(status)) {
    throw new TypeError(
      `advanceCursor: unknown status ${JSON.stringify(status)}; expected one of ${[...ADVANCING_STATUSES, ...HOLDING_STATUSES].join(', ')}`,
    )
  }

  const base = normalizeState(state)
  const previous = base.sessions[sessionId]
  const nextBoundaryId = advances ? usableBoundary(boundaryId) ?? previous?.boundaryId : previous?.boundaryId

  const entry = {}
  if (nextBoundaryId !== undefined) entry.boundaryId = nextBoundaryId
  entry.at = Number.isFinite(nowMs) ? nowMs : Date.now()
  entry.attempts = advances ? 0 : (previous?.attempts ?? 0) + 1

  return { version: CURSOR_VERSION, sessions: { ...base.sessions, [sessionId]: entry } }
}

/**
 * The messages a session still owes memory extraction, oldest first.
 *
 * Starts strictly *after* the session's boundary and stops before the first
 * message that would push the running total of characters past `maxChars`.
 * The cap is strict: an oversized first message yields an empty window and
 * `dropped > 0` rather than an over-budget one — the caller is expected to
 * segment long turns instead of letting this module break its own bound.
 *
 * A boundary that no longer appears in `messages` (trimmed history, another
 * session's replay) degrades to "no boundary", matching upstream, so the
 * window replays everything instead of returning nothing forever.
 *
 * @param {Array<{ id: string, text: string }>} messages durable messages, chronological
 * @param {{ version?: number, sessions?: object } | undefined} cursor
 * @param {{ sessionId?: string, maxChars?: number }} [options]
 * @returns {{ messages: Array<{ id: string, text: string }>, dropped: number, boundaryId?: string }}
 */
export function pendingWindow(messages, cursor, options = {}) {
  const { sessionId, maxChars = CURSOR_MAX_PENDING_CHARS } = options ?? {}
  const state = normalizeState(cursor)
  const boundaryId = typeof sessionId === 'string' ? state.sessions[sessionId]?.boundaryId : undefined

  const list = (Array.isArray(messages) ? messages : []).filter(
    (message) => isPlainObject(message) && typeof message.id === 'string' && message.id.length > 0,
  )

  let start = 0
  if (boundaryId !== undefined) {
    const index = list.findIndex((message) => message.id === boundaryId)
    start = index < 0 ? 0 : index + 1
  }

  const budget =
    Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : CURSOR_MAX_PENDING_CHARS

  const windowed = []
  let used = 0
  for (let index = start; index < list.length; index += 1) {
    const message = list[index]
    const size = messageText(message).length
    if (used + size > budget) break
    used += size
    windowed.push(message)
  }

  return {
    messages: windowed,
    dropped: list.length - start - windowed.length,
    boundaryId: windowed.length > 0 ? windowed[windowed.length - 1].id : boundaryId,
  }
}

/** Coerce any state-shaped value into a normalized cursor without throwing. */
function normalizeState(state) {
  if (!isPlainObject(state)) return emptyCursor()
  // A foreign version's sessions mean something else; serialize/advance must
  // not silently reinterpret them, so they collapse to an empty cursor (the
  // same outcome {@link parseCursor} produces).
  if (state.version !== undefined && state.version !== CURSOR_VERSION) return emptyCursor()
  const sessions = {}
  if (isPlainObject(state.sessions)) {
    for (const [sessionId, raw] of Object.entries(state.sessions)) {
      if (sessionId.length === 0) continue
      const entry = normalizeEntry(raw)
      if (entry !== null) sessions[sessionId] = entry
    }
  }
  return { version: CURSOR_VERSION, sessions }
}

/**
 * One session entry, or `null` when it cannot be trusted.
 *
 * `at` must be a finite number and `attempts` a non-negative integer; a
 * present `boundaryId` must be a non-empty string. Anything else is dropped —
 * a malformed entry must never make the cursor advance on its own.
 *
 * @returns {{ boundaryId?: string, at: number, attempts: number } | null}
 */
function normalizeEntry(raw) {
  if (!isPlainObject(raw)) return null

  const boundaryId = usableBoundary(raw.boundaryId)
  if (raw.boundaryId !== undefined && raw.boundaryId !== null && boundaryId === undefined) return null
  if (!Number.isFinite(raw.at)) return null
  if (!Number.isSafeInteger(raw.attempts) || raw.attempts < 0) return null

  const entry = {}
  if (boundaryId !== undefined) entry.boundaryId = boundaryId
  entry.at = raw.at
  entry.attempts = raw.attempts
  return entry
}

/** A boundary id we are willing to persist, or `undefined`. */
function usableBoundary(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** One entry with its keys in the fixed `boundaryId`, `at`, `attempts` order. */
function serializeEntry(entry) {
  const fields = []
  if (entry.boundaryId !== undefined) fields.push(`"boundaryId":${JSON.stringify(entry.boundaryId)}`)
  fields.push(`"at":${JSON.stringify(entry.at)}`)
  fields.push(`"attempts":${JSON.stringify(entry.attempts)}`)
  return `{${fields.join(',')}}`
}

/** Message text used for budget accounting; whitespace-only text costs nothing. */
function messageText(message) {
  return typeof message.text === 'string' ? message.text.trim() : ''
}

/** Plain-object check that rejects arrays and `null`. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
