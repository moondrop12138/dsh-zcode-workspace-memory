/**
 * Roadmap D5/D6 integration tests: the extraction route override and the
 * segmented extraction of an oversized turn.
 *
 * These drive the real `apply()` through a minimal fake Cordis context, like
 * the integration cases in `extraction.test.mjs`, but keep their own scripted
 * `ctx.llm` so each background call can answer with a different plan.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, __internals } from '../lib/host.js'
import { MAX_TRANSCRIPT_CHARS, memoryRoot } from '../lib/memory-core.js'

const { normalizePathKey, workspaceBudgetOf } = __internals

test('extraction routes through the configured extractProvider/extractModel when set', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-route-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  const harness = createScriptedHarness({
    workspace,
    globalMemoryRoot: globalDir,
    config: { extractProvider: 'configured-provider', extractModel: 'configured-model' },
    replies: [REPLY_LIKES_OLED],
  })
  try {
    emitTurn(harness, 1, ['please remember that I like OLED screens'])
    assert.equal(await waitFor(() => harness.calls.llm.length >= 1 && harness.fs.writes.length > 0), true)
    // The configured route wins over the session's ctx-provider/ctx-model.
    assert.equal(harness.calls.llm[0].provider, 'configured-provider')
    assert.equal(harness.calls.llm[0].model, 'configured-model')
  } finally {
    harness.ctxRef.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('an empty extraction route keeps the session route', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-route-default-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  const harness = createScriptedHarness({
    workspace,
    globalMemoryRoot: globalDir,
    // The schema defaults are empty strings: fall back to the session route.
    config: { extractProvider: '', extractModel: '' },
    replies: [REPLY_LIKES_OLED],
  })
  try {
    emitTurn(harness, 1, ['please remember that I like OLED screens'])
    assert.equal(await waitFor(() => harness.calls.llm.length >= 1 && harness.fs.writes.length > 0), true)
    assert.equal(harness.calls.llm[0].provider, 'ctx-provider')
    assert.equal(harness.calls.llm[0].model, 'ctx-model')
  } finally {
    harness.ctxRef.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('an oversized turn extracts in 2-3 segments, merges them, and writes once', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-seg-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  const harness = createScriptedHarness({
    workspace,
    globalMemoryRoot: globalDir,
    replies: [REPLY_SEG_FIRST, REPLY_SEG_LAST, REPLY_SEG_THIRD],
  })
  try {
    // ~30k chars of user prose across five messages, so the splitter cuts on
    // message boundaries. The mark tags prove both ends reach the model.
    const chunk = 'x'.repeat(6000)
    const texts = [
      `SEGMENT-MARK-A ${chunk} remember these details`,
      `${chunk} note one`,
      `${chunk} note two`,
      `${chunk} note three`,
      `${chunk} SEGMENT-MARK-Z`,
    ]
    emitTurn(harness, 1, texts)

    assert.equal(await waitFor(() => harness.fs.writes.some((write) => write.path.endsWith('seg-last.md')), 5000), true)
    // One model call per segment, never one per message: 2-3 calls.
    assert.ok(harness.calls.llm.length >= 2, `expected segments, got ${harness.calls.llm.length} call(s)`)
    assert.ok(harness.calls.llm.length <= 3, `expected at most 3 segments, got ${harness.calls.llm.length}`)
    const prompts = harness.calls.llm.map((call) => call.messages[0].content[0].text)
    assert.ok(prompts.some((prompt) => prompt.includes('SEGMENT-MARK-A')), 'the oldest content reaches a segment')
    assert.ok(prompts.at(-1).includes('SEGMENT-MARK-Z'), 'the newest content reaches the last segment')
    assert.ok(prompts.every((prompt) => prompt.length <= MAX_TRANSCRIPT_CHARS + 20000), 'each segment stays one prompt')

    // Both segment plans landed through ONE guarded write pass: the index was
    // written once and holds both facts.
    const memoryDir = join(workspace, '.dsh', 'memory')
    assert.equal(harness.fs.writes.filter((write) => write.path.endsWith('MEMORY.md')).length, 1)
    assert.equal(harness.fs.files.has(join(memoryDir, 'seg-first.md')), true)
    assert.equal(harness.fs.files.has(join(memoryDir, 'seg-last.md')), true)
    const index = harness.fs.files.get(join(memoryDir, 'MEMORY.md'))
    assert.match(index, /seg-first\.md/)
    assert.match(index, /seg-last\.md/)

    // A segmented turn counts as exactly ONE extraction for the budget.
    assert.equal(workspaceBudgetOf(normalizePathKey(memoryRoot(workspace))).count, 1)
  } finally {
    harness.ctxRef.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('a segmented turn consumes one budget unit even under a daily limit of one', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-seg-budget-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  const harness = createScriptedHarness({
    workspace,
    globalMemoryRoot: globalDir,
    config: { extractDailyLimit: 1 },
    replies: [REPLY_SEG_FIRST, REPLY_SEG_LAST],
  })
  try {
    const chunk = 'x'.repeat(13000)
    emitTurn(harness, 1, [`${chunk} first half of a long turn`, `${chunk} second half of a long turn`])
    assert.equal(await waitFor(() => harness.fs.writes.some((write) => write.path.endsWith('MEMORY.md')), 5000), true)
    const callsAfterFirstTurn = harness.calls.llm.length
    assert.ok(callsAfterFirstTurn >= 2, `expected a segmented first turn, got ${callsAfterFirstTurn} call(s)`)
    assert.equal(workspaceBudgetOf(normalizePathKey(memoryRoot(workspace))).count, 1)

    // The second (short) turn is refused: one segmented turn already used the
    // whole daily budget, so no extra model call happens.
    emitTurn(harness, 2, ['remember one more short fact'])
    await new Promise((done) => setTimeout(done, 120))
    assert.equal(harness.calls.llm.length, callsAfterFirstTurn)
  } finally {
    harness.ctxRef.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('a short multi-message turn still costs exactly one call and one write pass', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-short-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  const harness = createScriptedHarness({
    workspace,
    globalMemoryRoot: globalDir,
    replies: [REPLY_LIKES_OLED],
  })
  try {
    emitTurn(harness, 1, [
      'remember that I like OLED screens',
      'and that I always take notes in the terminal',
      'that is all for today',
    ])
    assert.equal(await waitFor(() => harness.fs.writes.some((write) => write.path.endsWith('likes-oled.md')), 5000), true)
    assert.equal(harness.calls.llm.length, 1)
    assert.equal(harness.fs.writes.filter((write) => write.path.endsWith('MEMORY.md')).length, 1)
    assert.equal(harness.calls.llm[0].messages[0].content[0].text.includes('## Conversation'), true)
  } finally {
    harness.ctxRef.disposeAll()
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ helpers */

