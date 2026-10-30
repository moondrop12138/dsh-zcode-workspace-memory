/**
 * Host-half tests for the v0.4.0 extraction engine: a scripted model drives the
 * restricted-tool loop through the real `apply()`, and every write still has to
 * come out of the host's guarded apply pipeline.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { __internals, apply } from '../lib/host.js'

const { planExtractionWrites } = __internals

const memoryDirOf = (workspace) => join(workspace, '.dsh', 'memory')

/* --------------------------------------------------------------- fixtures */

/** Minimal real-filesystem adapter, for the cases that hit node's own unlink. */
function createRealFs() {
  return {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    stat: async (target) => {
      const info = await stat(target.displayPath).catch(() => undefined)
      if (info === undefined) return undefined
      return { version: `${info.mtimeMs}:${info.size}`, type: info.isDirectory() ? 'directory' : 'file', size: info.size }
    },
    readText: async (target) => readFile(target.displayPath, 'utf8'),
    listDir: async (target) => {
      const names = await readdir(target.displayPath)
      const entries = []
      for (const name of names) {
        const path = join(target.displayPath, name)
        const info = await stat(path).catch(() => undefined)
        if (info === undefined) continue
        entries.push({
          name,
          type: info.isDirectory() ? 'directory' : 'file',
          target: { targetKey: path, displayPath: path },
          size: info.size,
        })
      }
      return entries
    },
    writeText: async (target, content) => {
      const before = await readFile(target.displayPath, 'utf8').then((text) => text, () => null)
      await mkdir(dirname(target.displayPath), { recursive: true })
      await writeFile(target.displayPath, content, 'utf8')
      return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content }
    },
    contains: () => true,
  }
}

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
      const base = target.displayPath
      const trimmed = base.replace(/[\\/]+$/, '')
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
    unlink: async (target) => {
      files.delete(target.displayPath)
      return { ok: true }
    },
    contains: () => true,
  }
}

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
        handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler))
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

function createFakeAgent(sessionId, cwd) {
  return {
    id: sessionId,
    options: { provider: 'agent-provider', model: 'agent-model' },
    session: {
      id: sessionId,
      header: { cwd },
      requestContext: () => ({ provider: 'agent-provider', model: 'agent-model' }),
      requestHeader: () => undefined,
    },
    ctx: {},
  }
}

/** A reply that streams one text block and finishes with `kind`. */
function textReply(text, kind = 'stop') {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind } }
  }
}

/** A reply that asks for in-process memory tools. */
function toolReply(toolCalls, text = '') {
  return async function* () {
    let index = 0
    if (text.length > 0) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text }
      yield { type: 'block-end', index, block: { type: 'text', text } }
      index += 1
    }
    for (const call of toolCalls) {
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
      index += 1
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/**
 * One live harness: fake ctx, fake fs, one agent, and a scripted model whose
 * replies are consumed in order.
 * @param {{ workspace: string, config?: object, script: Array<Function> }} options
 */
async function createHarness(options) {
  const fs = options.real === true ? createRealFs() : createFakeFs()
  const agent = createFakeAgent('sess_agent', options.workspace)
  const calls = { llm: [] }
  const script = [...options.script]
  const services = {
    systemPrompt: { section: () => () => {} },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    workspaceRegistry: { list: () => [{ id: 'w1', path: options.workspace, title: 'demo' }] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: options.workspace }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'agent-provider', model: 'agent-model' }) },
    llm: {
      stream: (request) => {
        // The agent loop reuses one messages array; snapshot it per call.
        calls.llm.push({ ...request, messages: [...request.messages] })
        const next = script.shift()
        if (next === undefined) return textReply('Nothing to save.')()
        return next()
      },
    },
  }
  const ctx = createFakeCtx(services)
  apply(ctx, options.config ?? {})
  return {
    fs,
    ctx,
    agent,
    calls,
    emit: (name, ...args) => {
      for (const handler of ctx.handlers.get(name) ?? []) handler(...args)
    },
    emitTurn: (text) => {
      const session = agent.session
      const emit = (name, ...args) => {
        for (const handler of ctx.handlers.get(name) ?? []) handler(...args)
      }
      emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
      emit('session/event', session, {
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      })
      emit('session/event', session, {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
      })
      emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    },
    dispose: () => ctx.disposeAll(),
  }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 10))
  }
}

