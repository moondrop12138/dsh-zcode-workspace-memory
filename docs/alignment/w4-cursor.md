# W4 — Extraction cursor (`lib/cursor.js`)

Status: implemented, `node --test test/cursor.test.mjs` green (25 cases).
Owner module: `lib/cursor.js` (pure, zero dependencies, no `memory-core.js` import).
Upstream reference: ZCode `apps/zcode-cli/packages/core/src/memory/extraction.ts` (Apache-2.0).

## Why this module exists

Background extraction must never mine the same turn twice, must never lose the
turn it failed on, and must never hand the model an unbounded transcript. ZCode
solves that with a single in-memory `let cursor: MessageId | undefined` inside
`createMemoryExtractionScheduler`. DSH runs extraction from a plugin process
that can restart, holds several sessions per workspace, and persists its state
to `.dsh/memory/`, so the position has to be a serializable, per-session,
schema-versioned snapshot. The decision logic is upstream's; the storage and
the bounded window are new.

## Exported contract

```js
export const CURSOR_VERSION = 1
export const CURSOR_MAX_PENDING_CHARS = 24000

emptyCursor()            // -> { version: 1, sessions: {} }
parseCursor(text)        // -> { version, sessions } | emptyCursor()
serializeCursor(state)   // -> string, stable byte output
advanceCursor(state, { sessionId, status, boundaryId, nowMs })
pendingWindow(messages, cursor, { sessionId, maxChars })
```

Session entry shape — every stored session is exactly this:

```js
{ boundaryId?: string, at: number, attempts: number }
```

- `boundaryId` — the last message id already consumed; absent means "nothing
  consumed yet" (first run).
- `at` — epoch ms of the most recent `advanceCursor` outcome (success *or*
  failure), so the host can render "last attempt 3 min ago".
- `attempts` — consecutive failed advances (`error`/`abort`); reset to `0` by any
  advancing status. Used for backoff and for giving up after N failures.

### `parseCursor(text)`

Tolerance is deliberate and one-directional — every unusable input collapses to
`emptyCursor()` (i.e. "replay the whole history"), never to a later boundary:

| input | result |
| --- | --- |
| non-string (incl. `undefined`/`null`), `''`, whitespace | `emptyCursor()` |
| invalid JSON (`'{'`, `'not json'`) | `emptyCursor()` |
| JSON that is not an object (`'null'`, `'[]'`, `'"x"'`, `'42'`) | `emptyCursor()` |
| `version` missing or `!== 1` | `emptyCursor()` |
| `sessions` missing / not a plain object | valid cursor with no sessions |
| entry with non-string or empty `boundaryId` | that entry dropped |
| entry with non-finite `at`, or `attempts` not a non-negative integer | that entry dropped |

Dropping a bad entry only costs a re-extraction for that one session; throwing
would disable extraction for the whole workspace, so a single corrupt session
must not take the file down with it.

### `serializeCursor(state)`

Byte-stable: equal states produce equal strings, and
`serializeCursor(parseCursor(serializeCursor(x))) === serializeCursor(x)`.
Emitted key order is fixed — `version`, then `sessions`, then each entry as
`boundaryId` (only when present), `at`, `attempts` — and session ids are sorted
ascending by code unit. Sorting is done by hand rather than relying on object
key order because `JSON.stringify` hoists integer-like keys (`"2"` before
`"10"`), which would make the file churn as ids change. Garbage input
serializes to `{"version":1,"sessions":{}}` instead of throwing.

### `advanceCursor(state, { sessionId, status, boundaryId, nowMs })`

| status | boundary | attempts | `at` |
| --- | --- | --- | --- |
| `success` / `no-op` / `skip` | overwritten by `boundaryId` (kept if omitted) | `0` | `nowMs` |
| `error` / `abort` | unchanged | `previous + 1` | `nowMs` |

Returns a new cursor; the input is never mutated (sessions map is copied).
`nowMs` defaults to `Date.now()`; tests always pass it. `sessionId` must be a
non-empty string and `status` must be one of the five values, otherwise
`TypeError` — a bad status is caller code and should fail loudly, unlike a bad
*file*, which is data and must be absorbed.

`skip` advancing is upstream behavior (`processSnapshot` moves the cursor to
`snapshotEnd` on a skip decision), made explicit here: a skip still consumed the
turn, otherwise every skipped turn would be re-evaluated forever.

### `pendingWindow(messages, cursor, { sessionId, maxChars })`

`messages` is `[{ id, text }]` in chronological order. Returns
`{ messages, dropped, boundaryId }`:

- start strictly **after** the session's `boundaryId`;
- take a contiguous prefix while the running total of **trimmed** `text.length`
  stays `<= maxChars` (default `CURSOR_MAX_PENDING_CHARS = 24000`, which mirrors
  `MAX_TRANSCRIPT_CHARS`);
- `dropped` — how many messages after the boundary the budget discarded;
- `boundaryId` — id of the last message in the window, else the session's
  existing boundary; the caller passes it straight to
  `advanceCursor({ status: 'success', boundaryId })`.

Edge behavior, all intentional:

- **No boundary / unknown session / no cursor** → window starts at message 0
  (upstream: `messagesAfterFoundCursor` returns `undefined` and callers fall
  back to the full list). Never returns "nothing" for a stale boundary.
- **Boundary no longer in `messages`** → same as no boundary: replay everything.
- **Nothing fits** (`maxChars: 0`, or a single message longer than the budget) →
  empty window, `dropped === all`, boundary unchanged. The cap is strict; the
  caller is expected to segment long turns (`buildTranscriptSegments` in
  `lib/memory-core.js`) rather than have this module exceed its own bound.
  A stuck oversized turn shows up as `dropped > 0 && messages.length === 0`.
- **Whitespace-only text** costs zero characters but stays in the window, so the
  boundary still moves past it; entries without a non-empty string `id` are
  filtered out and never counted as `dropped`.
- Invalid `maxChars` (negative, fractional, `NaN`, non-number) falls back to the
  24000 default rather than silently disabling the cap.

## Integration notes (for the Lead)

1. Load on host start: `parseCursor(await readFile(cursorPath, 'utf8'))`; write
   back only when `serializeCursor(next) !== previousText`, which the stable
   serialization makes cheap to check.
2. Before extracting: `const window = pendingWindow(durableMessages, cursor, { sessionId })`.
   If `window.messages.length === 0` there is nothing to do — but if
   `window.dropped > 0`, the first pending message alone exceeds the budget and
   the caller must segment instead of retrying.
3. After extraction, always record the outcome — including
   `advanceCursor(next, { sessionId, status: 'error' })` — so `attempts` reflects
   reality and a later run can back off. `abort` (plugin unload, session
   disposed) is held, not advanced, exactly like upstream's shutdown path.
4. Cursor state belongs next to the memory directory (`.dsh/memory/`), not in
   the memory index; `MEMORY.md` must stay hand-editable.

## Deviations from upstream

- Per-session map + `version` instead of one `MessageId | undefined` per
  scheduler instance; the file survives restarts.
- `attempts` and `at` are new; upstream has no failure counter.
- `skip` is a distinct status (upstream folds it into a silent cursor move).
- The pending window is char-bounded and returns `dropped`; upstream slices the
  durable list and caps later inside `buildTranscript`.
- Unknown-status handling throws (upstream's `execute` union is type-checked at
  compile time; here it is runtime data, so the call site is checked instead).
