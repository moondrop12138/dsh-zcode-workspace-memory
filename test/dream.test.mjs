import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_DREAM_MINIMUM_INTERVAL_MS,
  AUTO_DREAM_MIN_SESSIONS,
  AUTO_DREAM_SCAN_THROTTLE_MS,
  DREAM_LOCK_FILE,
  DREAM_LOCK_FRESH_MS,
  DREAM_MAX_DELETES,
  DREAM_MAX_UPDATES,
  acquireDreamLock,
  buildDreamPrompt,
  evaluateDreamTiming,
  parseDreamResponse,
  planDreamWrites,
  readDreamLastConsolidatedAt,
  releaseDreamLock,
  restoreDreamLockAfterFailure,
} from '../lib/dream.js'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

const tempDirs = []

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeMemoryRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dream-'))
  tempDirs.push(dir)
  return dir
}

function lockPathOf(memoryRoot) {
  return join(memoryRoot, DREAM_LOCK_FILE)
}

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function validUpdate(overrides = {}) {
  return {
    name: 'some-fact',
    title: 'Some fact',
    type: 'project',
    description: 'one line',
    body: 'the fact body',
    why: '',
    howToApply: '',
    ...overrides,
  }
}

/* ------------------------------------------------------------- constants */

test('exported constants match the public contract', () => {
  assert.equal(DREAM_LOCK_FILE, '.consolidate-lock')
  assert.equal(DREAM_LOCK_FRESH_MS, 60 * 60 * 1000)
  assert.equal(AUTO_DREAM_MINIMUM_INTERVAL_MS, 24 * 60 * 60 * 1000)
  assert.equal(AUTO_DREAM_SCAN_THROTTLE_MS, 10 * 60 * 1000)
  assert.equal(AUTO_DREAM_MIN_SESSIONS, 5)
  assert.equal(DREAM_MAX_UPDATES, 10)
  assert.equal(DREAM_MAX_DELETES, 10)
})

/* ----------------------------------------------------------------- gates */

test('timing gate: nothing runs inside the 24h minimum interval', () => {
  const nowMs = 1_800_000_000_000
  assert.deepEqual(
    evaluateDreamTiming({
      nowMs,
      lastConsolidatedAtMs: nowMs - (AUTO_DREAM_MINIMUM_INTERVAL_MS - 1),
      lastScanAtMs: 0,
      newSessionCount: 50,
    }),
    { decision: 'skip', reason: 'minimum-interval' },
  )
  // The interval gate outranks the throttle: a recently scanned run still reports it.
  assert.deepEqual(
    evaluateDreamTiming({
      nowMs,
      lastConsolidatedAtMs: nowMs - HOUR,
      lastScanAtMs: nowMs - 1,
      newSessionCount: 50,
    }),
    { decision: 'skip', reason: 'minimum-interval' },
  )
  // Exactly 24h clears the gate.
  assert.deepEqual(
    evaluateDreamTiming({
      nowMs,
      lastConsolidatedAtMs: nowMs - AUTO_DREAM_MINIMUM_INTERVAL_MS,
      lastScanAtMs: nowMs - AUTO_DREAM_SCAN_THROTTLE_MS,
      newSessionCount: AUTO_DREAM_MIN_SESSIONS,
    }),
    { decision: 'scan' },
  )
})

test('timing gate: scans are throttled to one per 10 minutes', () => {
  const nowMs = 1_800_000_000_000
  const base = {
    nowMs,
    lastConsolidatedAtMs: nowMs - 48 * HOUR,
    newSessionCount: 9,
  }
  assert.deepEqual(
    evaluateDreamTiming({ ...base, lastScanAtMs: nowMs - (AUTO_DREAM_SCAN_THROTTLE_MS - 1) }),
    { decision: 'skip', reason: 'scan-throttled' },
  )
  assert.deepEqual(
    evaluateDreamTiming({ ...base, lastScanAtMs: nowMs - 1 }),
    { decision: 'skip', reason: 'scan-throttled' },
  )
  assert.deepEqual(
    evaluateDreamTiming({ ...base, lastScanAtMs: nowMs - AUTO_DREAM_SCAN_THROTTLE_MS }),
    { decision: 'scan' },
  )
})

