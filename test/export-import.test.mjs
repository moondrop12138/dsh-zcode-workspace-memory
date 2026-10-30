import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, __internals } from '../lib/host.js'

const { EXPORT_FORMAT, EXPORT_MANIFEST_FILE, EXPORT_VERSION } = __internals

// Roadmap D7 acceptance: a snapshot carries the index, every fact file and a
// manifest; an import validates before it writes; a memory root that is already
// a git repository gets committed after a write, a plain directory does not.

const RPC_URL = 'http://localhost/api/dsh-workspace-memory/call'

/** Real-disk filesystem adapter — exports and imports read/write plain files. */
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
      return {
        operation: before === null ? 'create' : 'update',
        version: 'v2',
        before,
        after: content,
      }
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

/**
 * One workspace wired to the real disk, a stub model that always learns the
 * same fact, and the RPC route registered so the endpoints are reached the way
 * the Client half reaches them.
 */
function createHarness(workspace, reply) {
  const fs = createRealFs()
  const agent = createFakeAgent('sess_export_' + Math.random().toString(36).slice(2), workspace)
  const state = { ctx: undefined }
  const services = {
    systemPrompt: { section: (section) => { state.ctx.sections.push(section); return () => {} } },
    connection: {
      fetch: {
        register: (route) => {
          state.ctx.rpcRoutes.push(route)
          return () => {}
        },
      },
    },
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
  }
  state.ctx = createFakeCtx(services)
  apply(state.ctx)
  return { ctx: state.ctx, agent, fs }
}

let rpcSeq = 0

/** Call one RPC endpoint through the registered route and unwrap the result. */
async function callRpc(ctx, endpoint, payload) {
  const route = ctx.rpcRoutes[0]
  assert.notEqual(route, undefined, 'the RPC route must be registered')
  rpcSeq += 1
  const request = new Request(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rpcId: 'd7-' + rpcSeq,
      type: 'client-request',
      method: 'dsh-workspace-memory/call',
      payload: { endpoint, payload },
    }),
  })
  const body = await (await route.fetch(request)).json()
  return body.result
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 10))
  }
}

function factFile(name, description, type) {
  return '---\nname: ' + name + '\ndescription: ' + description
    + '\nmetadata:\n  node_type: memory\n  type: ' + type + '\n---\nbody of ' + name + '\n'
}

/**
 * One index line pointing at one fact. The seeded index always matches the
 * seeded facts: an index that references a missing file would let the startup
 * repair pass rewrite MEMORY.md (and drop a `.prev` backup) underneath the
 * assertions.
 */
function indexLine(name) {
  return '- [' + name + '](' + name + '.md) — seeded\n'
}

/** Seed one memory root with a fact and an index pointing at it. */
async function seedRoot(root, name) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, name + '.md'), factFile(name, 'A seeded fact', 'project'), 'utf8')
  await writeFile(join(root, 'MEMORY.md'), indexLine(name), 'utf8')
}

test('export writes a manifest and copies the index plus every fact', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-export-ws-'))
  const targetDir = await mkdtemp(join(tmpdir(), 'dwm-export-target-'))
  let harness
  try {
    await seedRoot(join(workspace, '.dsh', 'memory'), 'seeded-fact')
    harness = createHarness(workspace, JSON.stringify({ memories: [], forget: [] }))
    await waitFor(() => harness.ctx.sections.length > 0)

    const result = await callRpc(harness.ctx, 'export', { path: workspace, targetDir })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    const { dir, manifestPath, fileCount, layers } = result.value
    assert.equal(dir.startsWith(join(targetDir, 'workspace-memory-export-')), true)
    assert.equal(existsSync(join(dir, 'workspace', 'MEMORY.md')), true)
    assert.equal(existsSync(join(dir, 'workspace', 'seeded-fact.md')), true)
    assert.equal(existsSync(join(dir, 'global')), false)
    // proposals/ and trash/ are bookkeeping, never part of a snapshot.
    assert.equal(existsSync(join(dir, 'workspace', 'proposals')), false)

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.format, EXPORT_FORMAT)
    assert.equal(manifest.version, EXPORT_VERSION)
    assert.equal(typeof manifest.createdAt, 'string')
    assert.deepEqual(layers.map((layer) => layer.layer).sort(), ['workspace'])
    assert.equal(fileCount, 2)
    const workspaceLayer = manifest.layers.find((layer) => layer.layer === 'workspace')
    assert.deepEqual(
      workspaceLayer.files.map((file) => file.name).sort(),
      ['MEMORY.md', 'seeded-fact.md'],
    )
    const index = workspaceLayer.files.find((file) => file.name === 'MEMORY.md')
    assert.equal(index.kind, 'index')
    assert.equal(typeof index.sha256, 'string')
    assert.equal(index.bytes, Buffer.byteLength(indexLine('seeded-fact'), 'utf8'))
    // The copy is byte-identical to the source.
    assert.equal(await readFile(join(dir, 'workspace', 'seeded-fact.md'), 'utf8'), factFile('seeded-fact', 'A seeded fact', 'project'))
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(targetDir, { recursive: true, force: true })
  }
})

