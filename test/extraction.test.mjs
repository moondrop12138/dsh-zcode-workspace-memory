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
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, __internals, apply } from '../lib/host.js'
import { memoryRoot } from '../lib/memory-core.js'

const {
  ACTIVITY_KEEP,
  applyAssistantMessage,
  applyToolResult,
  applyUserMessage,
  blocksToText,
  cfg,
  collectStreamText,
  createLinkedSignal,
  displayTitle,
  extractDailyLimit,
  extractMinIntervalMs,
  failure,
  isCompletedTurn,
  isEligibleSession,
  isSubagentSession,
  maxIndexChars,
  newTurnBuffer,
  normalizePathKey,
  normalizeResult,
  planExtractionWrites,
  recordActivity,
  resetWorkspaceActivities,
  schemaEntryCandidates,
  sessionIdOf,
  tailWithinBytes,
  workspaceActivitiesOf,
  workspaceBudgetOf,
  workspaceLockSize,
  workspaceRootOf,
} = __internals

// The fixtures build real path key shapes through `node:path`, so they must be
// absolute for the *host* platform: Windows keeps a drive-letter root, POSIX
// gets a plain absolute root. Hardcoding a Windows root made every
// `path.resolve`-based lookup miss on Linux.
const WS = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'

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

test('extraction budget helpers reject nonsense and default to unlimited', () => {
  assert.equal(extractMinIntervalMs({ config: { extractMinIntervalMs: { get: () => 5000 } } }), 5000)
  assert.equal(extractMinIntervalMs({ config: { extractMinIntervalMs: -1 } }), 0)
  assert.equal(extractMinIntervalMs({ config: {} }), 0)
  assert.equal(extractDailyLimit({ config: { extractDailyLimit: { get: () => 3 } } }), 3)
  assert.equal(extractDailyLimit({ config: { extractDailyLimit: 1.5 } }), 0)
  assert.equal(extractDailyLimit({ config: {} }), 0)
})

