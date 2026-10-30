/**
 * W4 — extraction cursor.
 *
 * The cursor is the only durable record of "which turn was already mined for
 * memories", so it has to survive a corrupt file (fall back to a full replay,
 * never crash), move only on outcomes that actually consumed the turn, and
 * hand the extractor a bounded window instead of an unbounded transcript.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CURSOR_MAX_PENDING_CHARS,
  CURSOR_VERSION,
  advanceCursor,
  emptyCursor,
  parseCursor,
  pendingWindow,
  serializeCursor,
} from '../lib/cursor.js'

/** A cursor with one recorded session. */
function cursorWith(sessionId, boundaryId, extra = {}) {
  return {
    version: CURSOR_VERSION,
    sessions: { [sessionId]: { boundaryId, at: 1000, attempts: 0, ...extra } },
  }
}

const MESSAGES = [
  { id: 'm1', text: 'first turn' },
  { id: 'm2', text: 'second turn' },
  { id: 'm3', text: 'third turn' },
]

test('exports the frozen contract values', () => {
  assert.equal(CURSOR_VERSION, 1)
  assert.equal(CURSOR_MAX_PENDING_CHARS, 24000)
})

test('emptyCursor starts at version 1 with no sessions', () => {
  const cursor = emptyCursor()
  assert.deepEqual(cursor, { version: CURSOR_VERSION, sessions: {} })
  assert.deepEqual(Object.keys(cursor).sort(), ['sessions', 'version'])

  // A returned cursor is caller-owned: mutating it cannot poison later calls.
  cursor.sessions.leak = { at: 1, attempts: 0 }
  assert.deepEqual(emptyCursor(), { version: CURSOR_VERSION, sessions: {} })
})

test('parseCursor falls back to an empty cursor for unusable input', () => {
  const empty = emptyCursor()
  for (const input of ['', '   ', 'not json', '{', 'null', '[]', '"text"', '42', '{"sessions":{}}']) {
    assert.deepEqual(parseCursor(input), empty, `input: ${JSON.stringify(input)}`)
  }
  for (const input of [undefined, null, 42, {}, []]) {
    assert.deepEqual(parseCursor(input), empty, `input: ${String(input)}`)
  }
})

test('parseCursor rejects a different schema version instead of guessing', () => {
  const future = '{"version":2,"sessions":{"s1":{"at":5,"attempts":0}}}'
  assert.deepEqual(parseCursor(future), emptyCursor())
  const legacy = '{"version":0,"sessions":{}}'
  assert.deepEqual(parseCursor(legacy), emptyCursor())
})

test('parseCursor keeps valid entries and drops malformed ones', () => {
  const raw = JSON.stringify({
    version: CURSOR_VERSION,
    sessions: {
      good: { boundaryId: 'm9', at: 1700000000000, attempts: 2 },
      noBoundary: { at: 1, attempts: 0 },
      emptyBoundary: { boundaryId: '', at: 1, attempts: 0 },
      badBoundary: { boundaryId: 7, at: 1, attempts: 0 },
      badAt: { boundaryId: 'm1', at: 'yesterday', attempts: 0 },
      badAttempts: { boundaryId: 'm1', at: 1, attempts: -1 },
      floatAttempts: { boundaryId: 'm1', at: 1, attempts: 1.5 },
      notObject: 'nope',
      nullEntry: null,
    },
  })

  assert.deepEqual(parseCursor(raw), {
    version: CURSOR_VERSION,
    sessions: {
      good: { boundaryId: 'm9', at: 1700000000000, attempts: 2 },
      noBoundary: { at: 1, attempts: 0 },
    },
  })
})

test('parseCursor tolerates a non-object sessions map', () => {
  assert.deepEqual(parseCursor('{"version":1,"sessions":[]}'), emptyCursor())
  assert.deepEqual(parseCursor('{"version":1,"sessions":"oops"}'), emptyCursor())
})

