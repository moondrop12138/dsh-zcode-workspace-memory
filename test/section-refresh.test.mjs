/**
 * Roadmap C6 — the section cache refreshes after an extraction writes memories.
 *
 * Before C6 the section was filled once per Agent at init; memories the same
 * session recorded were invisible to it until restart. After C6 a successful
 * extraction re-reads and re-renders the section in the background, so the
 * next turn of the SAME session is injected with the fresh index. The failure
 * path must coexist with the B3 retry state machine: a failed refresh keeps
 * the last good cached text and never touches the backoff.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, sectionRetryStateOf, __internals } from '../lib/host.js'

const { refreshAgentSection, journalPath, setJournalPath } = __internals

// This file asserts on the Host journal; give it a journal of its own so the
// rotation and extraction test files cannot rename its lines away (each test
// file runs in its own process).
setJournalPath(join(tmpdir(), 'wm-section-refresh-' + process.pid + '.log'))

const LOG_PATH = journalPath()

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
function createPluginHarness(fs, agent, llmReply, config = {}) {
  const calls = { llm: [] }
  const services = {
    systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: agent.session.header.cwd }) },
    ...(llmReply === undefined ? {} : {
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: llmReply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }),
  }
  const ctxRef = createFakeCtx(services)
  apply(ctxRef, config)
  return { ctxRef, calls }
}

/** Drive one completed turn with real user prose through the fake context. */
function emitTurn(ctxRef, agent, turn, text) {
  const emit = (name, ...args) => {
    for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
  }
  emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
  emit('session/event', agent.session, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
  })
  emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

const PREFER_TABS_REPLY = '{"memories":[{"name":"prefers-tabs","title":"Prefers tabs",'
  + '"type":"user","description":"Prefers tabs over spaces","body":"Uses tabs."}],"forget":[]}'

const fact = (name, description, type) => '---\nname: ' + name + '\ndescription: ' + description
  + '\nmetadata:\n  node_type: memory\n  type: ' + type + '\n---\nbody\n'