test('the loaded Config schema exposes the volatile switches', () => {
  if (Config === undefined) {
    // The workspace has no @deepseek-ai/schemastery; that is the documented
    // degraded mode, not a test failure.
    return
  }
  const parsed = Config({ enabled: false })
  assert.equal(parsed.enabled.get(), false)
  assert.equal(parsed.autoExtract.get(), true)
  assert.equal(parsed.maxIndexChars.get(), 25000)
  assert.equal(parsed.extractMinIntervalMs.get(), 0)
  assert.equal(parsed.extractDailyLimit.get(), 0)
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

test('the host module imports without a top-level schema await', () => {
  // Reaching this line means the static import above completed: no await
  // blocks module evaluation even when the schema package is absent.
  const { loadSchemaModule } = __internals
  assert.equal(typeof loadSchemaModule, 'function')
  const resolved = loadSchemaModule()
  // In this workspace the package is not on the search path: undefined is the
  // documented degrade. Where it exists, the value must be the schema module.
  if (resolved !== undefined) assert.equal(typeof resolved.object, 'function')
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

test('subagent sessions are eligible for a read-only section; only non-objects are excluded', () => {
  assert.equal(isEligibleSession({ header: { origin: 'subagent' } }), true)
  assert.equal(isEligibleSession({ header: { origin: undefined } }), true)
  assert.equal(isEligibleSession({ header: {} }), true)
  assert.equal(isEligibleSession({}), true)
  assert.equal(isEligibleSession(undefined), false)
  assert.equal(isEligibleSession('session'), false)
})

test('isSubagentSession recognizes subagent origin and rejects other shapes', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
  assert.equal(isSubagentSession({ header: { origin: 'main' } }), false)
  assert.equal(isSubagentSession({ header: {} }), false)
  assert.equal(isSubagentSession({}), false)
  assert.equal(isSubagentSession(undefined), false)
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
  // Only a case-insensitive filesystem (Windows) folds the alternate spelling
  // back into the memory root; POSIX keeps it a different directory.
  assert.equal(buffer.directWrite, process.platform === 'win32', 'path matching follows the platform filesystem case rules')
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
      const base = target.displayPath
      const trimmed = base.replace(/[\\/]+$/, '')
      // Both separators are accepted because the fixture may hold keys written
      // with either one; the appended one must match the host platform so a
      // POSIX fixture directory is not searched for as "...\".
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
 * A real-disk fs adapter for the forget-to-trash test: the trash move writes
 * through the fs seam but unlinks with node fs, so both halves of that dance
 * must see the same bytes for the test to be meaningful.
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

/**
 * Poll an async reader until its value satisfies `predicate` and return that
 * value. A disk write (the index rewrite) lands a tick after the file it
 * describes, so a single `readFile` right after the first artefact appears is a
 * race on a loaded CI runner.
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

test('apply wires the section, live agents, extraction, and both RPC endpoints', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let ctxRef
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

    apply(ctxRef, {  })

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
    //    session's own route and writes the fact plus the index. Seed the
    //    workspace index only now (after the catalog assertions above, which
    //    expect no memory row yet): the type-user memory writes here.
    fs.files.set(join(globalDir, 'MEMORY.md'), '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n')
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
    const fact = fs.files.get(join(globalDir, 'prefers-tabs.md'))
    assert.match(fact, /originSessionId: sess_main/)
    assert.match(fs.files.get(join(globalDir, 'MEMORY.md')), /- \[Prefers tabs\]\(prefers-tabs\.md\) — Prefers tabs over spaces/)

    // 5. A turn that wrote memory itself is skipped (ZCode direct-write rule).
    //    The write mentions the workspace memory root, where extraction
    //    writes, so the skip rule must fire.
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'remember one more thing please' }] },
    })
    emit('tools/result', { name: 'write', agent, arguments: { file_path: join(globalDir, 'x.md') } })
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

    // 7. The applied run is reported by the activities endpoint (C1): one
    //    newest-first entry for this workspace with the index diff texts.
    //    v2.1: memory is workspace-only, so the entry lands in the one ring
    //    and its `workspace` label is the workspace root.
    const activities = await call('activities', { sessionId: 'sess_main' })
    assert.equal(activities.result.ok, true)
    const feed = activities.result.value.activities
    assert.equal(feed.length, 1)
    assert.equal(feed[0].workspace, workspace)
    assert.deepEqual(feed[0].wrote, ['prefers-tabs.md'])
    assert.deepEqual(feed[0].forgot, [])
    assert.equal(feed[0].diffSummary, '+1')
    assert.match(feed[0].indexBefore, /Prefers tabs.*Uses tabs/)
    assert.match(feed[0].indexAfter, /Prefers tabs over spaces/)
    assert.equal(feed[0].at > 0, true)
    // A forged sessionId widens nothing: the whitelist already covers this
    // workspace, so the feed stays exactly the same single entry.
    const forged = await call('activities', { sessionId: 'sess_forged' })
    assert.equal(forged.result.ok, true)
    assert.deepEqual(forged.result.value.activities, feed)

    // 8. Disposal aborts and releases everything without throwing.
    ctxRef.disposeAll()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('catalog only exposes registered workspaces and the source session workspace', async () => {
  const workspaceA = await mkdtemp(join(tmpdir(), 'dwm-catalog-a-'))
  const workspaceB = await mkdtemp(join(tmpdir(), 'dwm-catalog-b-'))
  try {
    const fs = createFakeFs()
    const agentMain = createFakeAgent('sess_main', workspaceA)
    const agentOther = createFakeAgent('sess_other', workspaceB)
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
      agents: { list: () => [agentMain, agentOther] },
      // Only workspaceA is registered; workspaceB is merely the cwd of a live session.
      workspaceRegistry: { list: () => [{ id: 'w1', path: workspaceA, title: 'registered' }] },
      fs,
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    }
    const ctxRef = createFakeCtx(services)

    apply(ctxRef, {})

    const sectionFor = (agent) => ctxRef.sections[0].text({ agent })
    // Both agents initialized: sess_other is tracked, so the hint below can resolve it.
    assert.equal(await waitFor(() => sectionFor(agentOther).includes(join(workspaceB, '.dsh', 'memory'))), true)

    fs.files.set(join(workspaceA, '.dsh', 'memory', 'MEMORY.md'), '- [A](a.md) — Workspace A\n')
    fs.files.set(join(workspaceB, '.dsh', 'memory', 'MEMORY.md'), '- [B](b.md) — Workspace B\n')
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

    // 1. Anonymous catalog: the unregistered workspace must not leak through its session cwd.
    const anonymous = await call('catalog', {})
    assert.equal(anonymous.result.ok, true)
    assert.deepEqual(anonymous.result.value.workspaces.map((workspace) => workspace.path), [workspaceA])

    // 2. A forged sessionId resolves to nothing and widens nothing.
    const forged = await call('catalog', { sessionId: 'sess_forge' })
    assert.deepEqual(forged.result.value.workspaces.map((workspace) => workspace.path), [workspaceA])

    // 3. A tracked session sees the whitelist plus its own workspace, and nothing else.
    const other = await call('catalog', { sessionId: 'sess_other' })
    assert.deepEqual(other.result.value.workspaces.map((workspace) => workspace.path), [workspaceA, workspaceB])
    const main = await call('catalog', { sessionId: 'sess_main' })
    assert.deepEqual(main.result.value.workspaces.map((workspace) => workspace.path), [workspaceA])

    // 4. `read` is narrowed the same way.
    const denied = await call('read', { path: workspaceB, name: 'MEMORY.md' })
    assert.equal(denied.result.ok, false)
    assert.equal(denied.result.error.code, 'invalid-path')
    const allowed = await call('read', { path: workspaceB, name: 'MEMORY.md', sessionId: 'sess_other' })
    assert.equal(allowed.result.ok, true)
    assert.match(allowed.result.value.content, /Workspace B/)

    ctxRef.disposeAll()
  } finally {
    await rm(workspaceA, { recursive: true, force: true })
    await rm(workspaceB, { recursive: true, force: true })
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

test('repairIndex rebuilds missing pointers within its per-file read budget', async () => {
  const { repairIndex } = __internals
  const plugin = { config: { debugLog: true } }
  const fs = createFakeFs()
  const memoryDir = join(WS, '.dsh', 'memory')
  const fact = (name, description) => '---\nname: ' + name + '\ndescription: ' + description
    + '\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n'
  fs.files.set(join(memoryDir, 'MEMORY.md'), '')
  fs.files.set(join(memoryDir, 'alpha.md'), fact('alpha', 'first fact'))
  fs.files.set(join(memoryDir, 'beta.md'), fact('beta', 'second fact'))
  const record = { memoryRoot: memoryDir, sessionId: 'sess_budget' }

  const repaired = await repairIndex(plugin, fs, record, '')
  assert.ok(repaired.text.includes('- [Alpha](alpha.md)'))
  assert.ok(repaired.text.includes('- [Beta](beta.md)'))
  assert.equal(repaired.added, 2)
})

test('repairIndex stops reading when the per-file read budget runs out', async () => {
  const { repairIndex } = __internals
  const plugin = { config: { debugLog: true } }
  const fs = createFakeFs()
  const memoryDir = join(WS, '.dsh', 'memory')
  fs.files.set(join(memoryDir, 'MEMORY.md'), '')
  for (let index = 0; index < 4; index += 1) {
    fs.files.set(join(memoryDir, 'fact-' + index + '.md'),
      '---\nname: fact-' + index + '\ndescription: d\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n')
  }
  const record = { memoryRoot: memoryDir, sessionId: 'sess_exhaust' }
  const originalReadText = fs.readText
  // Every read takes longer than the budget handed to repairIndex below.
  fs.readText = async (target) => {
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    return originalReadText(target)
  }

  try {
    // The budget expires after the first in-flight read completes, so the
    // rebuild keeps that one pointer and stops before the remaining three.
    const exhausted = await repairIndex(plugin, fs, record, '', 10)
    assert.deepEqual(exhausted, { text: '- [Fact 0](fact-0.md) \u2014 d\n', added: 1 })
    const journal = await readFile(join(tmpdir(), 'workspace-memory-host.log'), 'utf8')
    assert.match(journal, /index repair budget of 10ms exhausted; 1 of 4 pointer\(s\) rebuilt/)

    // No budget pressure at all: every missing pointer is rebuilt.
    const full = await repairIndex(plugin, fs, record, '')
    assert.equal(full.added, 4)
  } finally {
    fs.readText = originalReadText
  }
})

test('concurrent sessions of one workspace serialize their extraction writes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-lock-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let ctxRef
  let releaseIndexWrite = () => {}
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const globalMemoryDir = globalDir
    const agentA = createFakeAgent('sess_a', workspace)
    const agentB = createFakeAgent('sess_b', workspace)
    const calls = { llm: [] }
    // Interleave lever: the first index write that mentions prefers-tabs
    // stalls until the test releases it. Session B's model call therefore
    // completes while session A still holds the layer lock; without the
    // lock B would upsert the index from a stale base and drop A's pointer.
    // v2: both memories are type user, so the raced index is the global
    // layer's MEMORY.md.
    let holdIndexWrite = true
    const memories = {
      sess_a: { name: 'prefers-tabs', title: 'Prefers tabs', description: 'Prefers tabs over spaces', body: 'Uses tabs.' },
      sess_b: { name: 'likes-ts', title: 'Likes TS', description: 'Prefers TypeScript', body: 'Writes TS.' },
    }
    const replyFor = (memory) => '{"memories":[{"name":"' + memory.name + '","title":"' + memory.title
      + '","type":"user","description":"' + memory.description + '","body":"' + memory.body + '"}],"forget":[]}'
    const services = {
      systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
      agents: { list: () => [agentA, agentB] },
      sessions: { list: () => [agentA.session, agentB.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          const memory = memories[options.sessionId] ?? memories.sess_b
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: replyFor(memory) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const originalWriteText = fs.writeText
    fs.writeText = async (target, content) => {
      if (holdIndexWrite && target.displayPath === join(globalMemoryDir, 'MEMORY.md') && content.includes('prefers-tabs')) {
        holdIndexWrite = false
        await new Promise((done) => { releaseIndexWrite = done })
      }
      return originalWriteText(target, content)
    }
    ctxRef = createFakeCtx(services)
    const emit = (agent, turn, text) => {
      for (const registered of ctxRef.handlers.get('session/event') ?? []) {
        registered(agent.session, { type: 'turn/start', data: { turn } })
        registered(agent.session, {
          type: 'user/message',
          data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
        })
        registered(agent.session, {
          type: 'assistant/message',
          data: { turn, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
        })
        registered(agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      }
    }
    const indexHasBoth = () => {
      const text = fs.files.get(join(globalMemoryDir, 'MEMORY.md')) ?? ''
      return text.includes('prefers-tabs.md') && text.includes('likes-ts.md')
    }
    apply(ctxRef, {  })
    emit(agentA, 1, 'please remember that I prefer tabs')
    emit(agentB, 1, 'please remember that I like typescript')

    // Both model calls ran while session A still holds the lock, so the index
    // cannot hold both pointers yet — the writes were serialized.
    assert.equal(await waitFor(() => calls.llm.length === 2), true)
    await new Promise((done) => setTimeout(done, 50))
    assert.equal(indexHasBoth(), false)

    releaseIndexWrite()
    assert.equal(await waitFor(indexHasBoth), true)
    const index = fs.files.get(join(globalMemoryDir, 'MEMORY.md'))
    assert.match(index, /- \[Prefers tabs\]\(prefers-tabs\.md\) — Prefers tabs over spaces/)
    assert.match(index, /- \[Likes TS\]\(likes-ts\.md\) — Prefers TypeScript/)
    assert.equal(fs.files.has(join(globalMemoryDir, 'prefers-tabs.md')), true)
    assert.equal(fs.files.has(join(globalMemoryDir, 'likes-ts.md')), true)
    assert.equal(calls.llm.length, 2)
    assert.equal(await waitFor(() => workspaceLockSize() === 0), true)
    ctxRef.disposeAll()
    assert.equal(workspaceLockSize(), 0)
  } finally {
    releaseIndexWrite()
    if (ctxRef) ctxRef.disposeAll()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('forget moves the fact into trash and keeps the manifest clean', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    // Real disk on purpose: the trash move writes through the fs seam but
    // unlinks with node fs, so both halves must see the same bytes.
    const fs = createRealFs()
    const memoryDir = globalDir
    const trashDir = join(memoryDir, 'trash')
    const fact = '---\nname: stale-fact\ndescription: outdated fact\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n'
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [Stale](stale-fact.md) \u2014 outdated\n', 'utf8')
    await writeFile(join(memoryDir, 'stale-fact.md'), fact, 'utf8')
    const agent = createFakeAgent('sess_forget', workspace)
    const calls = { llm: [] }
    const services = {
      systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: '{"memories":[],"forget":["stale-fact"]}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const ctxRef = createFakeCtx(services)

    apply(ctxRef, {  })
    const emit = (name, ...args) => {
      for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please forget the stale fact' }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Forgotten.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(await waitFor(() => existsSync(join(trashDir, 'stale-fact.md'))), true)

    // The extraction ran and only forgot.
    assert.equal(calls.llm.length, 1)

    // The original fact is gone; the trash copy carries the full content.
    assert.equal(existsSync(join(memoryDir, 'stale-fact.md')), false)
    assert.equal(await readFile(join(trashDir, 'stale-fact.md'), 'utf8'), fact)

    // The index pointer was removed; the rewrite can trail the trash move.
    const index = await waitForValue(
      () => readFile(join(memoryDir, 'MEMORY.md'), 'utf8').catch(() => ''),
      (text) => !text.includes('stale-fact.md'),
    )
    assert.equal(index.includes('stale-fact.md'), false)
    assert.equal(await waitFor(() => existsSync(join(memoryDir, 'MEMORY.md.prev'))), true)
    assert.match(await readFile(join(memoryDir, 'MEMORY.md.prev'), 'utf8'), /\[Stale\]/)
    ctxRef.disposeAll()

    // A fresh session rebuilds the manifest from the memory root only: the trash
    // directory is never listed as a fact source.
    const agent2 = createFakeAgent('sess_after_forget', workspace)
    const services2 = {
      systemPrompt: { section: (section) => { ctxRef2.sections.push(section); return () => {} } },
      agents: { list: () => [agent2] },
      sessions: { list: () => [agent2.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
    }
    const ctxRef2 = createFakeCtx(services2)
    apply(ctxRef2, {  })
    const section2 = () => ctxRef2.sections[0].text({ agent: agent2 })
    assert.equal(await waitFor(() => section2().includes('# Memory')), true)
    assert.equal(section2().includes('stale-fact.md'), false)
    ctxRef2.disposeAll()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a failed fact write aborts the batch before the index or the forgets move', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-a4-write-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    // Real disk on purpose: the assertions look at files the trash move would
    // have touched, so both fs-seam and node-fs halves must be observable.
    const fs = createRealFs()
    const memoryDir = globalDir
    const fact = (name, description) => '---\nname: ' + name + '\ndescription: ' + description
      + '\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n'
    const originalIndex = '- [Stale](a4-stale-fact.md) \u2014 outdated\n'
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), originalIndex, 'utf8')
    await writeFile(join(memoryDir, 'a4-stale-fact.md'), fact('a4-stale-fact', 'outdated'), 'utf8')
    const agent = createFakeAgent('sess_a4_write', workspace)
    const calls = { llm: [] }
    const services = {
      systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          const reply = '{"memories":['
            + '{"name":"a4-first-fact","title":"First","type":"user","description":"First fact","body":"First body."},'
            + '{"name":"a4-second-fact","title":"Second","type":"user","description":"Second fact","body":"Second body."}'
            + '],"forget":["a4-stale-fact"]}'
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const ctxRef = createFakeCtx(services)
    const originalWriteText = fs.writeText
    fs.writeText = async (target, content, intent, signal, policy) => {
      if (target.displayPath === join(globalDir, 'a4-second-fact.md')) {
        throw Object.assign(new Error('a4 injected write failure'), { code: 'EACCES' })
      }
      return originalWriteText(target, content, intent, signal, policy)
    }

    apply(ctxRef, {  })
    const emit = (name, ...args) => {
      for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please remember these two facts' }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    // The first fact landed; once it exists the abort has already settled,
    // because the abort path is synchronous from the failed write onward.
    assert.equal(await waitFor(() => existsSync(join(memoryDir, 'a4-first-fact.md'))), true)

    // The aborted batch still changed the workspace (the orphan fact is on
    // disk), so the post-extraction section refresh (roadmap C6) runs and its
    // built-in repair links the orphan into the index — the documented
    // self-heal, not a batch stage. Wait for that to settle before judging
    // the batch's own traces.
    assert.equal(await waitFor(async () => {
      try {
        return (await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')).includes('a4-first-fact.md')
      } catch (_error) {
        return false
      }
    }), true)
    await new Promise((done) => setTimeout(done, 50))

    // The second fact never landed.
    assert.equal(existsSync(join(memoryDir, 'a4-second-fact.md')), false)

    // The batch aborted: the forget never ran (stale fact and its pointer
    // intact, no trash), and the index only ever gained the orphan's pointer
    // through the self-heal — never the aborted second fact.
    const index = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
    assert.match(index, /\[Stale\]/)
    assert.match(index, /\[A4 First Fact\]\(a4-first-fact\.md\)/)
    assert.equal(index.includes('a4-second-fact.md'), false)
    assert.equal(existsSync(join(memoryDir, 'a4-stale-fact.md')), true)
    assert.equal(existsSync(join(memoryDir, 'trash')), false)
    // The self-heal's backup holds the pre-repair (original) index.
    assert.equal(await readFile(join(memoryDir, 'MEMORY.md.prev'), 'utf8'), originalIndex)
    assert.equal(calls.llm.length, 1)

    // The journal carries the failure reason.
    const journal = await readFile(join(tmpdir(), 'workspace-memory-host.log'), 'utf8')
    assert.match(journal, /failed to write a4-second-fact\.md/)
    assert.match(journal, /a4 injected write failure/)
    ctxRef.disposeAll()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a failed index write leaves the forgets untouched', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-a4-index-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createRealFs()
    const memoryDir = globalDir
    const fact = '---\nname: stale-fact\ndescription: outdated fact\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n'
    const originalIndex = '- [Stale](stale-fact.md) \u2014 outdated\n'
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), originalIndex, 'utf8')
    await writeFile(join(memoryDir, 'stale-fact.md'), fact, 'utf8')
    const agent = createFakeAgent('sess_a4_index', workspace)
    const calls = { llm: [] }
    const services = {
      systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          const reply = '{"memories":['
            + '{"name":"a4-keep-fact","title":"Keep","type":"user","description":"Kept fact","body":"Keep body."}'
            + '],"forget":["stale-fact"]}'
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const ctxRef = createFakeCtx(services)
    const originalWriteText = fs.writeText
    fs.writeText = async (target, content, intent, signal, policy) => {
      // Only the index write fails; the MEMORY.md.prev backup must go through.
      if (target.displayPath === join(globalDir, 'MEMORY.md')) {
        throw Object.assign(new Error('a4 injected index failure'), { code: 'EACCES' })
      }
      return originalWriteText(target, content, intent, signal, policy)
    }

    apply(ctxRef, {  })
    const emit = (name, ...args) => {
      for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please remember one more fact' }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    // The fact write (stage 1) and the index backup both happened.
    assert.equal(await waitFor(() => existsSync(join(memoryDir, 'a4-keep-fact.md'))), true)
    await new Promise((done) => setTimeout(done, 80))

    // The index swap failed, so the deletes never ran: the stale fact and its
    // pointer are both still in place, and no trash directory appeared.
    assert.equal(await readFile(join(memoryDir, 'MEMORY.md'), 'utf8'), originalIndex)
    assert.equal(existsSync(join(memoryDir, 'stale-fact.md')), true)
    assert.equal(existsSync(join(memoryDir, 'trash')), false)
    assert.equal(await readFile(join(memoryDir, 'MEMORY.md.prev'), 'utf8'), originalIndex)
    assert.equal(calls.llm.length, 1)

    const journal = await readFile(join(tmpdir(), 'workspace-memory-host.log'), 'utf8')
    assert.match(journal, /failed to update MEMORY\.md/)
    assert.match(journal, /a4 injected index failure/)
    ctxRef.disposeAll()
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

test('a subagent session gets a read-only index section and never extracts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-subagent-'))
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const fact = '---\nname: alpha\ndescription: first fact\nmetadata:\n  node_type: memory\n  type: user\n---\nbody\n'
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Alpha](alpha.md) ' + '\u2014' + ' first fact\n')
    fs.files.set(join(memoryDir, 'alpha.md'), fact)
    const agent = createFakeAgent('sess_subagent', workspace)
    agent.session.header.origin = 'subagent'
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

    // The index is read and injected: the section contains the pointer line.
    const section = ctxRef.sections[0]
    const text = section.text({ agent })
    assert.equal(text.includes('MEMORY.md'), true)
    assert.equal(text.includes('Alpha'), true)
    assert.equal(text.includes('first fact'), true)

    // Read-only memory creates no directory of its own and writes nothing.
    assert.deepEqual(fs.writes, [])

    // A completed turn with user prose triggers no extraction...
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

    // ...and a memory-root write via tools/result stays inert too.
    emit('tools/result', {
      agent,
      tool: 'write',
      arguments: { path: join(memoryDir, 'MEMORY.md'), content: 'hijack' },
      result: { text: 'ok' },
    })
    await new Promise((done) => setTimeout(done, 80))
    assert.equal(calls.llm.length, 0)
    assert.equal(fs.files.get(join(memoryDir, 'MEMORY.md')), '- [Alpha](alpha.md) ' + '\u2014' + ' first fact\n')
    assert.deepEqual(fs.writes, [])
    ctxRef.disposeAll()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- extraction budget */

/** Minimal wiring shared by the budget tests: one workspace, one fake LLM. */
function createBudgetHarness(config) {
  const fs = createFakeFs()
  const agent = createFakeAgent('sess_budget', WS)
  const calls = { llm: [] }
  const services = {
    systemPrompt: { section: () => () => {} },
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
    workspaceRegistry: { list: () => [{ id: 'w1', path: WS, title: 'demo' }] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WS }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    llm: {
      stream: (options) => {
        calls.llm.push(options)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '{"memories":[{"name":"turn-fact","title":"Turn fact",' }
          yield { type: 'text-delta', index: 0, text: '"type":"user","description":"One per turn","body":"Fact."}],"forget":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const ctxRef = createFakeCtx(services)
  apply(ctxRef, config)
  return { fs, agent, calls, ctxRef }
}

/** Drive one completed turn with real user prose through the fake context. */
function emitBudgetTurn(ctxRef, agent, turn) {
  const emit = (name, ...args) => {
    for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
  }
  emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
  emit('session/event', agent.session, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `remember fact ${turn}` }] },
  })
  emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
  })
  emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

test('a reached daily limit skips the extraction and logs the skip', async () => {
  // debugLog is on so the debug-gated skip line is observable in the journal.
  const { fs, agent, calls, ctxRef } = createBudgetHarness({ extractDailyLimit: 1, debugLog: true })
  try {
    // Turn 1 consumes the budget of the day: the extraction runs.
    emitBudgetTurn(ctxRef, agent, 1)
    assert.equal(await waitFor(() => fs.writes.some((write) => write.path.endsWith('turn-fact.md'))), true)
    assert.equal(calls.llm.length, 1)
    assert.equal(workspaceBudgetOf(normalizePathKey(memoryRoot(WS))).count, 1)

    // Turn 2 exceeds the daily limit: no model call, no additional write,
    // and the skip lands in the journal.
    emitBudgetTurn(ctxRef, agent, 2)
    await new Promise((done) => setTimeout(done, 80))
    assert.equal(calls.llm.length, 1)
    assert.equal(fs.writes.filter((write) => write.path.endsWith('turn-fact.md')).length, 1)
    const journal = await readFile(join(tmpdir(), 'workspace-memory-host.log'), 'utf8')
    assert.match(journal, /extraction skipped for sess_budget \(daily limit reached: 1\/1 today\)/)
  } finally {
    ctxRef.disposeAll()
  }
})

test('a too-recent min interval skips, then a later turn extracts again', async () => {
  // debugLog is on so the debug-gated skip line is observable in the journal.
  const { fs, agent, calls, ctxRef } = createBudgetHarness({ extractMinIntervalMs: 60_000, debugLog: true })
  const budgetKey = normalizePathKey(memoryRoot(WS))
  try {
    emitBudgetTurn(ctxRef, agent, 1)
    assert.equal(await waitFor(() => fs.writes.some((write) => write.path.endsWith('turn-fact.md'))), true)
    assert.equal(calls.llm.length, 1)

    // Turn 2 fires within the 60s window: skipped and logged.
    emitBudgetTurn(ctxRef, agent, 2)
    await new Promise((done) => setTimeout(done, 80))
    assert.equal(calls.llm.length, 1)
    const journal = await readFile(join(tmpdir(), 'workspace-memory-host.log'), 'utf8')
    assert.match(journal, /extraction skipped for sess_budget \(min interval not elapsed: \d+ms < 60000ms\)/)

    // Rewind the recorded time so the next turn passes the gate again.
    workspaceBudgetOf(budgetKey).lastAtMs -= 120_000
    emitBudgetTurn(ctxRef, agent, 3)
    assert.equal(await waitFor(() => fs.writes.filter((write) => write.path.endsWith('turn-fact.md')).length === 2), true)
    assert.equal(calls.llm.length, 2)
  } finally {
    ctxRef.disposeAll()
  }
})

test('catalog reports per-workspace todayCount and lastAt', async () => {
  const { fs, agent, ctxRef } = createBudgetHarness({  })
  try {
    // v2.1: memory is workspace-only, so the fact and the budget counter share
    // one root. Give the row a seed file so the catalog still lists it.
    fs.files.set(join(WS, '.dsh', 'memory', 'MEMORY.md'), '- [Seed](seed.md) — seeded\n')
    emitBudgetTurn(ctxRef, agent, 1)
    await new Promise((done) => setTimeout(done, 80))
    const budget = workspaceBudgetOf(normalizePathKey(memoryRoot(WS)))
    assert.equal(budget.count, 1)
    assert.equal(typeof budget.lastAtMs, 'number')

    // The catalog RPC exposes the counters of the workspace.
    const route = ctxRef.rpcRoutes[0]
    const request = new Request('http://localhost/api/dsh-workspace-memory/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rpcId: 'r9',
        type: 'client-request',
        method: 'dsh-workspace-memory/call',
        payload: { endpoint: 'catalog', payload: {} },
      }),
    })
    const catalog = await (await route.fetch(request)).json()
    assert.equal(catalog.result.ok, true)
    const row = catalog.result.value.workspaces.find((entry) => entry.path === WS)
    assert.notEqual(row, undefined)
    assert.equal(row.todayCount, 1)
    assert.equal(row.lastAt, budget.lastAtMs)
  } finally {
    ctxRef.disposeAll()
  }
})