test('timing gate: five new sessions are required', () => {
  const nowMs = 1_800_000_000_000
  const base = {
    nowMs,
    lastConsolidatedAtMs: nowMs - 48 * HOUR,
    lastScanAtMs: nowMs - 2 * AUTO_DREAM_SCAN_THROTTLE_MS,
  }
  assert.deepEqual(
    evaluateDreamTiming({ ...base, newSessionCount: AUTO_DREAM_MIN_SESSIONS - 1 }),
    { decision: 'skip', reason: 'not-enough-sessions' },
  )
  assert.deepEqual(
    evaluateDreamTiming({ ...base, newSessionCount: 0 }),
    { decision: 'skip', reason: 'not-enough-sessions' },
  )
  assert.deepEqual(
    evaluateDreamTiming({ ...base, newSessionCount: AUTO_DREAM_MIN_SESSIONS }),
    { decision: 'scan' },
  )
  // A missing count is treated as zero, not as a pass.
  assert.deepEqual(
    evaluateDreamTiming({ ...base }),
    { decision: 'skip', reason: 'not-enough-sessions' },
  )
})

/* ------------------------------------------------------------------ lock */

test('lock: no lock is taken over, the directory is created and the pid is stored', async () => {
  const root = await makeMemoryRoot()
  const memoryDir = join(root, 'nested', 'memory')
  const nowMs = Date.now()

  const prior = await acquireDreamLock({ memoryRoot: memoryDir, nowMs })
  assert.equal(prior, 0)
  assert.equal((await readFile(lockPathOf(memoryDir), 'utf8')).trim(), String(process.pid))

  const lastConsolidatedAt = await readDreamLastConsolidatedAt(memoryDir)
  assert.ok(lastConsolidatedAt > 0)
  assert.ok(Math.abs(lastConsolidatedAt - nowMs) < 5000)
})

test('lock: a fresh lock held by a live pid is refused', async () => {
  const root = await makeMemoryRoot()
  await writeFile(lockPathOf(root), String(process.pid), 'utf8')

  const prior = await acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: 4242 })
  assert.equal(prior, null)
  // Refused means the owner's pid was left untouched.
  assert.equal((await readFile(lockPathOf(root), 'utf8')).trim(), String(process.pid))
})

test('lock: a stale lock with a live pid is taken over', async () => {
  const root = await makeMemoryRoot()
  const nowMs = Date.now()
  const staleMtimeMs = nowMs - (DREAM_LOCK_FRESH_MS + HOUR)
  await writeFile(lockPathOf(root), String(process.pid), 'utf8')
  const staleSeconds = staleMtimeMs / 1000
  await utimes(lockPathOf(root), staleSeconds, staleSeconds)

  const prior = await acquireDreamLock({ memoryRoot: root, nowMs, pid: 4242 })
  assert.equal(typeof prior, 'number')
  assert.ok(Math.abs(prior - staleMtimeMs) < 5000)
  assert.equal((await readFile(lockPathOf(root), 'utf8')).trim(), '4242')
  assert.ok((await readDreamLastConsolidatedAt(root)) > staleMtimeMs)
})

test('lock: a fresh lock whose pid is dead is taken over', async () => {
  const root = await makeMemoryRoot()
  const nowMs = Date.now()
  // 999999 is not a live process on any supported platform.
  await writeFile(lockPathOf(root), '999999', 'utf8')

  const prior = await acquireDreamLock({ memoryRoot: root, nowMs, pid: 4242 })
  assert.equal(typeof prior, 'number')
  assert.ok(prior > 0)
  assert.equal((await readFile(lockPathOf(root), 'utf8')).trim(), '4242')
})

