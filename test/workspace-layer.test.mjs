import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/host.js'

// Memory is per-workspace: a session only ever reads and writes
// `<workspaceRoot>/.dsh/memory`, and configuring nothing creates no directory
// outside the workspace (the user's home in particular).

/**
 * A real-disk fs adapter: forget-to-trash moves bytes with node fs, so both
 * halves of that dance must see the same file system.
 */
function createRealFs() {
  const resolve = async (path) => ({ targetKey: path, displayPath: path })
  return {
    resolve,
    stat: async (target) => {
      try {
        const info = await stat(target.displayPath)
        return { version: 'v1', type: info.isFile() ? 'file' : 'directory', size: info.size }
      } catch (_error) {
        return undefined
      }
    },
    readText: async (target) => {
      try {
        return await readFile(target.displayPath, 'utf8')
      } catch (_error) {
        return undefined
      }
    },
    listDir: async (target) => {
      const names = await readdir(target.displayPath, { withFileTypes: true })
      return names.map((entry) => ({
        name: entry.name,
        type: entry.isFile() ? 'file' : 'directory',
        target: { targetKey: join(target.displayPath, entry.name), displayPath: join(target.displayPath, entry.name) },
      }))
    },
    writeText: async (target, content) => {
      const before = await readFile(target.displayPath, 'utf8').catch(() => null)
      await writeFile(target.displayPath, content, 'utf8')
      return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content }
    },
    contains: () => true,
  }
}

function createFakeCtx(services) {
  const handlers = new Map()
  const disposers = []
  return {
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
}

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

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 10))
  }
}

/**
 * Poll an async reader until its value satisfies `predicate` and return that
 * value. Index rewrites land a tick after the fact files on a loaded runner, so
 * a single `readFile` after a fact appears is a race.
 */
async function waitForValue(read, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!predicate(value)) {
    if (Date.now() > deadline) return value
    await new Promise((done) => setTimeout(done, 10))
    value = await read()
  }
  return value
}

function factFrontmatter(name, description, type) {
  return '---\nname: ' + name + '\ndescription: ' + description
    + '\nmetadata:\n  node_type: memory\n  type: ' + type + '\n---\nbody\n'
}

const PROJ_FACT_REPLY = JSON.stringify({
  memories: [
    { name: 'likes-tabs', title: 'Likes tabs', type: 'user', description: 'Prefers tabs', body: 'Prefers tabs over spaces.' },
    { name: 'proj-convention', title: 'Proj convention', type: 'project', description: 'Project rule', body: 'Follow the project rule.' },
  ],
  forget: [],
})

const FORGET_REPLY = JSON.stringify({ memories: [], forget: ['shared-fact'] })