/* ------------------------------------------------------------- session state */

/**
 * Minimal wiring for the C2 session-level incognito toggle: one workspace,
 * one fake LLM, and the RPC route, mirroring `createBudgetHarness`.
 */
function createSessionStateHarness() {
  const fs = createFakeFs()
  const agent = createFakeAgent('sess_incognito', WS)
  const calls = { llm: [] }
  const services = {
    systemPrompt: { section: () => () => {} },
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
    workspaceRegistry: { list: () => [{ id: 'w1', path: WS, title: 'demo' }] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WS }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    llm: {
      stream: (options) => {
        calls.llm.push(options)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '{"memories":[{"name":"incognito-fact","title":"Incognito fact",' }
          yield { type: 'text-delta', index: 0, text: '"type":"user","description":"After resuming","body":"Fact."}],"forget":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const ctxRef = createFakeCtx(services)
  apply(ctxRef, {})
  return { fs, agent, calls, ctxRef }
}

/** Drive one completed turn with real user prose through the fake context. */
function emitIncognitoTurn(ctxRef, agent, turn) {
  const emit = (name, ...args) => {
    for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
  }
  emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
  emit('session/event', agent.session, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `please remember prose ${turn}` }] },
  })
  emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
  })
  emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

/** One `session-state` RPC call through the registered route. */
async function callSessionState(ctxRef, payload, rpcId) {
  const request = new Request('http://localhost/api/dsh-workspace-memory/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rpcId,
      type: 'client-request',
      method: 'dsh-workspace-memory/call',
      payload: { endpoint: 'session-state', payload },
    }),
  })
  return (await ctxRef.rpcRoutes[0].fetch(request)).json()
}

