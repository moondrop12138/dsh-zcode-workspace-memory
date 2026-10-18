/**
 * Lead-run end-to-end check of the Host half (independent of `test/extraction.test.mjs`).
 *
 * Drives the real `apply()` with a minimal fake Cordis context and a node-backed
 * filesystem shim, then asserts the observable acceptance facts:
 *
 *   1. `systemPrompt.section` is registered with the frozen name/order and a
 *      synchronous provider that returns the `# Memory` rules for a live Agent.
 *   2. A completed turn with eligible user prose and a stubbed model reply writes
 *      the fact file and the `MEMORY.md` pointer into `<workspace>/.dsh/memory/`,
 *      with `originSessionId` stamped from the session.
 *   3. A turn that already wrote into the memory root skips extraction entirely.
 *   4. A read-only session creates no directory and runs no extraction.
 *   5. A subagent-origin session is never initialized.
 *
 * Usage: node scripts/verify-host-e2e.mjs
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const { apply } = await import('../lib/host.js')

const MEMORY_ROOT_SUFFIX = join('.dsh', 'memory')

/** Node-backed `ctx.fs` shim: reads unconfined, writes fenced by the policy arg. */
function createFs() {
  const resolve = async (path) => ({ path: String(path) })
  return {
    resolve,
    contains(parent, child) {
      const a = String(parent?.path ?? '')
      const b = String(child?.path ?? '')
      return b === a || b.startsWith(a.endsWith('\\') || a.endsWith('/') ? a : a + (a.includes('\\') ? '\\' : '/'))
    },
    async stat(target) {
      try {
        const info = await stat(target.path)
        return { type: info.isDirectory() ? 'dir' : 'file', size: info.size, mtimeMs: info.mtimeMs }
      } catch (_error) {
        return undefined
      }
    },
    async readText(target) {
      const text = await readFile(target.path, 'utf8')
      return text
    },
    async listDir(target) {
      const entries = await readdir(target.path, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }))
    },
    async writeText(target, content, _intent, _signal, policy) {
      if (policy && policy.mode === 'read-only') {
        const error = new Error('FS_SANDBOX_DENIED')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      await mkdir(join(target.path, '..'), { recursive: true }).catch(() => {})
      await writeFile(target.path, content, 'utf8')
      return { operation: 'create', after: content }
    },
  }
}

/**
 * Build a fake context, one fake Agent, and the captured registrations.
 * @param {{ mode?: string, origin?: string, reply?: string }} [options]
 */
function createHarness(options = {}) {
  const mode = options.mode ?? 'workspace-write'
  const handlers = new Map()
  const sections = []
  const llmCalls = []
  const workspace = join(tmpdir(), 'wm-e2e-placeholder')
  const sessionId = 'session-e2e-0001'
  const agent = {
    options: { provider: 'fake-provider', model: 'fake-model' },
    session: {
      id: sessionId,
      header: { cwd: workspace, ...(options.origin ? { origin: options.origin } : {}) },
      requestContext: () => ({ provider: 'fake-provider', model: 'fake-model' }),
      requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
    },
  }
  const fs = createFs()
  const services = {
    fs,
    systemPrompt: { section: (definition) => { sections.push(definition); return () => {} } },
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    workspaceRegistry: { list: () => [{ path: workspace, title: 'e2e' }] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
    llm: {
      stream(request) {
        llmCalls.push(request)
        const reply = options.reply ?? JSON.stringify({
          memories: [{
            name: 'e2e-tabs',
            title: 'E2E tabs',
            type: 'project',
            description: 'The e2e project indents with tabs',
            body: 'The e2e project indents with tabs.',
          }],
          forget: [],
        })
        return (async function* chunks() {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    inject: () => {},
  }
  return { ctx, agent, workspace, sessionId, sections, llmCalls, fs, handlers }
}

/** Fire one event at the registered listeners for `name`. */
function emit(harness, name, ...args) {
  for (const handler of harness.handlers.get(name) ?? []) handler(...args)
}

/** Poll until `predicate` is true or the deadline passes. */
async function waitFor(predicate, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

/** Real fixed delay (initialization is asynchronous). */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whether one path exists as a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch (_error) {
    return false
  }
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/* ---------------------------------------------------------------- case 1: happy path */

{
  const harness = createHarness()
  const scratch = await mkdtemp(join(tmpdir(), 'wm-e2e-'))
  harness.agent.session.header.cwd = scratch
  harness.ctx.get('sandboxPolicy').resolve = () => ({ mode: 'workspace-write', workspaceRoot: scratch })
  const memoryRoot = join(scratch, MEMORY_ROOT_SUFFIX)

  apply(harness.ctx, { enabled: true, autoExtract: true })
  await waitFor(() => isDirectory(memoryRoot), 4000)
  record('init creates the memory directory for a live agent', await isDirectory(memoryRoot), memoryRoot)
  record('section registered with the frozen identity',
    harness.sections.length === 1 && harness.sections[0].name === 'workspace-memory:instructions'
      && harness.sections[0].order === 450 && typeof harness.sections[0].text === 'function',
    harness.sections.map((section) => `${section.name}@${section.order}`).join(', '))
  const sectionText = harness.sections[0].text({ agent: harness.agent })
  record('section provider returns the # Memory rules with the absolute root',
    sectionText.startsWith('# Memory') && sectionText.includes(memoryRoot),
    `${sectionText.length} chars`)

  emit(harness, 'session/event', harness.agent.session, { type: 'turn/start', data: { turn: 1 } })
  emit(harness, 'session/event', harness.agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'remember that this project indents with tabs' }], source: { kind: 'user' } },
  })
  emit(harness, 'session/event', harness.agent.session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } },
  })
  emit(harness, 'session/event', harness.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const factPath = join(memoryRoot, 'e2e-tabs.md')
  const wrote = await waitFor(async () => {
    try {
      await stat(factPath)
      return true
    } catch (_error) {
      return false
    }
  })
  record('extraction writes the fact file', wrote, factPath)
  if (wrote) {
    const fact = await readFile(factPath, 'utf8')
    record('fact carries originSessionId + memory type',
      fact.includes(`originSessionId: ${harness.sessionId}`) && fact.includes('  type: project'),
      fact.split('\n').slice(0, 7).join(' | '))
    const index = await readFile(join(memoryRoot, 'MEMORY.md'), 'utf8')
    record('extraction maintains the MEMORY.md pointer',
      index.includes('- [E2E tabs](e2e-tabs.md) — The e2e project indents with tabs'),
      JSON.stringify(index.trim()))
  }
  record('exactly one model call was made', harness.llmCalls.length === 1, String(harness.llmCalls.length))
  record('the request carries route, system rules and the no-op contract',
    harness.llmCalls[0]?.provider === 'fake-provider'
      && typeof harness.llmCalls[0]?.system === 'string'
      && harness.llmCalls[0].system.includes('# Memory')
      && harness.llmCalls[0].messages[0].content[0].text.includes('If nothing is worth saving'),
    `${harness.llmCalls[0]?.maxTokens} maxTokens`)
  await rm(scratch, { recursive: true, force: true })
}