test('lock: an unreadable owner (garbage pid) is treated as unowned', async () => {
  const root = await makeMemoryRoot()
  await writeFile(lockPathOf(root), 'not-a-pid', 'utf8')

  const prior = await acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: 4242 })
  assert.equal(typeof prior, 'number')
  assert.equal((await readFile(lockPathOf(root), 'utf8')).trim(), '4242')
})

test('restore: a prior mtime of 0 deletes the lock', async () => {
  const root = await makeMemoryRoot()
  await acquireDreamLock({ memoryRoot: root, nowMs: Date.now() })
  assert.equal(await exists(lockPathOf(root)), true)

  await restoreDreamLockAfterFailure({ memoryRoot: root, priorMtimeMs: 0 })
  assert.equal(await exists(lockPathOf(root)), false)
  assert.equal(await readDreamLastConsolidatedAt(root), 0)
  // Restoring twice must not throw.
  await restoreDreamLockAfterFailure({ memoryRoot: root, priorMtimeMs: 0 })
})

test('restore: a non-zero prior mtime is written back', async () => {
  const root = await makeMemoryRoot()
  await acquireDreamLock({ memoryRoot: root, nowMs: Date.now() })
  const priorMtimeMs = 1_600_000_000_000

  await restoreDreamLockAfterFailure({ memoryRoot: root, priorMtimeMs })
  assert.equal(await exists(lockPathOf(root)), true)
  const restored = (await stat(lockPathOf(root))).mtimeMs
  assert.ok(Math.abs(restored - priorMtimeMs) < 1000, `restored mtime was ${restored}`)
})

test('release: removes the lock and is idempotent', async () => {
  const root = await makeMemoryRoot()
  await acquireDreamLock({ memoryRoot: root, nowMs: Date.now() })
  await releaseDreamLock({ memoryRoot: root })
  assert.equal(await exists(lockPathOf(root)), false)
  assert.equal(await readDreamLastConsolidatedAt(root), 0)

  await releaseDreamLock({ memoryRoot: root })
})

/* ---------------------------------------------------------------- prompt */

