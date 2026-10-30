/**
 * Roadmap D3 — relevance-ranked injection.
 *
 * The first keyword-bearing user message of a session becomes a ranking
 * query: pointer lines are reordered by lightweight keyword overlap (title
 * ×2, hook ×1, file name ×1 — zero dependencies, no embeddings) BEFORE the
 * line/character truncation applies, so an old but relevant preference
 * survives a tight cap that would have cut it at the tail. The ordering only
 * shapes the injected copy; `MEMORY.md` on disk is never rewritten.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  formatIndexContent,
  queryTermsForRanking,
  reorderIndexForQuery,
  renderMemorySection,
  scoreIndexPointer,
} from '../lib/memory-core.js'
import { apply } from '../lib/host.js'

/* ------------------------------------------------------------------ pure functions */

test('queryTermsForRanking extracts ASCII words, stems simple plurals, drops stop words', () => {
  const terms = queryTermsForRanking('Tabs vs Spaces in code review')
  for (const expected of ['tab', 'space', 'code', 'review']) {
    assert.ok(terms.includes(expected), 'missing term: ' + expected)
  }
  assert.equal(terms.includes('tabs'), false, 'plurals are stemmed')
  assert.deepEqual(queryTermsForRanking('the and of'), [])
  assert.deepEqual(queryTermsForRanking(''), [])
  assert.deepEqual(queryTermsForRanking(undefined), [])
  assert.deepEqual(queryTermsForRanking(42), [])
})

test('queryTermsForRanking emits CJK single characters and adjacent bigrams', () => {
  const terms = queryTermsForRanking('记忆插件')
  for (const expected of ['记', '忆', '插', '件', '记忆', '忆插', '插件']) {
    assert.ok(terms.includes(expected), 'missing term: ' + expected)
  }
  assert.deepEqual(queryTermsForRanking('的了'), [])
})

test('scoreIndexPointer weights a title hit 2x over hook and file-name hits', () => {
  const pointer = { title: 'Prefers tabs', file: 'unrelated-file.md', hook: 'always tabs' }
  // 'tab' hits the title (2) and the hook (1) but not the file name.
  assert.equal(scoreIndexPointer(pointer, ['tab']), 3)
  assert.equal(scoreIndexPointer(pointer, ['always']), 1)
  assert.equal(scoreIndexPointer(pointer, ['tab', 'always']), 4)
  // File-name-only hits count 1.
  assert.equal(scoreIndexPointer(pointer, ['unrelated']), 1)
  assert.equal(scoreIndexPointer(pointer, ['missing']), 0)
  assert.equal(scoreIndexPointer(undefined, ['tab']), 0)
  assert.equal(scoreIndexPointer(pointer, []), 0)
})

test('reorderIndexForQuery ranks matching pointers first and leaves other lines in place', () => {
  const indexText = [
    '# Memory Index',
    '',
    '- [Vue tips](vue-tips.md) — framework advice',
    '- [Prefers tabs](prefers-tabs.md) — tabs over spaces',
    '- [Unrelated note](unrelated-note.md) — something else',
    '',
  ].join('\n')
  const reordered = reorderIndexForQuery(indexText, 'tabs vs spaces in review')
  const lines = reordered.split('\n')
  assert.equal(lines[0], '# Memory Index')
  assert.equal(lines[1], '')
  assert.match(lines[2], /prefers-tabs\.md/)
  assert.match(lines[3], /vue-tips\.md/)
  assert.match(lines[4], /unrelated-note\.md/)
  assert.equal(lines[5], '')
})

test('reorderIndexForQuery is stable: zero-score pointers and equal scores keep their order', () => {
  const indexText = '- [Alpha](alpha.md) — first\n- [Beta](beta.md) — second\n- [Gamma](gamma.md) — third\n'
  // No pointer matches → identity permutation.
  assert.equal(reorderIndexForQuery(indexText, 'zzz-no-match'), indexText)
  // Two pointers tie on score → original relative order preserved.
  const tied = reorderIndexForQuery(indexText, 'first third')
  const alphaAt = tied.indexOf('alpha.md')
  const gammaAt = tied.indexOf('gamma.md')
  assert.ok(alphaAt < gammaAt)
})

test('reorderIndexForQuery returns the input unchanged for empty queries and non-strings', () => {
  const indexText = '- [Alpha](alpha.md) — first\n- [Beta](beta.md) — second\n'
  assert.equal(reorderIndexForQuery(indexText, ''), indexText)
  assert.equal(reorderIndexForQuery(indexText, undefined), indexText)
  assert.equal(reorderIndexForQuery(indexText, '   '), indexText)
  assert.equal(reorderIndexForQuery('', 'tabs'), '')
  assert.equal(reorderIndexForQuery(undefined, 'tabs'), undefined)
})

test('reorderIndexForQuery ranks CJK queries against Chinese titles and hooks', () => {
  const indexText = [
    '- [English note](english-note.md) — general advice',
    '- [前端规范](frontend-style.md) — 前端样式约定',
  ].join('\n')
  const reordered = reorderIndexForQuery(indexText, '前端样式要怎么调')
  assert.ok(
    reordered.indexOf('frontend-style.md') < reordered.indexOf('english-note.md'),
    'CJK-relevant pointer should rank first',
  )
})