const REPLY_LIKES_OLED = '{"memories":[{"name":"likes-oled","title":"Likes OLED","type":"user","description":"OLED screens","body":"Prefers OLED panels."}],"forget":[]}'
const REPLY_SEG_FIRST = '{"memories":[{"name":"seg-first","title":"First segment","type":"project","description":"Fact from the first segment","body":"From the first segment."}],"forget":[]}'
const REPLY_SEG_LAST = '{"memories":[{"name":"seg-last","title":"Last segment","type":"project","description":"Fact from the last segment","body":"From the last segment."}],"forget":[]}'
const REPLY_SEG_THIRD = '{"memories":[{"name":"seg-third","title":"Third segment","type":"project","description":"Fact from a third segment","body":"From a third segment."}],"forget":[]}'

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

/** A plugin harness whose `ctx.llm` answers call N with `replies[N]`. */
function createScriptedHarness(options) {
  const workspace = options.workspace
  const fs = createFakeFs()
  const agent = {
    id: 'sess_scripted',
    options: { provider: 'agent-provider', model: 'agent-model' },
    session: {
      id: 'sess_scripted',
      header: { cwd: workspace },
      requestContext: () => ({ provider: 'ctx-provider', model: 'ctx-model' }),
      requestHeader: () => ({ config: { provider: 'header-provider', model: 'header-model' } }),
    },
    ctx: {},
  }
  const calls = { llm: [] }
  const replies = Array.isArray(options.replies) ? options.replies : []
  const services = {
    systemPrompt: { section: () => () => {} },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    workspaceRegistry: { list: () => [{ id: 'w1', path: workspace, title: 'demo' }] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    llm: {
      stream: (llmOptions) => {
        calls.llm.push(llmOptions)
        const reply = replies[Math.min(calls.llm.length - 1, replies.length - 1)] ?? ''
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const handlers = new Map()
  const disposers = []
  const ctxRef = {
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
  apply(ctxRef, { globalMemoryRoot: options.globalMemoryRoot, ...(options.config ?? {}) })
  return { fs, agent, calls, ctxRef }
}

/** Drive one completed turn whose user prose arrives as successive messages. */
function emitTurn(harness, turn, texts) {
  const emit = (name, ...args) => {
    for (const registered of harness.ctxRef.handlers.get(name) ?? []) registered(...args)
  }
  emit('session/event', harness.agent.session, { type: 'turn/start', data: { turn } })
  for (const text of texts) {
    emit('session/event', harness.agent.session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    })
    emit('session/event', harness.agent.session, {
      type: 'assistant/message',
      data: { turn, step: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } },
    })
  }
  emit('session/event', harness.agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
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
