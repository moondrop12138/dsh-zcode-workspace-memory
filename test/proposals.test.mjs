import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, __internals } from '../lib/host.js'
import { proposalFileName, renderProposalFile } from '../lib/memory-core.js'

const { PROPOSAL_FACT_THRESHOLD } = __internals

// Roadmap D8 acceptance: below the fact threshold an extraction writes no
// proposal; above it the next extraction writes one review file under
// `proposals/`; proposals are never facts and never part of an export; and the
// accept endpoint applies the drops through the guarded write path.

const RPC_URL = 'http://localhost/api/dsh-workspace-memory/call'

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

function createHarness(workspace, globalDir, reply) {
  const fs = createRealFs()
  const agent = createFakeAgent('sess_prop_' + Math.random().toString(36).slice(2), workspace)
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
  apply(state.ctx, { globalMemoryRoot: globalDir })
  /** Run one completed turn through the fake model. */
  const turn = (text) => {
    const emit = (name, ...args) => {
      for (const registered of state.ctx.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  return { ctx: state.ctx, agent, fs, turn }
}

let rpcSeq = 0

async function callRpc(ctx, endpoint, payload) {
  const route = ctx.rpcRoutes[0]
  assert.notEqual(route, undefined, 'the RPC route must be registered')
  rpcSeq += 1
  const request = new Request(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rpcId: 'd8-' + rpcSeq,
      type: 'client-request',
      method: 'dsh-workspace-memory/call',
      payload: { endpoint, payload },
    }),
  })
  const body = await (await route.fetch(request)).json()
  return body.result
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 10))
  }
}

function factFile(name, description, type, extra) {
  return '---\nname: ' + name + '\ndescription: ' + description
    + '\nmetadata:\n  node_type: memory\n  type: ' + type + (extra ?? '') + '\n---\nbody of ' + name + '\n'
}

/**
 * Seed one root with `names`, all pointed at from MEMORY.md so the startup
 * repair pass has nothing to add. Every fact is old and untouched, which is
 * what the long-unaccessed section looks for.
 */
async function seedRoot(root, names, description) {
  await mkdir(root, { recursive: true })
  const pointers = []
  for (const name of names) {
    const stale = '\n  lastAccessedAt: 2020-01-01T00:00:00.000Z'
    // A distinct description per fact: identical descriptions would (correctly)
    // read as contradiction candidates and drown the near-duplicate section.
    await writeFile(join(root, name + '.md'), factFile(name, description ?? ('Notes about ' + name.replace(/-/gu, ' ')), 'project', stale), 'utf8')
    pointers.push('- [' + name + '](' + name + '.md) — seeded')
  }
  await writeFile(join(root, 'MEMORY.md'), pointers.join('\n') + '\n', 'utf8')
}

const DISTINCT_NAMES = [
  'amber-quill', 'basalt-fjord', 'cinder-hollow', 'dusk-lattice', 'ember-marble',
  'glacier-puzzle', 'harbor-tundra', 'ivory-gambit', 'jasper-riddle', 'kelp-velvet',
  'lumber-wombat', 'mossy-zodiac', 'nectar-obsidian', 'onyx-pebble', 'plumage-quartz',
  'ribbon-saffron', 'silt-topaz', 'tumble-umber', 'vapor-willow', 'xenon-yarrow',
  'brisk-cobalt', 'vortex-kettle', 'nimble-jigsaw', 'yonder-plume', 'rustic-grotto',
  'gilded-thicket', 'placid-harbinger', 'somber-radish', 'lithe-mandrake', 'dapper-nugget',
  'feral-pulsar', 'gauzy-thimble', 'hardy-squall', 'jolly-inkwell', 'keen-thistle',
  'lucid-parsnip', 'mellow-flint', 'nifty-spindle', 'opal-tumbler', 'pert-widgeon',
  'quaint-bramble', 'rosy-cauldron', 'stark-prism', 'tidal-whetstone', 'urbane-cobble',
  'vast-lantern', 'wiry-mantle', 'xeric-blossom', 'youthful-cadence', 'zany-tumbrel',
  'ablaze-tundra', 'bountiful-reed', 'curious-spire', 'dutiful-larch', 'elegant-cairn',
  'frolic-meadow', 'graceful-thorn', 'hushed-canyon', 'idle-marlin', 'jaded-quiver',
]