test('session-state endpoint reads and sets the per-session skip toggle', async () => {
  const { ctxRef } = createSessionStateHarness()
  try {
    // The host tracks the session by id, so the panel can read its state.
    const initial = await callSessionState(ctxRef, { sessionId: 'sess_incognito' }, 's1')
    assert.equal(initial.result.ok, true)
    assert.deepEqual(initial.result.value, { sessionId: 'sess_incognito', skipTurnExtraction: false })

    // Setting the flag flips it and is reported back on the same answer.
    const set = await callSessionState(ctxRef, { sessionId: 'sess_incognito', skipTurnExtraction: true }, 's2')
    assert.deepEqual(set.result.value, { sessionId: 'sess_incognito', skipTurnExtraction: true })
    const readBack = await callSessionState(ctxRef, { sessionId: 'sess_incognito' }, 's3')
    assert.deepEqual(readBack.result.value, { sessionId: 'sess_incognito', skipTurnExtraction: true })

    // A forged sessionId resolves to no record: the answer is empty state,
    // and it must not create one.
    const forged = await callSessionState(ctxRef, { sessionId: 'sess_forged', skipTurnExtraction: true }, 's4')
    assert.deepEqual(forged.result.value, { sessionId: null, skipTurnExtraction: false })
    const forgedRead = await callSessionState(ctxRef, { sessionId: 'sess_forged' }, 's5')
    assert.deepEqual(forgedRead.result.value, { sessionId: null, skipTurnExtraction: false })

    // The catalog carries the flag for the source session (panel sync).
    const route = ctxRef.rpcRoutes[0]
    const catalogRequest = new Request('http://localhost/api/dsh-workspace-memory/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rpcId: 's6',
        type: 'client-request',
        method: 'dsh-workspace-memory/call',
        payload: { endpoint: 'catalog', payload: { sessionId: 'sess_incognito' } },
      }),
    })
    const catalog = await (await route.fetch(catalogRequest)).json()
    assert.equal(catalog.result.ok, true)
    assert.deepEqual(catalog.result.value.session, { sessionId: 'sess_incognito', skipTurnExtraction: true })
    const anonymous = await callSessionState(ctxRef, {}, 's7')
    assert.deepEqual(anonymous.result.value, { sessionId: null, skipTurnExtraction: false })
  } finally {
    ctxRef.disposeAll()
  }
})

