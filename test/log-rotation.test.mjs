import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { __internals } from '../lib/host.js'

const { log, debug, LOG_PATH, LOG_ROTATED_PATH, LOG_ROTATE_BYTES } = __internals

/** Reset the journal and its previous generation before each scenario. */
async function resetLog() {
  try { truncateSync(LOG_PATH, 0) } catch { /* absent is fine */ }
  await rm(LOG_ROTATED_PATH, { force: true })
}

test('a journal past 1 MiB rotates to .log.1 and keeps one generation', async () => {
  await resetLog()
  try {
    // Two rotations: the first .log.1 generation must be replaced, not shifted.
    for (let round = 0; round < 2; round += 1) {
      writeFileSync(LOG_PATH, 'x'.repeat(LOG_ROTATE_BYTES + 1) + `\nround ${round}\n`)
      log('rotation-test-line ' + round)
      assert.equal(existsSync(LOG_PATH), true)
      const rotated = readFileSync(LOG_ROTATED_PATH, 'utf8')
      assert.ok(rotated.includes(`round ${round}`), 'the oversized file moved to .log.1')
      const fresh = readFileSync(LOG_PATH, 'utf8')
      assert.ok(fresh.includes('rotation-test-line ' + round), 'the append lands in the fresh file')
      assert.ok(fresh.length < LOG_ROTATE_BYTES, 'the fresh file starts small')
    }
    // One generation only: .log.1 holds the *previous* journal, never an
    // accumulation of older rounds. Size is deliberately not asserted here —
    // every test file in this run appends to the same journal path in tmpdir,
    // so a byte count is no stable property.
    const lastGeneration = readFileSync(LOG_ROTATED_PATH, 'utf8')
    assert.ok(lastGeneration.includes('round 1'), 'the newest oversized file is the retained generation')
    assert.ok(!lastGeneration.includes('round 0'), 'the older generation was replaced, not shifted')
  } finally {
    await resetLog()
  }
})

test('a journal under the cap is appended without rotation', async () => {
  await resetLog()
  try {
    writeFileSync(LOG_PATH, 'seed\n')
    log('rotation-test-keep')
    assert.equal(existsSync(LOG_ROTATED_PATH), false, 'no .log.1 below the cap')
    const journal = readFileSync(LOG_PATH, 'utf8')
    assert.ok(journal.startsWith('seed\n'))
    assert.ok(journal.includes('rotation-test-keep'), 'the line still appends')
  } finally {
    await resetLog()
  }
})

test('debugLog gates debug lines; log lines and errors always append', async () => {
  await resetLog()
  try {
    const off = { config: { debugLog: false } }
    const on = { config: { debugLog: true } }
    debug(off, 'gate-marker-off')
    log('always-marker')
    debug(on, 'gate-marker-on')
    const journal = readFileSync(LOG_PATH, 'utf8')
    assert.ok(!journal.includes('gate-marker-off'), 'debugLog=false writes nothing')
    assert.ok(journal.includes('debug: gate-marker-on'), 'debugLog=true writes the line')
    assert.ok(journal.includes('always-marker'), 'log() is never gated')
  } finally {
    await resetLog()
  }
})

test('rotation survives an unwritable rename and still appends', async () => {
  await resetLog()
  try {
    // An existing .log.1 directory makes renameSync fail; log() must swallow
    // it and keep journaling into the oversized file.
    mkdirSync(LOG_ROTATED_PATH)
    writeFileSync(LOG_PATH, 'x'.repeat(LOG_ROTATE_BYTES + 1) + '\nblocked\n')
    log('rotation-test-recovered')
    assert.equal(existsSync(LOG_PATH), true)
    const journal = readFileSync(LOG_PATH, 'utf8')
    assert.ok(journal.includes('rotation-test-recovered'), 'the append survives the failed rename')
  } finally {
    await rm(LOG_ROTATED_PATH, { force: true, recursive: true })
    await resetLog()
  }
})

test('rotation keeps working through an absent journal file', async () => {
  await resetLog()
  try {
    try { unlinkSync(LOG_PATH) } catch { /* already absent */ }
    log('rotation-test-first-line')
    const journal = readFileSync(LOG_PATH, 'utf8')
    assert.ok(journal.includes('rotation-test-first-line'))
    assert.equal(existsSync(LOG_ROTATED_PATH), false)
  } finally {
    await resetLog()
  }
})