test('serializeCursor is stable for equal state and sorted by session id', () => {
  const forward = {
    version: CURSOR_VERSION,
    sessions: {
      alpha: { boundaryId: 'm2', at: 20, attempts: 0 },
      zeta: { at: 10, attempts: 3 },
      mike: { boundaryId: 'm7', at: 30, attempts: 1 },
    },
  }
  const reversed = {
    version: CURSOR_VERSION,
    sessions: {
      mike: { at: 30, boundaryId: 'm7', attempts: 1 },
      zeta: { attempts: 3, at: 10 },
      alpha: { attempts: 0, at: 20, boundaryId: 'm2' },
    },
  }

  const text = serializeCursor(forward)
  assert.equal(serializeCursor(reversed), text)
  assert.equal(serializeCursor(forward), text)
  assert.equal(text, serializeCursor(parseCursor(text)))

  assert.equal(
    text,
    '{"version":1,"sessions":{"alpha":{"boundaryId":"m2","at":20,"attempts":0},"mike":{"boundaryId":"m7","at":30,"attempts":1},"zeta":{"at":10,"attempts":3}}}',
  )
  assert.deepEqual(parseCursor(text), {
    version: CURSOR_VERSION,
    sessions: {
      alpha: { boundaryId: 'm2', at: 20, attempts: 0 },
      mike: { boundaryId: 'm7', at: 30, attempts: 1 },
      zeta: { at: 10, attempts: 3 },
    },
  })
})

test('serializeCursor keeps integer-like session ids out of numeric order', () => {
  const state = {
    version: CURSOR_VERSION,
    sessions: {
      b: { at: 1, attempts: 0 },
      '10': { at: 1, attempts: 0 },
      '2': { at: 1, attempts: 0 },
      a: { at: 1, attempts: 0 },
    },
  }
  const text = serializeCursor(state)
  const positions = ['10', '2', 'a', 'b'].map((id) => text.indexOf(`"${id}":{"`))
  assert.ok(positions.every((position) => position >= 0), text)
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
    'serialized ids must be ascending by code unit, not numeric',
  )
})

test('serializeCursor degrades garbage to a valid empty document', () => {
  for (const bad of [undefined, null, 'text', 42, [], { version: 2, sessions: { s: { at: 1, attempts: 0 } } }]) {
    assert.equal(serializeCursor(bad), '{"version":1,"sessions":{}}')
  }
})

test('success / no-op / skip move the boundary and clear attempts', () => {
  for (const status of ['success', 'no-op', 'skip']) {
    const before = cursorWith('s1', 'm1', { attempts: 3 })
    const after = advanceCursor(before, { sessionId: 's1', status, boundaryId: 'm5', nowMs: 2000 })
    assert.deepEqual(after, {
      version: CURSOR_VERSION,
      sessions: { s1: { boundaryId: 'm5', at: 2000, attempts: 0 } },
    })
    assert.deepEqual(before, cursorWith('s1', 'm1', { attempts: 3 }), 'input must not be mutated')
  }
})

test('success keeps the old boundary when no new one is supplied', () => {
  const before = cursorWith('s1', 'm1', { attempts: 2 })
  const after = advanceCursor(before, { sessionId: 's1', status: 'no-op', nowMs: 500 })
  assert.deepEqual(after.sessions.s1, { boundaryId: 'm1', at: 500, attempts: 0 })
})

test('error / abort hold the boundary and increment attempts', () => {
  for (const status of ['error', 'abort']) {
    const before = cursorWith('s1', 'm1', { attempts: 1 })
    const after = advanceCursor(before, { sessionId: 's1', status, boundaryId: 'm5', nowMs: 3000 })
    assert.deepEqual(after.sessions.s1, { boundaryId: 'm1', at: 3000, attempts: 2 })
    assert.equal(before.sessions.s1.attempts, 1, 'input must not be mutated')
  }

  let cursor = cursorWith('s1', 'm1')
  for (const status of ['error', 'abort', 'error']) {
    cursor = advanceCursor(cursor, { sessionId: 's1', status, nowMs: 1 })
  }
  assert.equal(cursor.sessions.s1.attempts, 3)
  assert.equal(cursor.sessions.s1.boundaryId, 'm1')
})