test('the incognito toggle skips a prose turn with zero LLM calls and no budget', async () => {
  const { fs, agent, calls, ctxRef } = createSessionStateHarness()
  const budgetKey = normalizePathKey(memoryRoot(WS))
  try {
    // Toggle on before the turn: the completed prose turn must stay silent.
    const set = await callSessionState(ctxRef, { sessionId: 'sess_incognito', skipTurnExtraction: true }, 'i1')
    assert.equal(set.result.ok, true)

    emitIncognitoTurn(ctxRef, agent, 1)
    await new Promise((done) => setTimeout(done, 80))

    // Acceptance: zero LLM calls, nothing written, no budget consumed.
    assert.equal(calls.llm.length, 0)
    assert.deepEqual(fs.writes, [])
    assert.equal(workspaceBudgetOf(budgetKey), undefined)

    // Toggle off: extraction resumes on the next completed prose turn.
    const unset = await callSessionState(ctxRef, { sessionId: 'sess_incognito', skipTurnExtraction: false }, 'i2')
    assert.deepEqual(unset.result.value, { sessionId: 'sess_incognito', skipTurnExtraction: false })
    emitIncognitoTurn(ctxRef, agent, 2)
    assert.equal(await waitFor(() => fs.writes.some((write) => write.path.endsWith('incognito-fact.md'))), true)
    assert.equal(calls.llm.length, 1)
    assert.equal(calls.llm[0].sessionId, 'sess_incognito')
    assert.equal(workspaceBudgetOf(budgetKey).count, 1)
  } finally {
    ctxRef.disposeAll()
  }
})