test('prompt: carries the four phases, AGENTS.md, the bounds and the JSON contract', () => {
  const prompt = buildDreamPrompt({
    memoryRoot: '/workspace/.dsh/memory',
    indexText: '- [Alpha](alpha.md) — first hook',
    factBriefs: [
      { name: 'alpha', type: 'project', description: 'alpha description', body: 'alpha body text' },
      'legacy-string-brief',
    ],
    sessionIds: ['session-a', 'session-b'],
    activityText: '> user asked for the alpha work\n< done',
  })

  assert.match(prompt, /^# Dream: Memory Consolidation/)
  assert.match(prompt, /Phase 1 — Orient/)
  assert.match(prompt, /Phase 2 — Gather recent signal/)
  assert.match(prompt, /Phase 3 — Consolidate/)
  assert.match(prompt, /Phase 4 — Prune and index/)

  assert.match(prompt, /AGENTS\.md/)
  assert.doesNotMatch(prompt, /CLAUDE\.md/)

  assert.match(prompt, /under 200 lines AND under ~25KB/)
  assert.match(prompt, /under ~150 characters/)
  assert.match(prompt, /no tools/i)

  assert.match(prompt, /- \[Alpha\]\(alpha\.md\) — first hook/)
  assert.match(prompt, /- alpha \[project\]: alpha description/)
  assert.match(prompt, /alpha body text/)
  assert.match(prompt, /legacy-string-brief/)
  assert.match(prompt, /> user asked for the alpha work/)
  assert.match(prompt, /Sessions since the last consolidation \(2\)/)
  assert.match(prompt, /- session-a/)
  assert.match(prompt, /- session-b/)
  assert.match(prompt, /\/workspace\/\.dsh\/memory\//)

  assert.match(prompt, /Return exactly one JSON object and nothing else: \{"updates":\[\{"name":"\.\.\."/)
  assert.match(prompt, /"type":"user\|feedback\|project\|reference"/)
  assert.match(prompt, /At most 10 updates and 10 deletes\./)
  assert.match(prompt, /Reuse an existing name to update it\./)
  assert.match(prompt, /If nothing needs consolidation, return \{"updates":\[\],"deletes":\[\]\}\.$/)
})

test('prompt: missing optional inputs degrade to placeholders', () => {
  const prompt = buildDreamPrompt({ memoryRoot: '/m' })
  assert.match(prompt, /MEMORY\.md does not exist yet — the index is empty/)
  assert.match(prompt, /no fact files exist yet/)
  assert.match(prompt, /no new session activity since the last consolidation/)
  assert.match(prompt, /Sessions since the last consolidation \(0\)/)
  assert.match(prompt, /- \(none recorded\)/)
})

test('prompt: a long fact body is excerpted', () => {
  const prompt = buildDreamPrompt({
    memoryRoot: '/m',
    factBriefs: [{ name: 'long-fact', type: 'reference', description: 'd', body: 'x'.repeat(2000) }],
  })
  const bodyLine = prompt.split('\n').find((line) => line.startsWith('  x'))
  assert.ok(bodyLine !== undefined)
  assert.ok(bodyLine.length < 400, `excerpt was ${bodyLine.length} chars`)
})

/* ----------------------------------------------------------------- reply */

test('parse: tolerates surrounding prose and code fences', () => {
  const text = [
    'Here is the result.',
    '```json',
    JSON.stringify({
      updates: [validUpdate({ name: 'alpha', body: 'alpha body' })],
      deletes: ['stale-name'],
    }),
    '```',
    'Let me know if you need anything else.',
  ].join('\n')

  const parsed = parseDreamResponse(text)
  assert.equal(parsed.parsed, true)
  assert.equal(parsed.updates.length, 1)
  assert.equal(parsed.updates[0].name, 'alpha')
  assert.equal(parsed.updates[0].type, 'project')
  assert.equal(parsed.updates[0].description, 'one line')
  assert.deepEqual(parsed.deletes, ['stale-name'])
})

test('parse: drops invalid types, empty fields and path-like names', () => {
  const text = JSON.stringify({
    updates: [
      validUpdate({ name: 'keep-me' }),
      validUpdate({ name: 'bad-type', type: 'other' }),
      validUpdate({ name: 'missing-type', type: undefined }),
      validUpdate({ name: 'no-title', title: '   ' }),
      validUpdate({ name: 'no-description', description: '' }),
      validUpdate({ name: 'no-body', body: '\n\t ' }),
      validUpdate({ name: '' }),
      validUpdate({ name: '../escape' }),
      validUpdate({ name: 'nested/escape' }),
      'not-an-object',
      null,
      [validUpdate({ name: 'array-entry' })],
    ],
    deletes: ['gone', 42, '', '  ', 'gone', { name: 'x' }],
  })

  const parsed = parseDreamResponse(text)
  assert.equal(parsed.parsed, true)
  assert.deepEqual(parsed.updates.map((update) => update.name), ['keep-me'])
  assert.deepEqual(parsed.deletes, ['gone'])
})

test('parse: dedupes by name with the later entry winning', () => {
  const text = JSON.stringify({
    updates: [
      validUpdate({ name: 'alpha', body: 'older body' }),
      validUpdate({ name: 'beta', body: 'beta body' }),
      validUpdate({ name: 'alpha', body: 'newer body', description: 'newer line' }),
    ],
    deletes: ['alpha'],
  })

  const parsed = parseDreamResponse(text)
  assert.deepEqual(parsed.updates.map((update) => update.name), ['alpha', 'beta'])
  const alpha = parsed.updates.find((update) => update.name === 'alpha')
  assert.equal(alpha.body, 'newer body')
  assert.equal(alpha.description, 'newer line')
})

test('parse: caps updates and deletes at the published limits', () => {
  const updates = Array.from({ length: DREAM_MAX_UPDATES + 3 }, (_value, index) => {
    return validUpdate({ name: `fact-${index}`, body: `body ${index}` })
  })
  const deletes = Array.from({ length: DREAM_MAX_DELETES + 3 }, (_value, index) => `old-${index}`)

  const parsed = parseDreamResponse(JSON.stringify({ updates, deletes }))
  assert.equal(parsed.updates.length, DREAM_MAX_UPDATES)
  assert.equal(parsed.deletes.length, DREAM_MAX_DELETES)
  assert.equal(parsed.updates[0].name, 'fact-0')
  assert.equal(parsed.updates.at(-1).name, `fact-${DREAM_MAX_UPDATES - 1}`)
  assert.equal(parsed.deletes.at(-1), `old-${DREAM_MAX_DELETES - 1}`)
})

test('parse: an unparseable reply yields empty results and parsed false', () => {
  for (const text of ['no json at all', '', undefined, null, '[1,2,3]']) {
    assert.deepEqual(parseDreamResponse(text), { updates: [], deletes: [], parsed: false })
  }
  assert.deepEqual(
    parseDreamResponse('{"updates":"nope","deletes":[]}'),
    { updates: [], deletes: [], parsed: false },
  )
})

test('parse: an empty consolidation reply is a parsed no-op', () => {
  const parsed = parseDreamResponse('{"updates":[],"deletes":[]}')
  assert.deepEqual(parsed, { updates: [], deletes: [], parsed: true })
})

/* ------------------------------------------------------------ planWrites */

test('planDreamWrites: maps updates to memories and deletes to forget', () => {
  const plan = {
    updates: [
      validUpdate({
        name: 'alpha',
        title: 'Alpha',
        type: 'feedback',
        description: 'alpha one line',
        body: 'alpha body',
        why: 'because',
        howToApply: 'do the thing',
      }),
    ],
    deletes: ['stale-one', 'stale-two'],
  }

  assert.deepEqual(planDreamWrites(plan), {
    memories: [
      {
        name: 'alpha',
        title: 'Alpha',
        type: 'feedback',
        description: 'alpha one line',
        body: 'alpha body',
        why: 'because',
        howToApply: 'do the thing',
      },
    ],
    forget: ['stale-one', 'stale-two'],
  })
})

test('planDreamWrites: missing and malformed entries degrade to empty plans', () => {
  assert.deepEqual(planDreamWrites(undefined), { memories: [], forget: [] })
  assert.deepEqual(planDreamWrites({}), { memories: [], forget: [] })

  const mapped = planDreamWrites({
    updates: [null, 7, [], { name: 'no-body' }, validUpdate({ name: 'ok' })],
    deletes: [1, '', '  ', 'dup', 'dup'],
  })
  assert.deepEqual(mapped.memories.map((memory) => memory.name), ['ok'])
  assert.equal(mapped.memories[0].why, '')
  assert.equal(mapped.memories[0].howToApply, '')
  assert.deepEqual(mapped.forget, ['dup'])
})

test('planDreamWrites: a full round trip keeps parsed fields intact', () => {
  const reply = JSON.stringify({
    updates: [
      validUpdate({ name: 'round-trip', title: 'Round trip', body: 'kept verbatim', why: 'w', howToApply: 'h' }),
    ],
    deletes: ['old'],
  })
  const plan = planDreamWrites(parseDreamResponse(reply))
  assert.deepEqual(plan.memories, [
    {
      name: 'round-trip',
      title: 'Round trip',
      type: 'project',
      description: 'one line',
      body: 'kept verbatim',
      why: 'w',
      howToApply: 'h',
    },
  ])
  assert.deepEqual(plan.forget, ['old'])
})