test('import rejects a bad manifest without writing anything', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-import-bad-'))
  const snapshot = await mkdtemp(join(tmpdir(), 'dwm-import-bad-src-'))
  let harness
  try {
    const root = join(workspace, '.dsh', 'memory')
    await seedRoot(root, 'kept-fact')
    await writeFile(join(snapshot, EXPORT_MANIFEST_FILE), JSON.stringify({
      format: 'something-else',
      version: EXPORT_VERSION,
      createdAt: '2026-01-01T00:00:00.000Z',
      layers: [{ layer: 'workspace', files: [{ name: 'MEMORY.md', kind: 'index' }] }],
    }), 'utf8')
    harness = createHarness(workspace, JSON.stringify({ memories: [], forget: [] }))
    await waitFor(() => harness.ctx.sections.length > 0)
    const before = (await readdir(root)).sort()

    const result = await callRpc(harness.ctx, 'import', { path: workspace, dir: snapshot })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid-manifest')
    assert.deepEqual((await readdir(root)).sort(), before)
    assert.equal(await readFile(join(root, 'kept-fact.md'), 'utf8'), factFile('kept-fact', 'A seeded fact', 'project'))

    // A truncated checksum fails the same way, still with no writes.
    const goodManifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      createdAt: '2026-01-01T00:00:00.000Z',
      layers: [{
        layer: 'workspace',
        files: [{ name: 'kept-fact.md', kind: 'fact', sha256: 'deadbeef', bytes: 10 }],
      }],
    }
    await writeFile(join(snapshot, EXPORT_MANIFEST_FILE), JSON.stringify(goodManifest), 'utf8')
    await mkdir(join(snapshot, 'workspace'), { recursive: true })
    await writeFile(join(snapshot, 'workspace', 'kept-fact.md'), 'tampered\n', 'utf8')
    const checksum = await callRpc(harness.ctx, 'import', { path: workspace, dir: snapshot })
    assert.equal(checksum.ok, false)
    assert.equal(checksum.error.code, 'invalid-snapshot')
    assert.deepEqual((await readdir(root)).sort(), before)
    assert.equal(await readFile(join(root, 'kept-fact.md'), 'utf8'), factFile('kept-fact', 'A seeded fact', 'project'))
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(snapshot, { recursive: true, force: true })
  }
})

test('import restores missing facts and trashes conflicting ones', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-import-ws-'))
  const targetDir = await mkdtemp(join(tmpdir(), 'dwm-import-target-'))
  let harness
  try {
    const root = join(workspace, '.dsh', 'memory')
    await seedRoot(root, 'restored-fact')
    harness = createHarness(workspace, JSON.stringify({ memories: [], forget: [] }))
    await waitFor(() => harness.ctx.sections.length > 0)
    const exported = await callRpc(harness.ctx, 'export', { path: workspace, targetDir })
    assert.equal(exported.ok, true)
    const snapshotDir = exported.value.dir

    // Local drift: one fact deleted, one fact with different content.
    await rm(join(root, 'restored-fact.md'))
    await writeFile(join(root, 'MEMORY.md'), '- [Drifted](drifted.md) — local only\n', 'utf8')
    await writeFile(join(root, 'drifted.md'), factFile('drifted', 'Local drift', 'project'), 'utf8')

    const result = await callRpc(harness.ctx, 'import', { path: workspace, dir: snapshotDir })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    const workspaceLayer = result.value.layers[0]
    assert.equal(workspaceLayer.root, root)
    assert.deepEqual(workspaceLayer.applied.sort(), ['MEMORY.md', 'restored-fact.md'])
    // The conflicting index was backed up before being replaced.
    assert.equal(existsSync(join(root, 'MEMORY.md.prev')), true)
    assert.equal(await readFile(join(root, 'restored-fact.md'), 'utf8'), factFile('restored-fact', 'A seeded fact', 'project'))
    assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), indexLine('restored-fact'))

    // Re-importing the same snapshot is a no-op: identical files are skipped.
    const again = await callRpc(harness.ctx, 'import', { path: workspace, dir: snapshotDir })
    assert.equal(again.ok, true)
    assert.equal(again.value.applied, 0)
    assert.equal(again.value.skipped > 0, true)
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(targetDir, { recursive: true, force: true })
  }
})