/* ---------------------------------------------------------------- activities */

test('recordActivity keeps a newest-first ring of at most ACTIVITY_KEEP entries', () => {
  resetWorkspaceActivities()
  try {
    const record = { root: WS, memoryRoot: memoryRoot(WS), sessionId: 'sess_ring' }
    const first = recordActivity(record, { wrote: ['a-first.md'], forgot: ['gone.md'], diffSummary: '+1 -1', indexBefore: '# before', indexAfter: '# after' })
    assert.equal(first.at > 0, true)
    assert.equal(first.workspace, WS)
    assert.deepEqual(first.wrote, ['a-first.md'])
    assert.deepEqual(first.forgot, ['gone.md'])
    assert.equal(first.indexBefore, '# before')
    assert.equal(first.indexAfter, '# after')

    // Missing fields fall back to safe defaults instead of poisoning the feed.
    recordActivity(record, {})
    const feed = workspaceActivitiesOf(normalizePathKey(memoryRoot(WS)))
    assert.equal(feed.length, 2)
    assert.deepEqual(feed[0].wrote, [])
    assert.equal(feed[0].diffSummary, '(no index change)')
    assert.equal(feed[0].indexBefore, '')
    assert.deepEqual(feed[1].wrote, ['a-first.md'])

    // The ring keeps only the newest ACTIVITY_KEEP entries, newest first.
    for (let at = 0; at < ACTIVITY_KEEP + 5; at += 1) {
      recordActivity(record, { wrote: [`fact-${at}.md`] })
    }
    const ring = workspaceActivitiesOf(normalizePathKey(memoryRoot(WS)))
    assert.equal(ring.length, ACTIVITY_KEEP)
    assert.deepEqual(ring[0].wrote, [`fact-${ACTIVITY_KEEP + 4}.md`])
    // The two seed entries aged out first, shifting the window to fact-5.
    assert.deepEqual(ring[ring.length - 1].wrote, ['fact-5.md'])

    // Entries live per workspace and never leak across memory roots.
    const other = { root: 'D:\\work\\other', memoryRoot: memoryRoot('D:\\work\\other'), sessionId: 'sess_ring' }
    recordActivity(other, { wrote: ['other-fact.md'] })
    assert.equal(workspaceActivitiesOf(normalizePathKey(memoryRoot(WS))).length, ACTIVITY_KEEP)
    assert.deepEqual(workspaceActivitiesOf(normalizePathKey(memoryRoot('D:\\work\\other')))[0].wrote, ['other-fact.md'])
  } finally {
    resetWorkspaceActivities()
  }
})