test('no proposal file is written below the fact threshold', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-prop-low-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let harness
  try {
    const root = join(workspace, '.dsh', 'memory')
    await seedRoot(root, DISTINCT_NAMES.slice(0, 3))
    harness = createHarness(workspace, globalDir, JSON.stringify({
      memories: [{ name: 'new-fact', title: 'New fact', type: 'project', description: 'A fourth fact', body: 'Body.' }],
      forget: [],
    }))
    await waitFor(() => harness.ctx.sections.length > 0)
    harness.turn('Remember the fourth fact')
    assert.equal(await waitFor(() => existsSync(join(root, 'new-fact.md'))), true)
    // Give a (wrongly) scheduled proposal write a chance to land, then assert.
    await new Promise((done) => setTimeout(done, 250))
    assert.equal(existsSync(join(root, 'proposals')), false)

    const listed = await callRpc(harness.ctx, 'proposals', { path: workspace })
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    assert.deepEqual(listed.value.proposals, [])
    assert.equal(listed.value.threshold, PROPOSAL_FACT_THRESHOLD)
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('the next extraction above the threshold writes one proposal with every section', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-prop-high-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let harness
  try {
    const root = join(workspace, '.dsh', 'memory')
    // Exactly the threshold worth of facts, including one deliberate
    // near-duplicate pair, then one learned fact pushes it over.
    const seeded = [...DISTINCT_NAMES, 'deploy-guard', 'deploy-guards']
    assert.equal(seeded.length, PROPOSAL_FACT_THRESHOLD + 2)
    await seedRoot(root, seeded)
    harness = createHarness(workspace, globalDir, JSON.stringify({
      memories: [{ name: 'fresh-fact', title: 'Fresh fact', type: 'project', description: 'Pushes the layer over the threshold', body: 'Body.' }],
      forget: [],
    }))
    await waitFor(() => harness.ctx.sections.length > 0)
    harness.turn('Remember the fresh fact')

    const proposalsDir = join(root, 'proposals')
    // Poll for the file itself: the directory is created one step before the
    // write lands, so waiting only for `proposals/` can read an empty dir.
    const proposalNames = async () => {
      try {
        return (await readdir(proposalsDir)).filter((name) => name.startsWith('consolidation-') && name.endsWith('.md'))
      } catch (_error) {
        return []
      }
    }
    assert.equal(await waitFor(async () => (await proposalNames()).length > 0), true, 'no proposal file was written')
    const proposalFile = (await proposalNames())[0]
    const text = await readFile(join(proposalsDir, proposalFile), 'utf8')
    assert.match(text, /^# Consolidation proposals/u)
    assert.match(text, /Proposals only — nothing in this file has been applied/u)
    assert.match(text, /## Near-duplicate names/u)
    assert.match(text, /## Contradiction candidates/u)
    assert.match(text, /## Long-unaccessed facts/u)
    // The deliberate pair is reported, keep-first.
    assert.match(text, /keep `deploy-guard`, drop `deploy-guards`/u)
    // Every seeded fact carries an old lastAccessedAt, so the stale section
    // lists them instead of falling back to "None.".
    assert.match(text, /last touched 2020-01-01T00:00:00\.000Z/u)
    assert.match(text, /Facts: \d+ \(threshold 60\)/u)

    const listed = await callRpc(harness.ctx, 'proposals', { path: workspace })
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    assert.equal(listed.value.proposals.length, 1)
    const entry = listed.value.proposals[0]
    assert.equal(entry.layer, 'workspace')
    assert.equal(entry.name, proposalFile)
    assert.equal(entry.acceptedAt, '')
    assert.equal(entry.factCount >= PROPOSAL_FACT_THRESHOLD + 1, true)
    assert.equal(entry.counts.stale >= PROPOSAL_FACT_THRESHOLD + 2, true)
    assert.equal(entry.items.length >= 1, true)

    // `proposals/` is never a fact: it does not appear in an export snapshot.
    const targetDir = await mkdtemp(join(tmpdir(), 'dwm-prop-export-'))
    try {
      const exported = await callRpc(harness.ctx, 'export', { path: workspace, targetDir })
      assert.equal(exported.ok, true, JSON.stringify(exported.error))
      const workspaceLayer = exported.value.layers.find((layer) => layer.layer === 'workspace')
      assert.notEqual(workspaceLayer, undefined)
      assert.equal(workspaceLayer.files, seeded.length + 2) // facts + MEMORY.md + the learned fact
      assert.equal(existsSync(join(exported.value.dir, 'workspace', 'proposals')), false)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('accepting a proposal drops the duplicates through the guarded write path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-prop-accept-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let harness
  try {
    const root = join(workspace, '.dsh', 'memory')
    const keep = 'project-convention'
    const drop = 'project-conventions'
    await seedRoot(root, [keep, drop, 'unrelated-fact'])
    // A hand-written proposal: the generator is covered above, this test must
    // pin the accept path exactly.
    const proposalsDir = join(root, 'proposals')
    await mkdir(proposalsDir, { recursive: true })
    const name = proposalFileName('2026-02-03T04:05:06.000Z')
    await writeFile(join(proposalsDir, name), renderProposalFile({
      createdAt: '2026-02-03T04:05:06.000Z',
      layer: 'workspace',
      root,
      factCount: 3,
      threshold: PROPOSAL_FACT_THRESHOLD,
      nearDuplicates: [{ kind: 'near-duplicate', keep, drop: [drop] }],
      contradictions: [],
      stale: [],
    }), 'utf8')

    harness = createHarness(workspace, globalDir, JSON.stringify({ memories: [], forget: [] }))
    await waitFor(() => harness.ctx.sections.length > 0)

    const result = await callRpc(harness.ctx, 'proposals-accept', { path: workspace, name })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.deepEqual(result.value.dropped, [drop])
    assert.equal(existsSync(join(root, drop + '.md')), false)
    assert.equal(existsSync(join(root, keep + '.md')), true)
    // The file was trashed, not deleted.
    const trash = join(root, 'trash')
    assert.equal(existsSync(trash), true)
    assert.equal((await readdir(trash)).length > 0, true)
    // The index no longer points at the dropped fact.
    const index = await readFile(join(root, 'MEMORY.md'), 'utf8')
    assert.equal(index.includes(drop + '.md'), false)
    assert.equal(index.includes(keep + '.md'), true)
    // The proposal is marked accepted instead of being applied twice.
    const marked = await readFile(join(proposalsDir, name), 'utf8')
    assert.match(marked, /"acceptedAt": "20\d\d-\d\d-\d\dT/u)
    const again = await callRpc(harness.ctx, 'proposals-accept', { path: workspace, name })
    assert.equal(again.ok, false)
    assert.equal(again.error.code, 'already-accepted')
  } finally {
    if (harness !== undefined) harness.ctx.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('the proposals directory never counts as facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dwm-prop-count-'))
  try {
    // Two real facts plus a proposal artifact, all in the same root.
    await seedRoot(root, ['alpha-fact', 'beta-fact'])
    const proposalsDir = join(root, 'proposals')
    await mkdir(proposalsDir, { recursive: true })
    await writeFile(join(proposalsDir, proposalFileName('2026-02-03T04:05:06.000Z')), renderProposalFile({
      createdAt: '2026-02-03T04:05:06.000Z',
      layer: 'workspace',
      root,
      factCount: 2,
      threshold: PROPOSAL_FACT_THRESHOLD,
      nearDuplicates: [],
      contradictions: [],
      stale: [],
    }), 'utf8')
    // A stray fact-shaped file inside the bookkeeping dir must stay invisible too.
    await writeFile(join(proposalsDir, 'stray-thought.md'), factFile('stray-thought', 'Not a fact', 'project'), 'utf8')

    const fs = createRealFs()
    const facts = await __internals.readFactStats(fs, root)
    assert.deepEqual(facts.map((fact) => fact.name).sort(), ['alpha-fact', 'beta-fact'])
    // The count that gates the threshold ignores `proposals/` as well: two, not five.
    assert.equal(await __internals.countFactsIn({}, fs, root), 2)
    // And the guard is spelled out where the scans and the export check it.
    assert.equal(__internals.isNonFactEntry('proposals'), true)
    assert.equal(__internals.isNonFactEntry('trash'), true)
    assert.equal(__internals.isNonFactEntry('alpha-fact.md'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