test('advanceCursor records a new session without inventing a boundary', () => {
  const after = advanceCursor(emptyCursor(), { sessionId: 'fresh', status: 'error', nowMs: 10 })
  assert.deepEqual(after.sessions.fresh, { at: 10, attempts: 1 })

  const advanced = advanceCursor(after, { sessionId: 'fresh', status: 'success', nowMs: 11 })
  assert.deepEqual(advanced.sessions.fresh, { at: 11, attempts: 0 })
})

test('advanceCursor keeps other sessions untouched', () => {
  const before = {
    version: CURSOR_VERSION,
    sessions: {
      s1: { boundaryId: 'm1', at: 1, attempts: 0 },
      s2: { boundaryId: 'm9', at: 2, attempts: 4 },
    },
  }
  const after = advanceCursor(before, { sessionId: 's2', status: 'success', boundaryId: 'm12', nowMs: 99 })
  assert.deepEqual(after.sessions.s1, { boundaryId: 'm1', at: 1, attempts: 0 })
  assert.deepEqual(after.sessions.s2, { boundaryId: 'm12', at: 99, attempts: 0 })
})

test('advanceCursor rejects a missing session id or unknown status', () => {
  assert.throws(() => advanceCursor(emptyCursor(), { status: 'success' }), TypeError)
  assert.throws(() => advanceCursor(emptyCursor(), { sessionId: '', status: 'success' }), TypeError)
  assert.throws(
    () => advanceCursor(emptyCursor(), { sessionId: 's1', status: 'aborted' }),
    /unknown status/,
  )
  assert.throws(() => advanceCursor(emptyCursor(), undefined), TypeError)
})

test('advanceCursor survives a corrupt state by starting from empty', () => {
  const after = advanceCursor({ version: 9, sessions: { s1: 'garbage' } }, {
    sessionId: 's1',
    status: 'success',
    boundaryId: 'm3',
    nowMs: 7,
  })
  assert.deepEqual(after, {
    version: CURSOR_VERSION,
    sessions: { s1: { boundaryId: 'm3', at: 7, attempts: 0 } },
  })
})

test('pendingWindow starts strictly after the boundary', () => {
  const window = pendingWindow(MESSAGES, cursorWith('s1', 'm2'), { sessionId: 's1' })
  assert.deepEqual(window.messages, [{ id: 'm3', text: 'third turn' }])
  assert.equal(window.dropped, 0)
  assert.equal(window.boundaryId, 'm3')
})

test('pendingWindow returns every message when the session has no boundary', () => {
  for (const cursor of [emptyCursor(), cursorWith('other', 'm2'), undefined]) {
    const window = pendingWindow(MESSAGES, cursor, { sessionId: 's1' })
    assert.deepEqual(window.messages, MESSAGES)
    assert.equal(window.dropped, 0)
    assert.equal(window.boundaryId, 'm3')
  }
})

test('pendingWindow cuts at the budget and reports how many messages it dropped', () => {
  const messages = [
    { id: 'm1', text: 'x'.repeat(10) },
    { id: 'm2', text: 'y'.repeat(10) },
    { id: 'm3', text: 'z'.repeat(10) },
    { id: 'm4', text: 'w'.repeat(10) },
  ]
  const window = pendingWindow(messages, emptyCursor(), { sessionId: 's1', maxChars: 25 })
  assert.deepEqual(window.messages.map((message) => message.id), ['m1', 'm2'])
  assert.equal(window.dropped, 2)
  assert.equal(window.boundaryId, 'm2')

  const afterBoundary = pendingWindow(messages, cursorWith('s1', 'm1'), {
    sessionId: 's1',
    maxChars: 20,
  })
  assert.deepEqual(afterBoundary.messages.map((message) => message.id), ['m2', 'm3'])
  assert.equal(afterBoundary.dropped, 1)
  assert.equal(afterBoundary.boundaryId, 'm3')
})

test('pendingWindow counts trimmed text and drops whitespace-only weight', () => {
  const messages = [
    { id: 'm1', text: '  ab  ' },
    { id: 'm2', text: '   ' },
    { id: 'm3', text: 'cdef' },
  ]
  const window = pendingWindow(messages, emptyCursor(), { sessionId: 's1', maxChars: 3 })
  assert.deepEqual(window.messages.map((message) => message.id), ['m1', 'm2'])
  assert.equal(window.dropped, 1)
})