/* ------------------------------------------------------------------ tests */

test('the agent engine writes through tools and records turns and tool calls', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-agent-'))
  try {
    const harness = await createHarness({
      workspace,
      script: [
        toolReply([
          { id: 'c1', name: 'memory_list', arguments: '{}' },
          {
            id: 'c2',
            name: 'memory_write',
            arguments: JSON.stringify({
              name: 'prefers-tabs',
              title: 'Prefers tabs',
              type: 'user',
              description: 'Prefers tabs over spaces',
              body: 'Indent with tabs.',
            }),
          },
        ]),
        toolReply([{ id: 'c3', name: 'memory_read', arguments: JSON.stringify({ name: 'prefers-tabs' }) }]),
        textReply('Saved.'),
      ],
    })
    harness.emitTurn('please remember that I indented with tabs all day')
    const memoryDir = memoryDirOf(workspace)
    const wrote = await waitFor(() => harness.fs.files.has(join(memoryDir, 'prefers-tabs.md')))
    assert.equal(wrote, true, 'the tool write reached the fact file')
    assert.match(harness.fs.files.get(join(memoryDir, 'prefers-tabs.md')), /type: user/)
    assert.match(harness.fs.files.get(join(memoryDir, 'prefers-tabs.md')), /Indent with tabs\./)
    assert.match(harness.fs.files.get(join(memoryDir, 'MEMORY.md')), /prefers-tabs\.md/)
    assert.equal(harness.calls.llm.length, 3)
    // First request carries the tool schemas; every later one carries tool results.
    assert.equal(harness.calls.llm[0].tools.length, 6)
    assert.deepEqual(
      harness.calls.llm[0].tools.map((tool) => tool.name),
      ['memory_read', 'memory_list', 'memory_grep', 'memory_write', 'memory_edit', 'memory_delete'],
    )
    const second = harness.calls.llm[1].messages
    const toolResults = second.at(-1)
    assert.equal(toolResults.source.kind, 'tool')
    assert.equal(toolResults.content.length, 2)
    assert.equal(toolResults.content.every((block) => block.type === 'tool-result'), true)
    assert.match(harness.calls.llm[0].messages[0].content[0].text, /Available tools: memory_read/)
    // The activity feed names the engine that produced the write.
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('the agent engine forgets an existing fact through memory_delete', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-agent-'))
  try {
    const memoryDir = memoryDirOf(workspace)
    // The real-fs harness is used here because `forgetToTrash` unlinks the
    // original through node's own fs, outside the `ctx.fs` seam.
    await mkdir(join(workspace, '.dsh'), { recursive: true })
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, 'old-tabs.md'),
      '---\nname: old-tabs\ndescription: stale tabs note\nmetadata:\n  node_type: memory\n  type: project\n---\n\nTabs are gone.\n',
      'utf8',
    )
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [Old tabs](old-tabs.md) — stale tabs note\n', 'utf8')
    const harness = await createHarness({
      workspace,
      real: true,
      script: [
        toolReply([{ id: 'c1', name: 'memory_delete', arguments: JSON.stringify({ name: 'old-tabs' }) }]),
        textReply('Forgot it.'),
      ],
    })
    harness.emitTurn('actually we switched to spaces last week, forget the tabs note')
    const deleted = await waitFor(
      () => readFile(join(memoryDir, 'old-tabs.md'), 'utf8').then(() => false, () => true),
    )
    assert.equal(deleted, true, 'the fact file left the memory root')
    const index = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
    assert.doesNotMatch(index, /old-tabs/)
    const trashed = await readFile(join(memoryDir, 'trash', 'old-tabs.md'), 'utf8')
    assert.match(trashed, /stale tabs note/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a JSON reply in agent mode still lands through the one-shot parser', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-agent-'))
  try {
    const harness = await createHarness({
      workspace,
      script: [
        textReply('{"memories":[{"name":"deploy-from-main","title":"Deploy from main","type":"project","description":"Deploys run from main","body":"Deploy from the main branch."}],"forget":[]}'),
      ],
    })
    harness.emitTurn('for the record, deploys always run from the main branch here')
    const memoryDir = memoryDirOf(workspace)
    const wrote = await waitFor(() => harness.fs.files.has(join(memoryDir, 'deploy-from-main.md')))
    assert.equal(wrote, true)
    assert.equal(harness.calls.llm.length, 1)
    assert.equal(harness.calls.llm[0].tools.length, 6)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('an exhausted tool loop falls back to the one-shot prompt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-agent-'))
  try {
    const listCall = (id) => toolReply([{ id, name: 'memory_list', arguments: '{}' }])
    const harness = await createHarness({
      workspace,
      config: { agentMaxTurns: 2 },
      script: [
        listCall('c1'),
        listCall('c2'),
        // Fallback: the one-shot prompt carries no tool instructions.
        textReply('{"memories":[],"forget":[]}'),
      ],
    })
    harness.emitTurn('please note that the deploy window moved to Friday nights')
    await waitFor(() => harness.calls.llm.length >= 3)
    assert.equal(harness.calls.llm.length, 3)
    assert.equal(harness.calls.llm[0].tools.length, 6)
    assert.equal(harness.calls.llm[1].tools.length, 6)
    assert.equal(harness.calls.llm[2].tools, undefined)
    assert.match(harness.calls.llm[2].messages[0].content[0].text, /Reply with one JSON object/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('extractionMode json keeps the one-shot request without tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-agent-'))
  try {
    const harness = await createHarness({
      workspace,
      config: { extractionMode: 'json' },
      script: [textReply('{"memories":[],"forget":[]}')],
    })
    harness.emitTurn('please note that the deploy window moved to Friday nights')
    await waitFor(() => harness.calls.llm.length >= 1)
    assert.equal(harness.calls.llm.length, 1)
    assert.equal(harness.calls.llm[0].tools, undefined)
    assert.match(harness.calls.llm[0].messages[0].content[0].text, /Reply with one JSON object/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a failed agent stream falls back instead of losing the turn', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-agent-'))
  try {
    const failedStream = async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }
    }
    const harness = await createHarness({
      workspace,
      script: [
        () => failedStream(),
        textReply('{"memories":[],"forget":[]}'),
      ],
    })
    harness.emitTurn('please note that the deploy window moved to Friday nights')
    await waitFor(() => harness.calls.llm.length >= 2)
    assert.equal(harness.calls.llm.length, 2)
    assert.equal(harness.calls.llm[0].tools.length, 6)
    assert.equal(harness.calls.llm[1].tools, undefined)
    const memoryDir = memoryDirOf(workspace)
    assert.equal(await stat(memoryDir).then(() => true, () => false), true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('planExtractionWrites still owns every write the agent proposes', () => {
  const plan = planExtractionWrites({
    parsed: {
      memories: [{ name: 'prefers-tabs', title: 'Prefers tabs', type: 'user', description: 'Prefers tabs', body: 'Indent with tabs.' }],
      forget: [],
    },
    files: {},
    indexText: '',
    sessionId: 'sess_agent',
  })
  assert.equal(plan.writes.length, 1)
  assert.match(plan.writes[0].content, /originSessionId: sess_agent/)
  assert.match(plan.indexText, /prefers-tabs\.md/)
})
