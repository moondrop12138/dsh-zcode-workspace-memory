/**
 * Roadmap D2 — frontmatter timestamps and usage tracking.
 *
 *   1. Unit tests over the pure seams: renderFactFile/parseFactFrontmatter
 *      timestamp maintenance (legacy files without timestamps parse fine),
 *      planExtractionWrites preserving createdAt and refreshing updatedAt, the
 *      lazy lastAccessedAt rewrite (touchLastAccessed), and read-hit detection
 *      (noteAccessHits).
 *   2. One integration test that drives the real `apply()`: a read tool result
 *      naming a fact file must land in `metadata.lastAccessedAt` on disk after
 *      the batched flush, and the catalog must surface the three epoch-ms
 *      timestamps.
 *
 * The fake filesystem is the same in-memory map shape extraction.test.mjs uses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __internals, apply } from '../lib/host.js'
import { parseFactFrontmatter, renderFactFile } from '../lib/memory-core.js'

const {
  planExtractionWrites,
  noteAccessHits,
  touchLastAccessed,
  pendingAccessHitsOf,
  resetPendingAccessHits,
  accessFlushDelay,
  normalizePathKey,
} = __internals

const WS = 'C:\\work\\demo'
const CREATED = '2026-10-20T08:00:00.000Z'
const UPDATED = '2026-10-24T09:30:00.000Z'

/* ------------------------------------------------------- renderFactFile */