test('git mode commits when .git exists and stays a no-op otherwise', async () => {
  const gitWorkspace = await mkdtemp(join(tmpdir(), 'dwm-git-ws-'))
  const plainWorkspace = await mkdtemp(join(tmpdir(), 'dwm-nogit-ws-'))
  const reply = JSON.stringify({
    memories: [{ name: 'git-fact', title: 'Git fact', type: 'project', description: 'Learned while git was watching', body: 'Recorded.' }],
    forget: [],
  })
  const gitRoot = join(gitWorkspace, '.dsh', 'memory')
  const plainRoot = join(plainWorkspace, '.dsh', 'memory')
  let gitHarness
  let plainHarness
  try {
    await mkdir(gitRoot, { recursive: true })
    execFileSync('git', ['-C', gitRoot, 'init'], { stdio: 'ignore' })
    execFileSync('git', ['-C', gitRoot, 'config', 'user.email', 'memory@example.invalid'], { stdio: 'ignore' })
    execFileSync('git', ['-C', gitRoot, 'config', 'user.name', 'Workspace Memory'], { stdio: 'ignore' })

    gitHarness = createHarness(gitWorkspace, reply)
    await waitFor(() => gitHarness.ctx.sections.length > 0)
    const emit = (name, ...args) => {
      for (const registered of gitHarness.ctx.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', gitHarness.agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', gitHarness.agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember the git fact' }] },
    })
    emit('session/event', gitHarness.agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', gitHarness.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    assert.equal(await waitFor(() => existsSync(join(gitRoot, 'git-fact.md'))), true)
    const logOf = () => {
      try {
        return execFileSync('git', ['-C', gitRoot, 'log', '--oneline'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (_error) {
        return ''
      }
    }
    assert.equal(await waitFor(() => logOf().trim().length > 0, 5000), true, 'git log stayed empty')
    assert.match(logOf(), /workspace-memory/)
    // The commit carries the fact the extraction wrote.
    const tracked = execFileSync('git', ['-C', gitRoot, 'ls-files'], { encoding: 'utf8' })
    assert.match(tracked, /git-fact\.md/)
    gitHarness.ctx.disposeAll()
    gitHarness = undefined

    // Same turn in a plain directory: nothing is committed and no repository
    // is created — the plugin never runs `git init`.
    plainHarness = createHarness(plainWorkspace, reply)
    await waitFor(() => plainHarness.ctx.sections.length > 0)
    const emitPlain = (name, ...args) => {
      for (const registered of plainHarness.ctx.handlers.get(name) ?? []) registered(...args)
    }
    emitPlain('session/event', plainHarness.agent.session, { type: 'turn/start', data: { turn: 1 } })
    emitPlain('session/event', plainHarness.agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember the git fact' }] },
    })
    emitPlain('session/event', plainHarness.agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emitPlain('session/event', plainHarness.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(await waitFor(() => existsSync(join(plainRoot, 'git-fact.md'))), true)
    assert.equal(existsSync(join(plainRoot, '.git')), false)
    // Let the detached children settle before the temp dirs disappear.
    await new Promise((done) => setTimeout(done, 150))
  } finally {
    if (gitHarness !== undefined) gitHarness.ctx.disposeAll()
    if (plainHarness !== undefined) plainHarness.ctx.disposeAll()
    await rm(gitWorkspace, { recursive: true, force: true })
    await rm(plainWorkspace, { recursive: true, force: true })
  }
})