/** Wire one workspace against the real disk; every config value is default. */
function createHarness(workspace, reply, config = {}) {
  const fs = createRealFs()
  const agent = createFakeAgent('sess_layer_' + Math.random().toString(36).slice(2), workspace)
  const ctx = createFakeCtx({
    systemPrompt: { section: (section) => { ctx.sections.push(section); return () => {} } },
    connection: { fetch: { register: (route) => { ctx.rpcRoutes.push(route); return () => {} } } },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    workspaceRegistry: { list: () => [{ id: 'w1', path: workspace, title: 'demo' }] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  })
  apply(ctx, config)
  const emit = (name, ...args) => {
    for (const registered of ctx.handlers.get(name) ?? []) registered(...args)
  }
  return { ctx, agent, fs, emit }
}

/** One full turn: start, a message, an answer, end. */
function playTurn(harness, text) {
  harness.emit('session/event', harness.agent.session, { type: 'turn/start', data: { turn: 1 } })
  harness.emit('session/event', harness.agent.session, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  harness.emit('session/event', harness.agent.session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
  })
  harness.emit('session/event', harness.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

test('a fact learned in one workspace is never injected into another', async () => {
  const workspaceA = await mkdtemp(join(tmpdir(), 'dwm-layer-a-'))
  const workspaceB = await mkdtemp(join(tmpdir(), 'dwm-layer-b-'))
  let harnessA
  let harnessB
  try {
    harnessA = createHarness(workspaceA, PROJ_FACT_REPLY)
    await waitFor(() => harnessA.ctx.sections.length > 0)
    playTurn(harnessA, 'Remember how I like to work')

    // Both facts — the user preference and the project rule — land in the one
    // workspace memory directory.
    assert.equal(await waitFor(() => existsSync(join(workspaceA, '.dsh', 'memory', 'likes-tabs.md'))), true)
    assert.equal(await waitFor(() => existsSync(join(workspaceA, '.dsh', 'memory', 'proj-convention.md'))), true)
    // The index rewrite trails the second fact file by a tick on a loaded CI
    // runner, so poll the index instead of reading it once.
    const indexPathA = join(workspaceA, '.dsh', 'memory', 'MEMORY.md')
    const indexA = await waitForValue(
      () => readFile(indexPathA, 'utf8').catch(() => ''),
      (text) => /likes-tabs/.test(text) && /proj-convention/.test(text),
    )
    assert.match(indexA, /likes-tabs/)
    assert.match(indexA, /proj-convention/)

    // A different workspace shares nothing: its memory directory is absent
    // until it learns something itself.
    harnessB = createHarness(workspaceB, JSON.stringify({ memories: [], forget: [] }))
    const first = await waitFor(() => harnessB.ctx.sections.length > 0)
    assert.equal(first, true)
    const sectionB = harnessB.ctx.sections[0].text({ agent: harnessB.agent })
    assert.equal(sectionB.includes('likes-tabs'), false)
    assert.equal(sectionB.includes('proj-convention'), false)
    assert.equal(sectionB.includes(workspaceA), false)
    assert.equal(existsSync(join(workspaceB, '.dsh', 'memory')), false)
  } finally {
    if (harnessA !== undefined) harnessA.ctx.disposeAll()
    if (harnessB !== undefined) harnessB.ctx.disposeAll()
    await rm(workspaceA, { recursive: true, force: true })
    await rm(workspaceB, { recursive: true, force: true })
  }
})

test('a session never creates a global memory directory under the home folder', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-layer-home-'))
  const fakeHome = await mkdtemp(join(tmpdir(), 'dwm-layer-fakehome-'))
  const previousUserProfile = process.env.USERPROFILE
  const previousHome = process.env.HOME
  let harness
  try {
    // Redirect home resolution at the source: if any code path still reached
    // for `~/.dsh/memory`, the directory would appear under `fakeHome`.
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome
    harness = createHarness(workspace, PROJ_FACT_REPLY)
    await waitFor(() => harness.ctx.sections.length > 0)
    playTurn(harness, 'Remember how I like to work')
    assert.equal(await waitFor(() => existsSync(join(workspace, '.dsh', 'memory', 'likes-tabs.md'))), true)
    assert.equal(existsSync(join(fakeHome, '.dsh')), false)
    assert.deepEqual(await readdir(fakeHome), [])
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(workspace, { recursive: true, force: true })
    await rm(fakeHome, { recursive: true, force: true })
  }
})

test('forget moves the fact to the workspace trash and leaves nothing behind', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-layer-forget-'))
  const memoryDir = join(workspace, '.dsh', 'memory')
  let harness
  try {
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'shared-fact.md'), factFrontmatter('shared-fact', 'Shared fact', 'project'), 'utf8')
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [Shared fact](shared-fact.md) — shared\n', 'utf8')
    harness = createHarness(workspace, FORGET_REPLY)
    await waitFor(() => harness.ctx.sections.length > 0)
    playTurn(harness, 'Forget the shared fact')

    assert.equal(await waitFor(() => existsSync(join(memoryDir, 'shared-fact.md')) === false), true)
    const index = await waitForValue(
      () => readFile(join(memoryDir, 'MEMORY.md'), 'utf8').catch(() => ''),
      (text) => !text.includes('shared-fact'),
    )
    assert.equal(index.includes('shared-fact'), false)
    // Trash, never a delete: the bytes survive under the same workspace root.
    const trashEntries = await readdir(join(memoryDir, 'trash'), { recursive: true })
    assert.equal(trashEntries.some((name) => String(name).endsWith('shared-fact.md')), true)
    assert.equal(existsSync(join(homedir(), '.dsh', 'memory', 'shared-fact.md')), false)
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('the injected section carries no layer label, only the workspace facts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-layer-render-'))
  const memoryDir = join(workspace, '.dsh', 'memory')
  let harness
  try {
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'solo-fact.md'), factFrontmatter('solo-fact', 'Solo fact', 'project'), 'utf8')
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [Solo fact](solo-fact.md) — only fact\n', 'utf8')
    harness = createHarness(workspace, JSON.stringify({ memories: [], forget: [] }))
    const textOf = () => (harness.ctx.sections[0] ? harness.ctx.sections[0].text({ agent: harness.agent }) : '')
    assert.equal(await waitFor(() => textOf().includes('solo-fact')), true)
    const text = textOf()
    assert.match(text, /solo-fact/)
    assert.equal(/global/i.test(text), false)
    assert.equal(text.includes('[workspace]'), false)
    // The header names the one workspace root and nothing under the home folder.
    assert.equal(text.includes(memoryDir), true)
    assert.equal(text.includes(join(homedir(), '.dsh')), false)
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
  }
})