/* ------------------------------------------------- case 2: direct write skips extraction */

{
  const harness = createHarness()
  const scratch = await mkdtemp(join(tmpdir(), 'wm-e2e-direct-'))
  harness.agent.session.header.cwd = scratch
  harness.ctx.get('sandboxPolicy').resolve = () => ({ mode: 'workspace-write', workspaceRoot: scratch })
  apply(harness.ctx, { enabled: true, autoExtract: true })
  await delay(400)

  emit(harness, 'session/event', harness.agent.session, { type: 'turn/start', data: { turn: 2 } })
  emit(harness, 'session/event', harness.agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'please remember the release checklist' }], source: { kind: 'user' } },
  })
  emit(harness, 'tools/result', {
    name: 'write',
    agent: harness.agent,
    arguments: { file_path: join(scratch, MEMORY_ROOT_SUFFIX, 'release-checklist.md'), content: 'x' },
  })
  emit(harness, 'session/event', harness.agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await delay(600)
  record('a turn that wrote into the memory root skips extraction', harness.llmCalls.length === 0, String(harness.llmCalls.length))
  await rm(scratch, { recursive: true, force: true })
}

/* --------------------------------------------------- case 3: read-only creates nothing */

{
  const harness = createHarness({ mode: 'read-only' })
  const scratch = await mkdtemp(join(tmpdir(), 'wm-e2e-ro-'))
  harness.agent.session.header.cwd = scratch
  harness.ctx.get('sandboxPolicy').resolve = () => ({ mode: 'read-only', workspaceRoot: scratch })
  apply(harness.ctx, { enabled: true, autoExtract: true })
  await delay(400)
  const exists = await isDirectory(join(scratch, MEMORY_ROOT_SUFFIX))
  record('read-only session creates no memory directory', exists === false)

  emit(harness, 'session/event', harness.agent.session, { type: 'turn/start', data: { turn: 1 } })
  emit(harness, 'session/event', harness.agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'remember something important now' }], source: { kind: 'user' } },
  })
  emit(harness, 'session/event', harness.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await delay(600)
  record('read-only session runs no extraction', harness.llmCalls.length === 0, String(harness.llmCalls.length))
  record('read-only session still injects the rules section',
    harness.sections.length === 1
      && harness.sections[0].text({ agent: harness.agent }).startsWith('# Memory'),
    JSON.stringify(harness.sections[0]?.text({ agent: harness.agent })?.slice(0, 40) ?? ''))
  await rm(scratch, { recursive: true, force: true })
}

/* --------------------------------------------------------- case 4: subagent excluded */

{
  const harness = createHarness({ origin: 'subagent' })
  const scratch = await mkdtemp(join(tmpdir(), 'wm-e2e-sub-'))
  harness.agent.session.header.cwd = scratch
  harness.ctx.get('sandboxPolicy').resolve = () => ({ mode: 'workspace-write', workspaceRoot: scratch })
  apply(harness.ctx, { enabled: true, autoExtract: true })
  await delay(400)
  const sectionText = harness.sections[0].text({ agent: harness.agent })
  const dirExists = await isDirectory(join(scratch, MEMORY_ROOT_SUFFIX))
  record('subagent session gets no memory section and no directory',
    sectionText === '' && dirExists === false, JSON.stringify(sectionText))
  emit(harness, 'session/event', harness.agent.session, { type: 'turn/start', data: { turn: 1 } })
  emit(harness, 'session/event', harness.agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'remember something for the child' }], source: { kind: 'user' } },
  })
  emit(harness, 'session/event', harness.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await delay(600)
  record('subagent session triggers no extraction', harness.llmCalls.length === 0, String(harness.llmCalls.length))
  await rm(scratch, { recursive: true, force: true })
}

/* ------------------------------------------------------------------- verdict */

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error('failed:', failed.map((entry) => entry.name).join('; '))
  process.exit(1)
}