test('pendingWindow applies the 24000-char default budget', () => {
  const chunk = 'a'.repeat(10000)
  const messages = [1, 2, 3, 4].map((index) => ({ id: `m${index}`, text: chunk }))
  const window = pendingWindow(messages, emptyCursor(), { sessionId: 's1' })
  assert.deepEqual(window.messages.map((message) => message.id), ['m1', 'm2'])
  assert.equal(window.dropped, 2)
})

test('pendingWindow yields an empty window and keeps the boundary when nothing fits', () => {
  const messages = [{ id: 'm1', text: 'x'.repeat(50) }]
  const window = pendingWindow(messages, emptyCursor(), { sessionId: 's1', maxChars: 0 })
  assert.deepEqual(window.messages, [])
  assert.equal(window.dropped, 1)
  assert.equal(window.boundaryId, undefined)

  const withBoundary = pendingWindow(messages, cursorWith('s1', 'm0'), {
    sessionId: 's1',
    maxChars: 10,
  })
  assert.deepEqual(withBoundary.messages, [])
  assert.equal(withBoundary.dropped, 1)
  assert.equal(withBoundary.boundaryId, 'm0')
})

test('pendingWindow with nothing pending keeps the boundary and drops nothing', () => {
  for (const boundaryId of ['m3', 'm-unknown']) {
    const window = pendingWindow(MESSAGES, cursorWith('s1', boundaryId), { sessionId: 's1' })
    assert.equal(window.dropped, 0)
    if (boundaryId === 'm3') {
      assert.deepEqual(window.messages, [])
      assert.equal(window.boundaryId, 'm3')
    } else {
      // A boundary that left the history degrades to "no boundary" (upstream
      // `messagesAfterFoundCursor` returns undefined and callers replay all).
      assert.deepEqual(window.messages, MESSAGES)
      assert.equal(window.boundaryId, 'm3')
    }
  }

  assert.deepEqual(pendingWindow([], emptyCursor(), { sessionId: 's1' }), {
    messages: [],
    dropped: 0,
    boundaryId: undefined,
  })
})

test('pendingWindow ignores unusable input and bad budgets', () => {
  assert.deepEqual(pendingWindow(undefined, undefined, undefined), {
    messages: [],
    dropped: 0,
    boundaryId: undefined,
  })

  const withJunk = [{ id: 'm1', text: 'a' }, { text: 'no id' }, null, { id: '', text: 'b' }]
  const window = pendingWindow(withJunk, emptyCursor(), { sessionId: 's1' })
  assert.deepEqual(window.messages, [{ id: 'm1', text: 'a' }])
  assert.equal(window.dropped, 0)

  for (const maxChars of [-5, 1.5, NaN, '100', null]) {
    const fallback = pendingWindow(MESSAGES, emptyCursor(), { sessionId: 's1', maxChars })
    assert.deepEqual(fallback.messages, MESSAGES, `maxChars: ${String(maxChars)}`)
  }
})

test('pendingWindow and advanceCursor compose without mutating the cursor', () => {
  const cursor = cursorWith('s1', 'm1', { attempts: 0 })
  const window = pendingWindow(MESSAGES, cursor, { sessionId: 's1' })
  assert.equal(window.boundaryId, 'm3')

  const next = advanceCursor(cursor, { sessionId: 's1', status: 'success', boundaryId: window.boundaryId, nowMs: 42 })
  assert.deepEqual(next.sessions.s1, { boundaryId: 'm3', at: 42, attempts: 0 })
  assert.deepEqual(cursor.sessions.s1, { boundaryId: 'm1', at: 1000, attempts: 0 })

  // The next window is empty: the same turn is never extracted twice.
  assert.deepEqual(pendingWindow(MESSAGES, next, { sessionId: 's1' }).messages, [])

  // A failed turn leaves the same work pending.
  const failed = advanceCursor(next, { sessionId: 's1', status: 'error', boundaryId: 'm9', nowMs: 43 })
  assert.deepEqual(pendingWindow(MESSAGES, failed, { sessionId: 's1' }).messages, [])
  assert.equal(failed.sessions.s1.boundaryId, 'm3')
  assert.equal(failed.sessions.s1.attempts, 1)
})
