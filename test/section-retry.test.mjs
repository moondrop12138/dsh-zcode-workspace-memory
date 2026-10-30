import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, sectionRetryStateOf } from '../lib/host.js'

const LOG_PATH = join(tmpdir(), 'workspace-memory-host.log')

/** Minimal in-memory filesystem implementing the `ctx.fs` subset used here. */
function createFakeFs() {
  const files = new Map()
  const writes = []
  const resolve = async (path) => ({ targetKey: path, displayPath: path })
  const statOf = async (target) => {
    const key = target.displayPath
    if (files.has(key)) return { version: 'v1', type: 'file', size: files.get(key).length }
    for (const existing of files.keys()) {
      if (existing.startsWith(key + '\\') || existing.startsWith(key + '/')) {
        return { version: 'v1', type: 'directory' }
      }
    }
    return undefined
  }
  return {
    files,
    writes,
    resolve,
    stat: statOf,
    readText: async (target) => files.get(target.displayPath),
    listDir: async (target) => {
      // Accept either separator so a POSIX fixture directory is not searched
      // for as "...\".
      const trimmed = target.displayPath.replace(/[\\/]+$/, '')
      const prefixes = [trimmed + '\\', trimmed + '/']
      const entries = []
      for (const [key, value] of files) {
        const prefix = prefixes.find((candidate) => key.startsWith(candidate) && key !== trimmed)
        if (prefix === undefined) continue
        const rest = key.slice(prefix.length)
        if (rest.includes('\\') || rest.includes('/')) continue
        entries.push({ name: rest, type: 'file', target: { targetKey: key, displayPath: key }, size: value.length })
      }
      if (entries.length === 0) throw new Error('FS_NOT_FOUND')
      return entries
    },
    writeText: async (target, content) => {
      const before = files.get(target.displayPath) ?? null
      files.set(target.displayPath, content)
      writes.push({ path: target.displayPath, content })
      return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content }
    },
    contains: () => true,
  }
}

/**
 * Make every index read fail: readFileState short-circuits on fs.stat before
 * readText, and repairIndex rebuilds pointers from listDir, so all three must
 * fail for the section to stay genuinely index-less.
 */
function failAllReads(fs, message) {
  const original = { stat: fs.stat.bind(fs), readText: fs.readText.bind(fs), listDir: fs.listDir.bind(fs) }
  fs.stat = async () => { throw new Error(message) }
  fs.readText = async () => { throw new Error(message) }
  fs.listDir = async () => { throw new Error(message) }
  return () => {
    fs.stat = original.stat
    fs.readText = original.readText
    fs.listDir = original.listDir
  }
}

/** Minimal fake Cordis context capturing registrations. */
function createFakeCtx(services) {
  const handlers = new Map()
  const disposers = []
  const ctx = {
    services,
    handlers,
    sections: [],
    rpcRoutes: [],
    get: (name) => services[name],
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const current = handlers.get(name) ?? []
        handlers.set(name, current.filter((item) => item !== handler))
      }
    },
    disposeAll: () => {
      for (const dispose of disposers.splice(0)) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  return ctx
}

/** Minimal fake Agent. */
function createFakeAgent(sessionId, cwd) {
  return {
    id: sessionId,
    options: { provider: 'agent-provider', model: 'agent-model' },
    session: {
      id: sessionId,
      header: { cwd },
      requestContext: () => ({ provider: 'ctx-provider', model: 'ctx-model' }),
      requestHeader: () => ({ config: { provider: 'header-provider', model: 'header-model' } }),
    },
    ctx: {},
  }
}

/** Wait until `predicate` holds, or fail after the deadline. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 10))
  }
}

/** Register the services the plugin needs and apply it to the fake context. */
function createPluginHarness(fs, agent) {
  const ctxRef = createFakeCtx({
    systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: agent.session.header.cwd }) },
  })
  apply(ctxRef, {})
  return ctxRef
}

const fact = (name, description, type) => '---\nname: ' + name + '\ndescription: ' + description
  + '\nmetadata:\n  node_type: memory\n  type: ' + type + '\n---\nbody\n'

/** Pull one retry attempt forward so the next section read schedules it now. */
function expediteRetry(agent) {
  const state = sectionRetryStateOf(agent)
  if (state) state.nextAtMs = 0
  return state
}

test('a failed init index read is retried on the next section read and then succeeds', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-retry-'))
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    fs.files.set(join(memoryDir, 'alpha.md'), fact('alpha', 'first fact', 'user'))
    const restore = failAllReads(fs, 'boom')
    const agent = createFakeAgent('sess_retry', workspace)
    const ctxRef = createPluginHarness(fs, agent)
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionRetryStateOf(agent) !== undefined), true)

      // The init read failed, so the section carries no pointer yet.
      assert.equal(sectionText().includes('alpha.md'), false)
      const state = sectionRetryStateOf(agent)
      assert.equal(state.attempts, 0)

      // This first read schedules retry attempt 1, which still fails.
      assert.equal(sectionText().includes('alpha.md'), false)
      assert.equal(await waitFor(() => (sectionRetryStateOf(agent) ?? { attempts: -1 }).attempts >= 1), true)
      assert.ok(sectionRetryStateOf(agent).nextAtMs > Date.now())

      // Expend the backoff and stop failing; the retry rebuilds the index.
      restore()
      expediteRetry(agent)
      assert.equal(sectionText().includes('alpha.md'), false)
      assert.equal(await waitFor(() => sectionText().includes('alpha.md')), true)
      assert.equal(sectionRetryStateOf(agent), undefined)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('persistent init failures exhaust the 1s/4s/16s backoff and then stop', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-exhaust-'))
  try {
    const fs = createFakeFs()
    failAllReads(fs, 'still broken')
    const agent = createFakeAgent('sess_exhaust', workspace)
    const ctxRef = createPluginHarness(fs, agent)
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionRetryStateOf(agent) !== undefined), true)

      // Drive all three backoff steps by rewinding nextAtMs instead of sleeping.
      for (const expected of [1, 2, 3]) {
        expediteRetry(agent)
        sectionText()
        assert.equal(await waitFor(() => sectionRetryStateOf(agent) === undefined
          || sectionRetryStateOf(agent).attempts >= expected), true)
      }
      assert.equal(await waitFor(() => sectionRetryStateOf(agent) === undefined), true)

      // The journal records each step with its backoff wait.
      const journal = await readFile(LOG_PATH, 'utf8')
      assert.match(journal, new RegExp('index retry failed for sess_exhaust \\(attempt 1, next in 1000ms\\)'))
      assert.match(journal, new RegExp('index retry failed for sess_exhaust \\(attempt 2, next in 4000ms\\)'))
      assert.match(journal, new RegExp('index retry failed for sess_exhaust \\(attempt 3, next in 16000ms\\)'))

      // Past exhaustion, further section reads schedule nothing new.
      sectionText()
      await new Promise((done) => setTimeout(done, 50))
      sectionText()
      assert.equal(sectionRetryStateOf(agent), undefined)
      assert.equal(sectionText().includes('alpha.md'), false)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
