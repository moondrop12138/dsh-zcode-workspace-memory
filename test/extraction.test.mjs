/**
 * Host-half tests for `dsh-workspace-memory`.
 *
 * Two layers:
 *
 *   1. Unit tests over the `__internals` seam (turn buffer, stream collector,
 *      write planner, Config reads, RPC envelope shapes).
 *   2. One integration test that drives the real `apply()` against a minimal
 *      fake Cordis context: section registration, live-Agent initialization,
 *      the completed-turn extraction path, and both RPC endpoints.
 *
 * The fake filesystem is an in-memory map; only the workspace directory that
 * `apply()` mkdirs is real, and it is created under the OS temp directory and
 * removed afterwards.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, __internals, apply } from '../lib/host.js'

const {
  applyAssistantMessage,
  applyToolResult,
  applyUserMessage,
  blocksToText,
  cfg,
  collectStreamText,
  createLinkedSignal,
  displayTitle,
  failure,
  isCompletedTurn,
  isEligibleSession,
  maxIndexChars,
  newTurnBuffer,
  normalizePathKey,
  normalizeResult,
  planExtractionWrites,
  schemaEntryCandidates,
  sessionIdOf,
  tailWithinBytes,
  workspaceRootOf,
} = __internals

const WS = 'C:\\work\\demo'

/* ------------------------------------------------------------------- config */

test('cfg reads plain values, volatile references, and falls back safely', () => {
  const plugin = { config: { enabled: false, autoExtract: { get: () => true }, throwing: { get: () => { throw new Error('boom') } } } }
  assert.equal(cfg(plugin, 'enabled', true), false)
  assert.equal(cfg(plugin, 'autoExtract', false), true)
  assert.equal(cfg(plugin, 'missing', 'fallback'), 'fallback')
  assert.equal(cfg(plugin, 'throwing', 'fallback'), 'fallback')
  assert.equal(cfg({ config: undefined }, 'enabled', true), true)
  assert.equal(cfg(plugin, 'autoExtract', false) === true, true)
})

test('maxIndexChars rejects nonsense and keeps the default', () => {
  assert.equal(maxIndexChars({ config: { maxIndexChars: { get: () => 1234 } } }), 1234)
  assert.equal(maxIndexChars({ config: { maxIndexChars: -5 } }), 25000)
  assert.equal(maxIndexChars({ config: {} }), 25000)
})

test('the loaded Config schema exposes the four volatile switches', () => {
  if (Config === undefined) {
    // The workspace has no @deepseek-ai/schemastery; that is the documented
    // degraded mode, not a test failure.
    return
  }
  const parsed = Config({ enabled: false })
  assert.equal(parsed.enabled.get(), false)
  assert.equal(parsed.autoExtract.get(), true)
  assert.equal(parsed.maxIndexChars.get(), 25000)
  assert.equal(parsed.debugLog.get(), false)
})