test('reorderIndexForQuery keeps non-.md pointer lines and pointer-free text in place', () => {
  const indexText = [
    '- [External](https://example.com) — a link',
    '- [Prefers tabs](prefers-tabs.md) — tabs over spaces',
  ].join('\n')
  const reordered = reorderIndexForQuery(indexText, 'tabs')
  assert.ok(reordered.startsWith('- [External](https://example.com) — a link'))
  assert.match(reordered, /prefers-tabs\.md/)
})

test('formatIndexContent reorders by query BEFORE line truncation, so relevant pointers survive', () => {
  const pointerLines = [
    '- [Prefers tabs](prefers-tabs.md) — tabs over spaces',
    '- [Vue tips](vue-tips.md) — framework advice',
    '- [Golang notes](golang-notes.md) — go concurrency',
  ]
  const filler = Array.from(
    { length: 40 },
    (_, index) => '- [Filler ' + String(index).padStart(2, '0') + '](filler-' + index + '.md) — filler',
  ).join('\n')
  const raw = [...pointerLines, filler].join('\n')
  // Ranked: the golang pointer moves to the top and survives the 1-line cap;
  // everything else falls below the cut.
  const ranked = formatIndexContent(raw, { maxLines: 1, query: 'golang concurrency' })
  assert.equal(ranked.truncated, true)
  assert.match(ranked.text, /golang-notes\.md/)
  assert.doesNotMatch(ranked.text, /vue-tips\.md/)
  assert.doesNotMatch(ranked.text, /prefers-tabs\.md/)
  // Without the query the first line in file order wins instead.
  const plain = formatIndexContent(raw, { maxLines: 1 })
  assert.match(plain.text, /prefers-tabs\.md/)
  assert.doesNotMatch(plain.text, /golang-notes\.md/)
})

test('formatIndexContent without a query stays byte-identical to the legacy behavior', () => {
  const raw = '# Index\n\n- [Alpha](alpha.md) — first\n- [Beta](beta.md) — second\n'
  assert.equal(formatIndexContent(raw).text, '# Index\n\n- [Alpha](alpha.md) — first\n- [Beta](beta.md) — second')
  assert.equal(formatIndexContent(raw, { query: '' }).text, formatIndexContent(raw).text)
  assert.equal(formatIndexContent(raw, { query: '   ' }).text, formatIndexContent(raw).text)
  assert.equal(formatIndexContent(undefined, { query: 'tabs' }).text, '')
})

test('renderMemorySection forwards the query to the workspace index', () => {
  const rendered = renderMemorySection({
    root: 'C:/ws/.dsh/memory',
    rawIndex: '- [Prefers tabs](prefers-tabs.md) — tabs over spaces\n- [Vue tips](vue-tips.md) — framework advice',
    query: 'tabs',
  })
  assert.ok(rendered.text.indexOf('(workspace memory, persists across sessions)') !== -1)
  assert.ok(
    rendered.text.indexOf('prefers-tabs.md') !== -1 && rendered.text.indexOf('vue-tips.md') !== -1,
  )
  assert.equal(rendered.text.includes('shared across workspaces'), false)
  // 'tabs' hits the first pointer (title+hook+file), so it is ranked first.
  const tabsAt = rendered.text.indexOf('prefers-tabs.md')
  const vueAt = rendered.text.indexOf('vue-tips.md')
  assert.ok(tabsAt < vueAt, 'the matching pointer is ranked first')
})
/* ------------------------------------------------------------ host integration */

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

/** Register the services the plugin needs and apply it to the fake context. */
function createPluginHarness(fs, agent, config = {}) {
  const services = {
    systemPrompt: { section: (section) => { ctxRef.sections.push(section); return () => {} } },
    agents: { list: () => [agent] },
    sessions: { list: () => [agent.session] },
    fs,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: agent.session.header.cwd }) },
  }
  const ctxRef = createFakeCtx(services)
  apply(ctxRef, config)
  return { ctxRef }
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

const fact = (name, description, type) => '---\nname: ' + name + '\ndescription: ' + description
  + '\nmetadata:\n  node_type: memory\n  type: ' + type + '\n---\nbody\n'