test('an extraction write refreshes the cached section before the next turn of the same session', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-refresh-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const globalMemoryDir = globalDir
    // No MEMORY.md at init: the section starts as rules only, with no pointer.
    const agent = createFakeAgent('sess_refresh', workspace)
    const { ctxRef, calls } = createPluginHarness(fs, agent, PREFER_TABS_REPLY, { globalMemoryRoot: globalDir })
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionText().includes('# Memory')), true)
      assert.equal(sectionText().includes('prefers-tabs.md'), false)

      // Turn 1 records a memory through the extraction pipeline; from then on
      // the SAME session's section must already carry the new pointer — no
      // restart, no new session.
      emitTurn(ctxRef, agent, 1, 'please remember that I prefer tabs')
      assert.equal(await waitFor(() => sectionText().includes('prefers-tabs.md')), true)

      // The write really happened and the refresh made no model call. v2: the
      // type-user memory lands in the global layer (D1), so both files are
      // looked up under the test's global root.
      assert.match(fs.files.get(join(globalMemoryDir, 'MEMORY.md')), /- \[Prefers tabs\]\(prefers-tabs\.md\) — Prefers tabs over spaces/)
      assert.match(fs.files.get(join(globalMemoryDir, 'prefers-tabs.md')), /originSessionId: sess_refresh/)
      assert.equal(calls.llm.length, 1)

      // The second turn of the same session reads the fresh text.
      emitTurn(ctxRef, agent, 2, 'what do you remember about my indentation?')
      assert.equal(sectionText().includes('prefers-tabs.md'), true)
      assert.equal(sectionRetryStateOf(agent), undefined)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('a failed section refresh keeps the last good text and the retry backoff untouched', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-refresh-fail-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const globalMemoryDir = globalDir
    // Seed a healthy index in the WORKSPACE layer: init caches a section that
    // carries the pointer. (v2 keeps type-project facts in the workspace
    // layer, so this seed also pins the workspace block of the section.)
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Alpha](alpha.md) \u2014 first fact\n')
    fs.files.set(join(memoryDir, 'alpha.md'), fact('alpha', 'first fact', 'project'))

    // After the extraction's index write lands, break every read so the
    // refresh's re-read fails while the extraction itself (which reads first)
    // succeeds. The last good cached section must survive untouched. v2: the
    // type-user prefers-tabs memory lands in the GLOBAL layer, so the hook
    // watches that layer's MEMORY.md.
    const originalWriteText = fs.writeText
    fs.writeText = async (target, content) => {
      const result = await originalWriteText(target, content)
      if (target.displayPath === join(globalMemoryDir, 'MEMORY.md') && content.includes('prefers-tabs')) {
        fs.stat = async () => { throw new Error('post-write failure') }
        fs.readText = async () => { throw new Error('post-write failure') }
        fs.listDir = async () => { throw new Error('post-write failure') }
      }
      return result
    }

    const agent = createFakeAgent('sess_refresh_fail', workspace)
    const { ctxRef, calls } = createPluginHarness(fs, agent, PREFER_TABS_REPLY, { globalMemoryRoot: globalDir })
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionText().includes('alpha.md')), true)
      assert.equal(sectionRetryStateOf(agent), undefined)

      emitTurn(ctxRef, agent, 1, 'please remember that I prefer tabs')

      // The extraction itself still landed on disk.
      assert.equal(await waitFor(() => fs.writes.some((write) => write.path.endsWith('prefers-tabs.md'))), true)
      assert.equal(calls.llm.length, 1)
      // Let the fire-and-forget refresh settle before the negative assertions.
      await new Promise((done) => setTimeout(done, 100))

      // Failure path: the cache keeps the last good text (alpha, no new
      // pointer), and the B3 backoff state was never created or advanced.
      assert.equal(sectionText().includes('alpha.md'), true)
      assert.equal(sectionText().includes('prefers-tabs.md'), false)
      assert.equal(sectionRetryStateOf(agent), undefined)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('a successful refresh after a failed init read clears the obsolete retry state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-refresh-retry-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    // The index exists but the init read fails: the retry machine owns the
    // failure. The section provider must not be touched while the retry state
    // sits at nextAtMs = 0 — that read would trigger the B3 retry instead.
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Alpha](alpha.md) \u2014 first fact\n')
    fs.files.set(join(memoryDir, 'alpha.md'), fact('alpha', 'first fact', 'project'))
    const originalReadText = fs.readText
    fs.readText = async () => { throw new Error('init failure') }
    const originalStat = fs.stat
    fs.stat = async () => { throw new Error('init failure') }

    const agent = createFakeAgent('sess_refresh_retry', workspace)
    const { ctxRef, calls } = createPluginHarness(fs, agent, PREFER_TABS_REPLY, { globalMemoryRoot: globalDir })
    try {
      assert.equal(await waitFor(() => sectionRetryStateOf(agent) !== undefined), true)

      // Reads work again; the turn extracts and the refresh re-reads. The
      // refresh success must clear the now-obsolete retry state and fill the
      // cache with the full index (existing pointer plus the new one).
      fs.stat = originalStat
      fs.readText = originalReadText
      emitTurn(ctxRef, agent, 1, 'please remember that I prefer tabs')

      // Only the C6 refresh clears the state here: no section read ever ran,
      // so the B3 retry machine was never scheduled.
      assert.equal(await waitFor(() => sectionRetryStateOf(agent) === undefined), true)
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(sectionText().includes('alpha.md'), true)
      assert.equal(sectionText().includes('prefers-tabs.md'), true)
      assert.equal(calls.llm.length, 1)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('refreshAgentSection resolves silently on a disposed plugin', async () => {
  const fs = createFakeFs()
  const plugin = { disposed: true, ctx: createFakeCtx({ fs }), config: {}, sectionCache: new WeakMap() }
  const record = { agent: {}, sessionId: 'sess_disposed', root: 'C:\\w', memoryRoot: 'C:\\w\\.dsh\\memory', rootKey: 'c:\\w\\.dsh\\memory' }
  await assert.doesNotReject(() => refreshAgentSection(plugin, record))
  assert.equal(plugin.sectionCache.has(record.agent), false)
})

test('the refresh success line lands in the journal under debugLog', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-refresh-log-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const agent = createFakeAgent('sess_refresh_log', workspace)
    // debugLog on so the debug-gated "section refreshed" line is observable.
    const servicesLlmReply = PREFER_TABS_REPLY
    const calls = { llm: [] }
    const services = {
      systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: servicesLlmReply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const ctxRef = createFakeCtx(services)
    apply(ctxRef, { debugLog: true, globalMemoryRoot: globalDir })
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionText().includes('# Memory')), true)
      emitTurn(ctxRef, agent, 1, 'please remember that I prefer tabs')
      assert.equal(await waitFor(() => sectionText().includes('prefers-tabs.md')), true)
      // The journal is a plain sync append; read it back through the same
      // seam and assert the debug-gated refresh line with its index line count.
      // v2: only the global layer holds a pointer here, so the count stays 1.
      const journal = await fs.readText({ displayPath: LOG_PATH }) ?? await readFile(LOG_PATH, 'utf8')
      assert.match(journal, /section refreshed for sess_refresh_log \(index lines: 1\)/)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})