test('schema fallback candidates are absolute and profile-aware', () => {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = 'C:\\dsh\\profiles\\desktop'
  try {
    const candidates = schemaEntryCandidates()
    assert.ok(candidates.length > 0)
    assert.equal(candidates[0], join('C:\\dsh\\profiles\\desktop', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'))
    assert.ok(candidates.every((entry) => entry.includes('node_modules')))
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

/* ------------------------------------------------------- identity and paths */

test('session identity and workspace root tolerate wrapper shapes', () => {
  assert.equal(sessionIdOf({ id: 's1' }), 's1')
  assert.equal(sessionIdOf({ header: { id: 's2' } }), 's2')
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(workspaceRootOf({ header: { cwd: WS } }), WS)
  assert.equal(workspaceRootOf({}), process.cwd())
  assert.equal(displayTitle('C:\\work\\demo'), 'demo')
  assert.equal(displayTitle('/a/b/c', 'Title'), 'Title')
  assert.equal(normalizePathKey(WS + '\\') === normalizePathKey(WS), true)
})

test('only main sessions are eligible', () => {
  assert.equal(isEligibleSession({ header: { origin: 'subagent' } }), false)
  assert.equal(isEligibleSession({ header: { origin: undefined } }), true)
  assert.equal(isEligibleSession({ header: {} }), true)
  assert.equal(isEligibleSession({}), true)
})

/* -------------------------------------------------------------- turn buffer */

test('only user-authored text enters prose and the transcript', () => {
  const buffer = newTurnBuffer()
  applyUserMessage(buffer, { source: { kind: 'user' }, content: [{ type: 'text', text: 'remember this preference' }] })
  applyUserMessage(buffer, { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Current runtime context' }] })
  applyUserMessage(buffer, { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'workspace instructions' }] })
  applyUserMessage(buffer, { source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] })
  assert.deepEqual(buffer.userBlocks, ['remember this preference'])
  assert.equal(buffer.messageCount, 1)
  assert.deepEqual(buffer.messages, [{ role: 'user', text: 'remember this preference' }])
})

test('assistant text blocks are collected without tool arguments', () => {
  const buffer = newTurnBuffer()
  applyAssistantMessage(buffer, {
    turn: 1,
    step: 1,
    message: {
      content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'Done. I saved that.' },
        { type: 'tool-call', id: 'c1', name: 'write', arguments: '{"path":"x"}' },
      ],
    },
  })
  assert.deepEqual(buffer.messages, [{ role: 'assistant', text: 'Done. I saved that.' }])
  assert.equal(buffer.messageCount, 1)
})

test('blocksToText joins text blocks and ignores everything else', () => {
  assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(blocksToText([{ type: 'tool-call' }]), '')
  assert.equal(blocksToText(undefined), '')
})

test('a write tool mentioning the memory root marks a direct memory write', () => {
  const buffer = newTurnBuffer()
  applyToolResult(buffer, normalizePathKey(`${WS}\\.dsh\\memory`), { name: 'read', arguments: { path: `${WS}\\.dsh\\memory\\MEMORY.md` } })
  assert.equal(buffer.directWrite, false, 'a read is not a direct write')
  applyToolResult(buffer, normalizePathKey(`${WS}\\.dsh\\memory`), { name: 'write', arguments: { file_path: `${WS}\\.Dsh\\Memory\\prefers-tabs.md` } })
  assert.equal(buffer.directWrite, true, 'path matching is case-insensitive on Windows')
  const other = newTurnBuffer()
  applyToolResult(other, normalizePathKey(`${WS}\\.dsh\\memory`), { name: 'edit', arguments: { path: `${WS}\\src\\app.ts` } })
  assert.equal(other.directWrite, false)
  applyToolResult(other, normalizePathKey(`${WS}\\.dsh\\memory`), { name: 'write', arguments: undefined })
  assert.equal(other.directWrite, false)
})

test('turn completion requires a completed turn/end', () => {
  assert.equal(isCompletedTurn({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), true)
  assert.equal(isCompletedTurn({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), false)
  assert.equal(isCompletedTurn({ type: 'turn/start', data: {} }), false)
  assert.equal(isCompletedTurn(undefined), false)
})

/* ------------------------------------------------------------- stream/plans */

test('collectStreamText joins deltas and requires a clean finish', async () => {
  const clean = await collectStreamText((async function* () {
    yield { type: 'text-delta', index: 0, text: '{"memories":' }
    yield { type: 'text-delta', index: 0, text: '[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  assert.deepEqual(clean, { ok: true, text: '{"memories":[]}' })

  const failed = await collectStreamText((async function* () {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'nope' } } }
  })())
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'error')
  assert.equal(failed.detail, 'nope')

  const noFinish = await collectStreamText((async function* () {
    yield { type: 'text-delta', index: 0, text: 'x' }
  })())
  assert.equal(noFinish.ok, false)
  assert.equal(noFinish.reason, 'no-finish')
})

test('createLinkedSignal propagates and disposes abort listeners', () => {
  const a = new AbortController()
  const b = new AbortController()
  const linked = createLinkedSignal([a.signal, b.signal])
  assert.equal(linked.signal.aborted, false)
  b.abort()
  assert.equal(linked.signal.aborted, true)
  linked.dispose()
  const only = createLinkedSignal([a.signal])
  assert.equal(only.signal, a.signal)
  only.dispose()
})

test('planExtractionWrites creates facts, preserves origins, and edits the index', () => {
  const parsed = {
    memories: [
      { name: 'prefers-tabs', title: 'Prefers tabs', type: 'user', description: 'Uses tabs', body: 'Uses tabs.' },
      {
        name: 'run-tests',
        title: 'Run tests',
        type: 'feedback',
        description: 'Always run tests',
        body: 'Tests before commit.',
        why: 'Catches regressions',
        howToApply: 'Run node --test',
      },
    ],
    forget: ['stale-fact', 'not a name'],
  }
  const plan = planExtractionWrites({
    parsed,
    files: {
      'run-tests.md': '---\nname: run-tests\ndescription: old\nmetadata:\n  type: feedback\n  originSessionId: sess_original\n---\nold body\n',
    },
    indexText: '- [Stale](stale-fact.md) — outdated\n',
    sessionId: 'sess_current',
  })
  assert.ok(plan)
  assert.equal(plan.writes.length, 2)
  assert.equal(plan.writes[0].fileName, 'prefers-tabs.md')
  assert.match(plan.writes[0].content, /originSessionId: sess_current/)
  assert.match(plan.writes[1].content, /originSessionId: sess_original/)
  assert.match(plan.writes[1].content, /\*\*Why:\*\* Catches regressions/)
  assert.match(plan.writes[1].content, /\*\*How to apply:\*\* Run node --test/)
  assert.deepEqual(plan.deletes, ['stale-fact.md'])
  assert.match(plan.indexText, /- \[Prefers tabs\]\(prefers-tabs.md\) — Uses tabs/)
  assert.match(plan.indexText, /- \[Run tests\]\(run-tests.md\) — Always run tests/)
  assert.equal(plan.indexText.includes('stale-fact.md'), false)
  assert.equal(plan.indexChanged, true)
})

test('planExtractionWrites drops invalid entries and reports a no-op', () => {
  const plan = planExtractionWrites({
    parsed: {
      memories: [
        { name: 'Bad Name', title: 'x', type: 'user', description: 'x', body: 'x' },
        { name: 'no-type', title: 'x', type: 'nope', description: 'x', body: 'x' },
        { name: 'memory', title: 'x', type: 'user', description: 'x', body: 'x' },
        { name: 'empty-body', title: 'x', type: 'user', description: 'x', body: '' },
      ],
      forget: [],
    },
    files: {},
    indexText: '',
    sessionId: 's1',
  })
  assert.ok(plan)
  assert.deepEqual(plan.writes, [])
  assert.equal(plan.indexChanged, false)
  assert.equal(planExtractionWrites({ parsed: null }), undefined)
})

test('tailWithinBytes keeps the newest content under the cap', () => {
  const short = tailWithinBytes('hello', 10)
  assert.deepEqual(short, { text: 'hello', truncated: false })
  const long = tailWithinBytes('a'.repeat(100), 10)
  assert.equal(long.truncated, true)
  assert.ok(long.text.length <= 10)
  assert.equal(long.text.endsWith('a'), true)
})

/* ------------------------------------------------------------- rpc envelope */

test('failure and normalizeResult emit the contracted shapes', () => {
  assert.deepEqual(failure('bad-request', 'nope'), {
    ok: false,
    error: { code: 'bad-request', message: 'nope', details: {} },
  })
  assert.deepEqual(normalizeResult({ ok: true, value: { a: 1 } }), { ok: true, value: { a: 1 } })
  assert.equal(normalizeResult({ ok: true, value: undefined }).ok, false)
  const normalized = normalizeResult({ ok: false, error: { code: 'x', message: 'y', details: { k: 1 } } })
  assert.deepEqual(normalized, { ok: false, error: { code: 'x', message: 'y', details: { k: 1 } } })
  assert.equal(normalizeResult(undefined).ok, false)
})

/* -------------------------------------------------------------- integration */

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

test('apply wires the section, live agents, extraction, and both RPC endpoints', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  try {
    const fs = createFakeFs()
    const agent = createFakeAgent('sess_main', workspace)
    const calls = { llm: [] }
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
        stream: (options) => {
          calls.llm.push(options)
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: '{"memories":[{"name":"prefers-tabs","title":"Prefers tabs",' }
            yield {
              type: 'text-delta',
              index: 0,
              text: '"type":"user","description":"Prefers tabs over spaces","body":"Uses tabs."}],"forget":[]}',
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const ctxRef = createFakeCtx(services)

    apply(ctxRef, {})

    // 1. Section registered with the frozen name/order and a synchronous provider.
    assert.equal(ctxRef.sections.length, 1)
    assert.equal(ctxRef.sections[0].name, 'workspace-memory:instructions')
    assert.equal(ctxRef.sections[0].order, 450)
    const sectionText = () => ctxRef.sections[0].text({ agent })

    // 2. A live Agent is initialized asynchronously: cache filled, directory created.
    const memoryDir = join(workspace, '.dsh', 'memory')
    assert.equal(await waitFor(() => sectionText().includes('# Memory')), true)
    assert.equal(sectionText().includes(memoryDir), true)
    assert.equal((await stat(memoryDir)).isDirectory(), true)

    // 3. RPC route registered; catalog lists the workspace and read returns a file.
    assert.equal(ctxRef.rpcRoutes.length, 1)
    assert.equal(ctxRef.rpcRoutes[0].path, '/api/dsh-workspace-memory/call')
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n')
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
      return (await handler(request)).json()
    }

    const catalog = await call('catalog', {})
    assert.equal(catalog.type, 'server-response')
    assert.equal(catalog.rpcId, 'r1')
    assert.equal(catalog.result.ok, true)
    assert.deepEqual(catalog.result.value.config, { enabled: true, autoExtract: true })
    assert.equal(catalog.result.value.workspaces.length, 1)
    assert.equal(catalog.result.value.workspaces[0].path, workspace)
    assert.deepEqual(catalog.result.value.workspaces[0].files.map((file) => file.name), ['MEMORY.md'])

    const read = await call('read', { path: workspace, name: 'MEMORY.md' })
    assert.equal(read.result.ok, true)
    assert.match(read.result.value.content, /Prefers tabs/)
    assert.equal(read.result.value.truncated, false)

    const traversal = await call('read', { path: workspace, name: '../settings.yaml' })
    assert.equal(traversal.result.ok, false)
    assert.equal(traversal.result.error.code, 'invalid-path')

    const unknown = await call('nope', {})
    assert.equal(unknown.result.ok, false)
    assert.equal(unknown.result.error.code, 'unknown-endpoint')

    const badEnvelope = await handler(new Request('http://localhost/api/dsh-workspace-memory/call', {
      method: 'POST',
      body: '{}',
    })).then((response) => response.json())
    assert.equal(badEnvelope.result.ok, false)
    assert.equal(badEnvelope.result.error.code, 'bad-request')

    // 4. A completed turn with user prose triggers one extraction with the
    //    session's own route and writes the fact plus the index.
    const emit = (name, ...args) => {
      for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please remember that I prefer tabs' }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    assert.equal(await waitFor(() => fs.writes.some((write) => write.path.endsWith('prefers-tabs.md'))), true)
    assert.equal(calls.llm.length, 1)
    assert.equal(calls.llm[0].provider, 'ctx-provider')
    assert.equal(calls.llm[0].model, 'ctx-model')
    assert.equal(calls.llm[0].sessionId, 'sess_main')
    assert.match(calls.llm[0].messages[0].content[0].text, /memory extraction subagent/)
    assert.match(calls.llm[0].system, /# Memory/)
    const fact = fs.files.get(join(memoryDir, 'prefers-tabs.md'))
    assert.match(fact, /originSessionId: sess_main/)
    assert.match(fs.files.get(join(memoryDir, 'MEMORY.md')), /- \[Prefers tabs\]\(prefers-tabs\.md\) — Prefers tabs over spaces/)

    // 5. A turn that wrote memory itself is skipped (ZCode direct-write rule).
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'remember one more thing please' }] },
    })
    emit('tools/result', { name: 'write', agent, arguments: { file_path: join(memoryDir, 'x.md') } })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await new Promise((done) => setTimeout(done, 50))
    assert.equal(calls.llm.length, 1)

    // 6. A turn with no eligible user prose is skipped as well.
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 3 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await new Promise((done) => setTimeout(done, 50))
    assert.equal(calls.llm.length, 1)

    // 7. Disposal aborts and releases everything without throwing.
    ctxRef.disposeAll()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('apply degrades when optional services are missing', async () => {
  const ctx = createFakeCtx({})
  assert.doesNotThrow(() => apply(ctx, {}))
  ctx.disposeAll()
})

test('an index that lost pointer lines is repaired from the fact files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const fact = (name, description, type) => '---\nname: ' + name + '\ndescription: ' + description
      + '\nmetadata:\n  node_type: memory\n  type: ' + type + '\n---\nbody\n'
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Alpha](alpha.md) '+ '\u2014' + ' first fact\n')
    fs.files.set(join(memoryDir, 'alpha.md'), fact('alpha', 'first fact', 'user'))
    fs.files.set(join(memoryDir, 'beta.md'), fact('beta', 'second fact', 'project'))
    const agent = createFakeAgent('sess_repair', workspace)
    const services = {
      systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
    }
    const ctxRef = createFakeCtx(services)
    apply(ctxRef, {})

    const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
    assert.equal(await waitFor(() => sectionText().includes('beta.md')), true)
    const index = fs.files.get(join(memoryDir, 'MEMORY.md'))
    assert.match(index, /- \[Alpha\]\(alpha\.md\)/)
    assert.match(index, /- \[Beta\]\(beta\.md\) \u2014 second fact/)
    assert.match(fs.files.get(join(memoryDir, 'MEMORY.md.prev')), /\[Alpha\]/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a minimal session neither reads nor writes memory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-min-'))
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const fact = '---\nname: alpha\ndescription: first fact\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n'
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Alpha](alpha.md) ' + '\u2014' + ' first fact\n')
    fs.files.set(join(memoryDir, 'alpha.md'), fact)
    const reads = []
    const originalReadText = fs.readText
    fs.readText = async (target) => {
      reads.push(target.displayPath)
      return originalReadText(target)
    }
    const agent = createFakeAgent('sess_minimal', workspace)
    agent.session.header.agentPreset = 'minimal'
    const calls = { llm: [] }
    const services = {
      systemPrompt: {
        section: (section) => {
          ctxRef.sections.push(section)
          return () => {}
        },
      },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const ctxRef = createFakeCtx(services)

    apply(ctxRef, {})
    await new Promise((done) => setTimeout(done, 80))

    // The index is never opened and the section stays empty.
    assert.deepEqual(reads, [])
    assert.equal(ctxRef.sections[0].text({ agent }), '')

    // A completed turn with user prose extracts nothing and writes nothing.
    const emit = (name, ...args) => {
      for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please remember that I prefer tabs' }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((done) => setTimeout(done, 80))

    assert.equal(calls.llm.length, 0)
    assert.deepEqual(fs.writes, [])
    assert.equal(fs.files.get(join(memoryDir, 'MEMORY.md')), '- [Alpha](alpha.md) ' + '\u2014' + ' first fact\n')
    assert.equal(fs.files.has(join(memoryDir, 'alpha.md')), true)
    ctxRef.disposeAll()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