test('renderFactFile writes ISO createdAt/updatedAt into metadata', () => {
  const text = renderFactFile({
    name: 'prefers-tabs',
    type: 'user',
    description: 'Prefers tabs over spaces',
    body: 'Uses tabs in every editor.',
  })
  assert.ok(text.length > 0)
  const front = parseFactFrontmatter(text)
  assert.ok(front)
  assert.match(front.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  assert.match(front.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  // Rendered lines stay inside the metadata block, before the closing fence.
  assert.match(text, /  createdAt: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n/)
  assert.match(text, /  updatedAt: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n/)
})

test('renderFactFile keeps caller-provided timestamps verbatim', () => {
  const text = renderFactFile({
    name: 'prefers-tabs',
    type: 'user',
    description: 'Prefers tabs over spaces',
    body: 'Uses tabs in every editor.',
    createdAt: CREATED,
    updatedAt: UPDATED,
  })
  const front = parseFactFrontmatter(text)
  assert.equal(front.createdAt, CREATED)
  assert.equal(front.updatedAt, UPDATED)
})

test('parseFactFrontmatter tolerates legacy files without timestamps', () => {
  const legacy = [
    '---',
    'name: prefers-tabs',
    'description: Prefers tabs over spaces',
    'metadata:',
    '  node_type: memory',
    '  type: user',
    '  originSessionId: sess_legacy',
    '---',
    '',
    'Uses tabs in every editor.',
    '',
  ].join('\n')
  const front = parseFactFrontmatter(legacy)
  assert.ok(front)
  assert.equal(front.name, 'prefers-tabs')
  assert.equal(front.type, 'user')
  assert.equal(front.originSessionId, 'sess_legacy')
  assert.equal(front.createdAt, undefined)
  assert.equal(front.updatedAt, undefined)
  assert.equal(front.lastAccessedAt, undefined)
})

test('parseFactFrontmatter reads back host-written timestamps', () => {
  const modern = [
    '---',
    'name: prefers-tabs',
    'description: Prefers tabs over spaces',
    'metadata:',
    '  node_type: memory',
    '  type: user',
    `  createdAt: ${CREATED}`,
    `  updatedAt: ${UPDATED}`,
    '  lastAccessedAt: 2026-10-24T10:00:00.000Z',
    '---',
    '',
    'Uses tabs in every editor.',
    '',
  ].join('\n')
  const front = parseFactFrontmatter(modern)
  assert.equal(front.createdAt, CREATED)
  assert.equal(front.updatedAt, UPDATED)
  assert.equal(front.lastAccessedAt, '2026-10-24T10:00:00.000Z')
})

/* -------------------------------------------------- planExtractionWrites */

function planInput(memory, existing, sessionId = 'sess_new') {
  return {
    parsed: { memories: [memory], forget: [] },
    files: existing === undefined ? {} : { 'prefers-tabs.md': existing },
    indexText: '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n',
    sessionId,
  }
}

const MEMORY = {
  name: 'prefers-tabs',
  title: 'Prefers tabs',
  type: 'user',
  description: 'Prefers tabs over spaces',
  body: 'Uses tabs in every editor.',
}

test('planExtractionWrites stamps a fresh fact with createdAt and updatedAt', () => {
  const plan = planExtractionWrites(planInput(MEMORY, undefined))
  assert.equal(plan.writes.length, 1)
  const front = parseFactFrontmatter(plan.writes[0].content)
  assert.match(front.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(front.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  // A fresh fact has never been accessed.
  assert.equal(front.lastAccessedAt, undefined)
})

test('planExtractionWrites preserves createdAt and refreshes updatedAt on update', () => {
  const existing = [
    '---',
    'name: prefers-tabs',
    'description: Prefers tabs over spaces',
    'metadata:',
    '  node_type: memory',
    '  type: user',
    '  originSessionId: sess_old',
    `  createdAt: ${CREATED}`,
    `  updatedAt: 2026-10-21T00:00:00.000Z`,
    '---',
    '',
    'Uses tabs in every editor.',
    '',
  ].join('\n')
  const plan = planExtractionWrites(planInput(MEMORY, existing))
  assert.equal(plan.writes.length, 1)
  const front = parseFactFrontmatter(plan.writes[0].content)
  // Created once, never moved; updated every write.
  assert.equal(front.createdAt, CREATED)
  assert.match(front.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.notEqual(front.updatedAt, '2026-10-21T00:00:00.000Z')
  // The write-time origin preserve still works alongside D2.
  assert.equal(front.originSessionId, 'sess_old')
})

/* ----------------------------------------------------- touchLastAccessed */

test('touchLastAccessed rewrites only the lastAccessedAt line', () => {
  const before = [
    '---',
    'name: prefers-tabs',
    'description: Prefers tabs over spaces',
    'metadata:',
    '  node_type: memory',
    '  type: user',
    `  createdAt: ${CREATED}`,
    `  updatedAt: ${UPDATED}`,
    '  lastAccessedAt: 2026-10-23T00:00:00.000Z',
    '---',
    '',
    'Uses tabs in every editor.',
    '',
  ].join('\n')
  const after = touchLastAccessed(before)
  assert.ok(typeof after === 'string' && after !== before)
  const front = parseFactFrontmatter(after)
  assert.equal(front.createdAt, CREATED, 'createdAt must not change')
  assert.equal(front.updatedAt, UPDATED, 'updatedAt must not change')
  assert.match(front.lastAccessedAt, /^\d{4}-\d{2}-\d{2}T/)
  // Everything outside the one line is byte-identical.
  assert.equal(
    after.replace(/  lastAccessedAt: .*\n/, ''),
    before.replace(/  lastAccessedAt: .*\n/, ''),
  )
})

test('touchLastAccessed inserts the line into a legacy file with metadata', () => {
  const legacy = [
    '---',
    'name: prefers-tabs',
    'description: Prefers tabs over spaces',
    'metadata:',
    '  node_type: memory',
    '  type: user',
    '---',
    '',
    'Uses tabs in every editor.',
    '',
  ].join('\n')
  const after = touchLastAccessed(legacy)
  assert.ok(typeof after === 'string')
  const front = parseFactFrontmatter(after)
  assert.match(front.lastAccessedAt, /^\d{4}-\d{2}-\d{2}T/)
  // The insert goes before the closing fence, after the last metadata entry.
  assert.match(after, /  type: user\n  lastAccessedAt: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n---/)
})

test('touchLastAccessed refuses files without frontmatter or metadata block', () => {
  assert.equal(touchLastAccessed('just some markdown'), undefined)
  const noMetadata = [
    '---',
    'name: prefers-tabs',
    'description: Prefers tabs over spaces',
    '---',
    '',
    'body',
  ].join('\n')
  assert.equal(touchLastAccessed(noMetadata), undefined)
  assert.equal(touchLastAccessed(undefined), undefined)
})

/* ---------------------------------------------------------- noteAccessHits */

function makePlugin() {
  return {
    disposed: false,
    byAgent: new Map(),
    bySession: new Map(),
  }
}

test('noteAccessHits records fact reads per layer and skips the index', () => {
  resetPendingAccessHits()
  const plugin = makePlugin()
  const key = normalizePathKey(WS + '\\.dsh\\memory')

  // A path-shaped read hits the workspace layer.
  const first = noteAccessHits(plugin, key, {
    name: 'read',
    arguments: JSON.stringify({ path: WS + '\\.dsh\\memory\\prefers-tabs.md' }),
  })
  assert.deepEqual(first, ['prefers-tabs'])
  assert.deepEqual(pendingAccessHitsOf(key), ['prefers-tabs'])

  // Bare-name args and dedup work; the index never counts.
  noteAccessHits(plugin, key, {
    name: 'read',
    arguments: JSON.stringify({ name: 'prefers-tabs.md' }),
  })
  noteAccessHits(plugin, key, {
    name: 'read',
    arguments: JSON.stringify({ path: WS + '\\.dsh\\memory\\MEMORY.md' }),
  })
  assert.deepEqual(pendingAccessHitsOf(key), ['prefers-tabs'])

  // A path that does not mention this layer root is not attributed to it.
  noteAccessHits(plugin, key, {
    name: 'read',
    arguments: JSON.stringify({ path: 'C:\\elsewhere\\other-fact.md' }),
  })
  assert.deepEqual(pendingAccessHitsOf(key), ['prefers-tabs'])

  resetPendingAccessHits()
})

test('noteAccessHits ignores write tools and collects across layers', () => {
  resetPendingAccessHits()
  const plugin = makePlugin()
  const wsKey = normalizePathKey(WS + '\\.dsh\\memory')
  const globalKey = normalizePathKey('C:\\global\\.dsh\\memory')

  assert.deepEqual(noteAccessHits(plugin, wsKey, {
    name: 'edit',
    arguments: JSON.stringify({ path: WS + '\\.dsh\\memory\\prefers-tabs.md' }),
  }), [])

  noteAccessHits(plugin, wsKey, {
    name: 'read',
    arguments: JSON.stringify({ path: WS + '\\.dsh\\memory\\prefers-tabs.md' }),
  })
  noteAccessHits(plugin, globalKey, {
    name: 'view',
    arguments: JSON.stringify({ path: 'C:\\global\\.dsh\\memory\\global-fact.md' }),
  })
  assert.deepEqual(pendingAccessHitsOf(wsKey), ['prefers-tabs'])
  assert.deepEqual(pendingAccessHitsOf(globalKey), ['global-fact'])

  resetPendingAccessHits()
})

test('access flush delay is the documented 3s debounce', () => {
  assert.equal(accessFlushDelay(), 3000)
})

/* ------------------------------------------------------------ integration */

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
      const prefix = target.displayPath.endsWith('\\') ? target.displayPath : target.displayPath + '\\'
      const entries = []
      for (const [key, value] of files) {
        if (!key.startsWith(prefix)) continue
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

/** Minimal fake Cordis context capturing registrations (extraction.test.mjs shape). */
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

/** Minimal fake Agent (extraction.test.mjs shape). */
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

test('read-hit flush rewrites lastAccessedAt on disk and catalog carries the three times', async () => {
  resetPendingAccessHits()
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const agent = createFakeAgent('sess_main', workspace)
    const services = {
      systemPrompt: {
        section: (section) => {
          ctxRef.sections.push(section)
          return () => {}
        },
      },
      connection: {
        fetch: {
          register: (route) => {
            ctxRef.rpcRoutes.push(route)
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
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
    }
    const ctxRef = createFakeCtx(services)

    apply(ctxRef, { globalMemoryRoot: globalDir })

    // A fact file with timestamps as D2 would have written them.
    const memoryDir = join(workspace, '.dsh', 'memory')
    const factPath = join(memoryDir, 'prefers-tabs.md')
    fs.files.set(factPath, [
      '---',
      'name: prefers-tabs',
      'description: Prefers tabs over spaces',
      'metadata:',
      '  node_type: memory',
      '  type: user',
      `  createdAt: ${CREATED}`,
      `  updatedAt: ${UPDATED}`,
      '---',
      '',
      'Uses tabs in every editor.',
      '',
    ].join('\n'))
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n')

    // The model's read tool hits the fact file; flush is debounced (3 s).
    const toolsResult = ctxRef.handlers.get('tools/result')[0]
    const exec = {
      agent,
      name: 'read',
      arguments: JSON.stringify({ path: factPath }),
    }
    toolsResult(exec)
    assert.deepEqual(pendingAccessHitsOf(normalizePathKey(memoryDir)), ['prefers-tabs'])

    // Wait past the debounce window for the batched flush to land.
    const readFact = () => fs.files.get(factPath)
    const stamped = await waitFor(() => {
      const front = parseFactFrontmatter(readFact())
      return front !== undefined && typeof front.lastAccessedAt === 'string'
    }, accessFlushDelay() + 2000)
    assert.equal(stamped, true, 'lastAccessedAt must reach disk after the flush window')
    const front = parseFactFrontmatter(readFact())
    assert.equal(front.createdAt, CREATED, 'createdAt must not change on access')
    assert.equal(front.updatedAt, UPDATED, 'updatedAt must not change on access')

    // The catalog surfaces all three timestamps as epoch ms for the panel.
    const handler = ctxRef.rpcRoutes[0].fetch
    const call = async (endpoint, payload) => {
      const request = new Request('http://localhost/api/dsh-workspace-memory/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rpcId: 'r1',
          type: 'client-request',
          method: 'dsh-workspace-memory/call',
          payload: { endpoint, payload },
        }),
      })
      const response = await handler(request)
      const body = await response.json()
      return body.result
    }
    const catalog = await call('catalog', { sessionId: 'sess_main' })
    assert.equal(catalog.ok, true)
    const row = catalog.value.workspaces.find((entry) => entry.path === workspace)
    assert.ok(row)
    const factRow = row.files.find((file) => file.name === 'prefers-tabs.md')
    assert.ok(factRow)
    assert.equal(factRow.createdAt, Date.parse(CREATED))
    assert.equal(factRow.updatedAt, Date.parse(UPDATED))
    assert.equal(typeof factRow.lastAccessedAt, 'number')
    assert.ok(factRow.lastAccessedAt > Date.parse(UPDATED), 'lastAccessedAt is now')

    resetPendingAccessHits()
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})