/* ------------------------------------------------------------- D4 conflict */

test('extraction re-asks once with body excerpts when the reply near-matches existing files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let ctxRef
  try {
    const fs = createFakeFs()
    const agent = createFakeAgent('sess_conflict', workspace)
    const calls = { llm: [] }
    // First reply invents the near-duplicate name `prefer-tabs`; after the
    // conflict re-ask the model corrects itself to the existing
    // `prefers-tabs` and forgets nothing.
    const firstReply = '{"memories":[{"name":"prefer-tabs","title":"Prefers tabs","type":"user","description":"Prefers tabs over spaces","body":"Uses tabs everywhere."}],"forget":[]}'
    const secondReply = '{"memories":[{"name":"prefers-tabs","title":"Prefers tabs","type":"user","description":"Prefers tabs over spaces","body":"Uses tabs everywhere, including editors."}],"forget":[]}'
    const services = {
      systemPrompt: { section: () => () => {} },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      workspaceRegistry: { list: () => [{ id: 'w1', path: workspace, title: 'demo' }] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          const reply = calls.llm.length === 1 ? firstReply : secondReply
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    ctxRef = createFakeCtx(services)
    apply(ctxRef, {  })

    const memoryDir = join(workspace, '.dsh', 'memory')
    // The plugin initializes lazily on the first turn event; seed the fake fs directly.
    // Seed an existing workspace-layer fact that the first reply near-matches.
    const seededFact = [
      '---',
      'name: prefers-tabs',
      'description: Prefers tabs over spaces',
      'metadata:',
      '  node_type: memory',
      '  type: user',
      '  originSessionId: sess_seed',
      '  createdAt: 2026-01-01T00:00:00.000Z',
      '  updatedAt: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'Uses tabs everywhere. Seed body that the excerpt must surface.',
      '',
    ].join('\n')
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n')
    fs.files.set(join(memoryDir, 'prefers-tabs.md'), seededFact)

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

    assert.equal(await waitFor(() => calls.llm.length >= 2, 3000), true)
    await waitFor(() => fs.writes.some((write) => write.path.endsWith('prefers-tabs.md')), 3000)

    // Exactly one re-ask: two calls total.
    assert.equal(calls.llm.length, 2)
    // The second prompt carries the conflict block with the seeded body excerpt.
    const rePrompt = calls.llm[1].messages[0].content[0].text
    assert.match(rePrompt, /## Conflicting existing files/)
    assert.match(rePrompt, /- prefers-tabs \(your reply used: prefer-tabs\): Uses tabs everywhere\. Seed body/)
    assert.match(rePrompt, /update that existing file in place/)
    // The first prompt stayed conflict-free (Phase-1 prompt is unchanged).
    assert.equal(calls.llm[0].messages[0].content[0].text.includes('## Conflicting existing files'), false)
    // The corrected plan updated the existing file in place; no near-duplicate
    // file was created.
    assert.equal(fs.files.has(join(memoryDir, 'prefer-tabs.md')), false)
    const fact = fs.files.get(join(memoryDir, 'prefers-tabs.md'))
    assert.match(fact, /Uses tabs everywhere, including editors\./)
    // Update in place keeps the file's original provenance (D2 contract):
    assert.match(fact, /originSessionId: sess_seed/)
  } finally {
    ctxRef.disposeAll()
  }
})

test('extraction keeps the first plan when the conflict re-ask reply is unusable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let ctxRef
  try {
    const fs = createFakeFs()
    const agent = createFakeAgent('sess_fallback', workspace)
    const calls = { llm: [] }
    const firstReply = '{"memories":[{"name":"prefer-tabs","title":"Prefers tabs","type":"user","description":"Prefers tabs over spaces","body":"Uses tabs everywhere."}],"forget":[]}'
    const services = {
      systemPrompt: { section: () => () => {} },
      agents: { list: () => [agent] },
      sessions: { list: () => [agent.session] },
      workspaceRegistry: { list: () => [{ id: 'w1', path: workspace, title: 'demo' }] },
      fs,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      llm: {
        stream: (options) => {
          calls.llm.push(options)
          const reply = calls.llm.length === 1
            ? firstReply
            : 'model meltdown, no json here'
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    ctxRef = createFakeCtx(services)
    apply(ctxRef, {  })

    const memoryDir = join(workspace, '.dsh', 'memory')
    // The plugin initializes lazily on the first turn event; seed the fake fs directly.
    const seededFact = [
      '---',
      'name: prefers-tabs',
      'description: Prefers tabs over spaces',
      'metadata:',
      '  node_type: memory',
      '  type: user',
      '  createdAt: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'Seed body.',
      '',
    ].join('\n')
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n')
    fs.files.set(join(memoryDir, 'prefers-tabs.md'), seededFact)

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

    assert.equal(await waitFor(() => calls.llm.length >= 2, 3000), true)
    await waitFor(() => fs.writes.some((write) => write.path.endsWith('prefer-tabs.md')), 3000)
    assert.equal(calls.llm.length, 2)
    // The fallback plan still applied under the original near-duplicate name.
    assert.match(fs.files.get(join(memoryDir, 'prefer-tabs.md')), /Uses tabs everywhere\./)
  } finally {
    ctxRef.disposeAll()
  }
})

test('extraction with no near-duplicates still costs exactly one call', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-test-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  let ctxRef
  try {
    const fs = createFakeFs()
    const agent = createFakeAgent('sess_clean', workspace)
    const calls = { llm: [] }
    const services = {
      systemPrompt: { section: () => () => {} },
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
            yield { type: 'text-delta', index: 0, text: '{"memories":[{"name":"likes-oled","title":"Likes OLED","type":"user","description":"OLED screens","body":"Prefers OLED panels."}],"forget":[]}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    ctxRef = createFakeCtx(services)
    apply(ctxRef, {  })

    const memoryDir = join(workspace, '.dsh', 'memory')
    // The plugin initializes lazily on the first turn event; seed the fake fs directly.
    fs.files.set(join(memoryDir, 'MEMORY.md'), '- [Prefers tabs](prefers-tabs.md) — Uses tabs\n')
    fs.files.set(join(memoryDir, 'prefers-tabs.md'), [
      '---',
      'name: prefers-tabs',
      'description: Prefers tabs over spaces',
      'metadata:',
      '  node_type: memory',
      '  type: user',
      '  createdAt: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'Seed body.',
      '',
    ].join('\n'))

    const emit = (name, ...args) => {
      for (const registered of ctxRef.handlers.get(name) ?? []) registered(...args)
    }
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please remember that I like OLED screens' }] },
    })
    emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    assert.equal(await waitFor(() => fs.writes.some((write) => write.path.endsWith('likes-oled.md')), 3000), true)
    assert.equal(calls.llm.length, 1)
    assert.equal(calls.llm[0].messages[0].content[0].text.includes('## Conflicting existing files'), false)
  } finally {
    ctxRef.disposeAll()
  }
})