test('the first keyword-bearing user message reorders the injected section and never rewrites MEMORY.md', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-relevance-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    // Every fact is already linked, so init's index repair has nothing to add
    // and any later MEMORY.md write can only come from the ranking (bug).
    fs.files.set(
      join(memoryDir, 'MEMORY.md'),
      '- [Vue tips](vue-tips.md) \u2014 framework advice\n- [Prefers tabs](prefers-tabs.md) \u2014 tabs over spaces\n',
    )
    fs.files.set(join(memoryDir, 'vue-tips.md'), fact('vue-tips', 'framework advice', 'project'))
    fs.files.set(join(memoryDir, 'prefers-tabs.md'), fact('prefers-tabs', 'tabs over spaces', 'project'))

    const agent = createFakeAgent('sess_relevance', workspace)
    const { ctxRef } = createPluginHarness(fs, agent, { autoExtract: false, globalMemoryRoot: globalDir })
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionText().includes('# Memory')), true)
      // Before any message: file order (Vue first).
      assert.ok(
        sectionText().indexOf('vue-tips.md') < sectionText().indexOf('prefers-tabs.md'),
        'init order follows the file',
      )

      emitTurn(ctxRef, agent, 1, 'We keep debating tabs vs spaces during review')
      assert.equal(await waitFor(() => {
        const text = sectionText()
        return text.includes('prefers-tabs.md') && text.indexOf('prefers-tabs.md') < text.indexOf('vue-tips.md')
      }), true, 'the tabs pointer should rank first after the first keyword-bearing message')

      // The ranking is a pure re-render: the index file on disk keeps its
      // original order (no MEMORY.md write at any point in this scenario).
      const indexWrites = fs.writes.filter((write) => write.path === join(memoryDir, 'MEMORY.md'))
      assert.equal(indexWrites.length, 0, 'MEMORY.md must never be rewritten by ranking')
      const disk = fs.files.get(join(memoryDir, 'MEMORY.md'))
      assert.ok(
        disk.indexOf('vue-tips.md') < disk.indexOf('prefers-tabs.md'),
        'disk order unchanged (Vue still first on disk)',
      )
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('under a tight maxIndexChars the query keeps the relevant pointer alive while tail lines fall off', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-relevance-trunc-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    const fillerLines = Array.from(
      { length: 30 },
      (_, index) => '- [Filler ' + String(index).padStart(2, '0') + '](filler-' + index + '.md) \u2014 filler note',
    )
    // The relevant pointer sits at the very tail of a long index; without the
    // ranking it would always be the first thing a tight cap cuts.
    fs.files.set(
      join(memoryDir, 'MEMORY.md'),
      [...fillerLines, '- [Prefers tabs](prefers-tabs.md) \u2014 tabs over spaces'].join('\n') + '\n',
    )
    fs.files.set(join(memoryDir, 'prefers-tabs.md'), fact('prefers-tabs', 'tabs over spaces', 'project'))

    const agent = createFakeAgent('sess_relevance_trunc', workspace)
    const { ctxRef } = createPluginHarness(fs, agent, { autoExtract: false, maxIndexChars: 400, globalMemoryRoot: globalDir })
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionText().includes('# Memory')), true)
      // Init (no query yet): the tail pointer is cut and the warning shows.
      assert.equal(sectionText().includes('prefers-tabs.md'), false)
      assert.match(sectionText(), /WARNING: MEMORY\.md is too large/)

      emitTurn(ctxRef, agent, 1, 'Tabs again: the team cannot agree on tabs vs spaces')
      assert.equal(
        await waitFor(() => sectionText().includes('prefers-tabs.md')),
        true,
        'the ranked pointer should be re-injected before truncation applies',
      )
      assert.match(sectionText(), /WARNING: MEMORY\.md is too large/)
      assert.doesNotMatch(sectionText(), /filler-25\.md/)

      const indexWrites = fs.writes.filter((write) => write.path === join(memoryDir, 'MEMORY.md'))
      assert.equal(indexWrites.length, 0, 'MEMORY.md must never be rewritten by ranking')
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})

test('a message without a keyword signal leaves the cached section untouched', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-relevance-skip-'))
  const globalDir = join(workspace, '.dsh', 'memory')
  try {
    const fs = createFakeFs()
    const memoryDir = join(workspace, '.dsh', 'memory')
    fs.files.set(
      join(memoryDir, 'MEMORY.md'),
      '- [Vue tips](vue-tips.md) \u2014 framework advice\n- [Prefers tabs](prefers-tabs.md) \u2014 tabs over spaces\n',
    )
    fs.files.set(join(memoryDir, 'vue-tips.md'), fact('vue-tips', 'framework advice', 'project'))
    fs.files.set(join(memoryDir, 'prefers-tabs.md'), fact('prefers-tabs', 'tabs over spaces', 'project'))

    const agent = createFakeAgent('sess_relevance_skip', workspace)
    const { ctxRef } = createPluginHarness(fs, agent, { autoExtract: false, globalMemoryRoot: globalDir })
    try {
      const sectionText = () => (ctxRef.sections[0] ? ctxRef.sections[0].text({ agent }) : '')
      assert.equal(await waitFor(() => sectionText().includes('# Memory')), true)
      const before = sectionText()

      // No ranking terms ('okay and the' are all stop words) → no query, no
      // refresh, order unchanged.
      emitTurn(ctxRef, agent, 1, 'okay and the')
      await new Promise((done) => setTimeout(done, 100))
      assert.equal(sectionText(), before)

      const indexWrites = fs.writes.filter((write) => write.path === join(memoryDir, 'MEMORY.md'))
      assert.equal(indexWrites.length, 0)
    } finally {
      ctxRef.disposeAll()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(globalDir, { recursive: true, force: true })
  }
})
