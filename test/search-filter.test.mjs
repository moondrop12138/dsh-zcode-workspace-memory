/**
 * Search, filter and virtual list tests (roadmap C4).
 *
 * Client side: `lib/client.js` loads in a `vm` sandbox like the panel tests
 * and the new pure helpers/views are driven through `__internals`. Host side:
 * `buildCatalog`/`listMemoryFiles` are exercised through the registered RPC
 * route with a fake fs adapter, mirroring the extraction test harness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Element stand-in: enough shape for assertions, no rendering. */
function createFakeReact() {
  return {
    createElement(tag, props, ...children) {
      return { tag, props: props ?? {}, children }
    },
    // `class PageBoundary extends React.Component` runs at factory load.
    Component: class {},
  }
}

/** Evaluate the client source and return its factory result. */
function loadClient() {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load(module) { captured = module } } },
    // The RPC retry backoff awaits a timer; tests run it synchronously.
    setTimeout(fn) { fn() },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.notEqual(captured, null)
  const fakeReact = createFakeReact()
  return captured.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
}

const { __internals } = loadClient()

/** Flatten the one-level arrays the fake createElement receives as rest args. */
function flat(children) {
  const out = []
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    if (child !== null && child !== undefined) out.push(child)
  }
  return out
}

/**
 * Evaluate function components (FileRow, Chip…) until a host tag remains:
 * the fake React stores `{tag: fn, props}`, so one call renders the body.
 */
function renderFn(el) {
  let node = el
  while (node !== null && node !== undefined && typeof node.tag === 'function') {
    node = node.tag(node.props)
  }
  return node
}

/**
 * The file column's title heading. Since roadmap C3 the heading sits inside a
 * `dwm-colhead` row next to the New-fact / Trash actions, so look one level in.
 */
function colTitle(node) {
  const direct = flat(node.children).find((child) => child !== null && child !== undefined
    && child.props !== undefined && child.props.className === 'dwm-col-title')
  if (direct !== undefined) return direct
  const head = flat(node.children).find((child) => child !== null && child !== undefined
    && child.props !== undefined && child.props.className === 'dwm-colhead')
  assert.notEqual(head, undefined, 'the file column keeps its heading row')
  return flat(head.children).find((child) => child !== null && child !== undefined
    && child.props !== undefined && child.props.className === 'dwm-col-title')
}

/** Locale stub: return the key itself except for a few known templates. */function makeStubT() {
  return __internals.makeT((key, vars) => {
    if (key === 'catalog.fileCount') return String(vars.n) + ' file(s)'
    if (key === 'state.updatedAt') return 'updated ' + String(vars.time)
    if (key === 'catalog.typeAll') return 'All'
    if (typeof key === 'string' && key.startsWith('catalog.type.')) return key.slice('catalog.type.'.length)
    return key
  })
}

/* ------------------------------------------------------------ client helpers */

test('sortFiles passes the memory type through and drops unknown ones', () => {
  const { sortFiles } = __internals
  const files = sortFiles([
    { name: 'MEMORY.md', kind: 'index', size: 5, updatedAt: 0 },
    { name: 'user-prefs.md', kind: 'fact', type: 'user', size: 7, updatedAt: 0 },
    { name: 'arch-note.md', kind: 'fact', type: 'architecture', size: 7, updatedAt: 0 },
    { name: 'no-type.md', kind: 'fact', size: 7, updatedAt: 0 },
  ])
  const byName = new Map(files.map((file) => [file.name, file]))
  assert.equal(byName.get('user-prefs.md').type, 'user')
  assert.equal(byName.get('arch-note.md').type, undefined)
  assert.equal(byName.get('no-type.md').type, undefined)
  assert.equal(byName.get('MEMORY.md').type, undefined)
})

test('filterFiles narrows by type and keyword, index included in keyword search', () => {
  const { filterFiles } = __internals
  const files = [
    { name: 'MEMORY.md', kind: 'index', size: 5, updatedAt: 0 },
    { name: 'user-prefs.md', kind: 'fact', type: 'user', size: 7, updatedAt: 0 },
    { name: 'project-layout.md', kind: 'fact', type: 'project', size: 9, updatedAt: 0 },
    { name: 'feedback-tests.md', kind: 'fact', type: 'feedback', size: 11, updatedAt: 0 },
  ]

  // No filter: everything survives, order untouched.
  assert.deepEqual(
    filterFiles(files, 'all', '').map((file) => file.name),
    ['MEMORY.md', 'user-prefs.md', 'project-layout.md', 'feedback-tests.md'],
  )

  // Type filter keeps only that type's facts (index never has a type).
  assert.deepEqual(
    filterFiles(files, 'project', '').map((file) => file.name),
    ['project-layout.md'],
  )

  // Keyword matches file names case-insensitively, including the index.
  assert.deepEqual(
    filterFiles(files, 'all', 'MEMORY').map((file) => file.name),
    ['MEMORY.md'],
  )
  assert.deepEqual(
    filterFiles(files, 'all', 'PREFS').map((file) => file.name),
    ['user-prefs.md'],
  )

  // Keyword also matches the memory type of a fact.
  assert.deepEqual(
    filterFiles(files, 'all', 'feedback').map((file) => file.name),
    ['feedback-tests.md'],
  )

  // Combined type + keyword.
  assert.deepEqual(
    filterFiles(files, 'project', 'LAYOUT').map((file) => file.name),
    ['project-layout.md'],
  )
  assert.deepEqual(filterFiles(files, 'user', 'layout'), [])

  // Garbage input never throws: unknown types collapse to 'all'.
  assert.equal(filterFiles(files, 'architecture', '').length, 4)
  assert.equal(filterFiles(null, 'user', 'x').length, 0)
})

test('windowFiles returns the viewport window with top/bottom padding', () => {
  const { windowFiles } = __internals
  // 100 rows of 58px in a 480px viewport: ~9 visible rows, overscan 5.
  const first = windowFiles(100, 0, 480, 58)
  assert.equal(first.start, 0)
  assert.ok(first.stop > 8 && first.stop <= 20, 'stop covers the viewport plus overscan')
  assert.equal(first.padTop, 0)
  assert.equal(first.padBottom, (100 - first.stop) * 58)

  // Scrolling deep into the list moves the window down.
  const deep = windowFiles(100, 58 * 50, 480, 58)
  assert.equal(deep.start, 50 - 5)
  assert.ok(deep.stop > deep.start)
  assert.equal(deep.padTop, deep.start * 58)
  assert.equal(deep.padBottom, (100 - deep.stop) * 58)

  // Degenerate inputs never throw and never invert.
  const empty = windowFiles(0, 99999, 0, 0)
  assert.equal(empty.start, 0)
  assert.equal(empty.stop, 0)
  assert.equal(empty.padTop, 0)
  assert.equal(empty.padBottom, 0)
})

/* ------------------------------------------------------------- client views */

test('FileFilterBar renders type chips and a keyword input wired to onFilter', () => {
  const { FileFilterBar } = __internals
  const t = makeStubT()
  const picked = []
  const bar = FileFilterBar({
    t,
    filter: { type: 'project', keyword: 'tab' },
    onFilter: (next) => picked.push(next),
  })

  // The chips live inside the dwm-chips span; the bar is [span, input].
  const chipsSpan = flat(bar.children).find((child) => child.props.className === 'dwm-chips')
  const chips = flat(chipsSpan.children).filter((chip) => String(chip.props.className).includes('dwm-type-chip'))
  assert.deepEqual(chips.map((chip) => chip.children[0]), ['All', 'user', 'feedback', 'project', 'reference'])
  const active = chips.filter((chip) => String(chip.props.className).includes(' is-on'))
  assert.deepEqual(active.map((chip) => chip.children[0]), ['project'])

  const input = flat(bar.children).find((child) => child.tag === 'input')
  assert.equal(input.props.value, 'tab')

  input.props.onChange({ target: { value: ' layout ' } })
  chips[0].props.onClick()
  // Compare field-by-field: sandbox objects and host literals have
  // different prototypes, so deepStrictEqual would reject them.
  assert.equal(picked.length, 2)
  assert.equal(picked[0].keyword, ' layout ')
  assert.equal(picked[1].type, 'all')
})

test('FileList renders all rows below the virtual threshold and pads above it', () => {
  const { FileList, FileRow } = __internals
  const t = makeStubT()
  const pickTargets = []
  const onPickFile = (name) => pickTargets.push(name)

  const small = [
    { name: 'MEMORY.md', kind: 'index', size: 5, updatedAt: 0 },
    { name: 'a.md', kind: 'fact', type: 'user', size: 7, updatedAt: 0 },
  ]
  const plain = FileList({ t, files: small, selectedFile: small[1], onScroll: () => {}, onPickFile })
  assert.equal(plain.tag, 'ul')
  const plainRows = flat(plain.children).map(renderFn)
  assert.equal(plainRows.length, 2)
  // The selected row carries the active class.
  assert.equal(flat(plainRows[1].children)[0].props.className, 'dwm-item is-active')

  // Fact rows show their type badge; the index row does not. The badge is a
  // deep span, so collect elements from the whole row subtree.
  const badgeTexts = (row) => {
    const found = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (String(node.props.className ?? '').includes('dwm-type-badge')) found.push(node.children[0])
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(row)
    return found
  }
  assert.deepEqual(plainRows.map(badgeTexts), [[], ['user']])

  // Above the threshold the list becomes a padded scroll container.
  const big = []
  for (let at = 0; at < 120; at += 1) {
    big.push({ name: 'fact-' + String(at).padStart(3, '0') + '.md', kind: 'fact', type: 'project', size: 3, updatedAt: 0 })
  }
  const scrolled = []
  const virtual = FileList({ t, files: big, selectedFile: null, scrollTop: 0, onScroll: (top) => scrolled.push(top), onPickFile })
  assert.equal(virtual.tag, 'div')
  assert.equal(String(virtual.props.className).includes('dwm-list-virtual'), true)
  const virtualRows = flat(virtual.children).map(renderFn)
  const pads = virtualRows.filter((child) => child.props.className === 'dwm-list-pad')
  assert.equal(pads.length, 1, 'only the bottom pad exists at scrollTop 0')
  // React rejects a string `style` prop with error #62 ("The style prop
  // expects a mapping from style properties to values, not a string"), which
  // is exactly how every workspace with more than VIRTUAL_LIST_MIN files used
  // to crash. Walk the whole rendered tree, not just the pads, so any future
  // inline style regression fails here instead of in the panel.
  const assertObjectStyles = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(assertObjectStyles)
    if (node.props && node.props.style !== undefined && node.props.style !== null) {
      assert.equal(typeof node.props.style, 'object', 'style prop must be an object, not a string (React #62)')
      assert.equal(Array.isArray(node.props.style), false, 'style prop must be a plain object')
    }
    if (Array.isArray(node.children)) node.children.forEach(assertObjectStyles)
  }
  const assertPadStyle = (pad) => {
    assert.equal(typeof pad.props.style, 'object', 'pad style must be an object, not a string')
    assert.match(pad.props.style.height, /^\d+px$/)
    assert.equal(Number(pad.props.style.height.slice(0, -2)) % 58, 0)
  }
  assertObjectStyles(plain)
  assertObjectStyles(virtual)
  for (const pad of pads) assertPadStyle(pad)
  // Scrolled into the middle: the top pad appears too, with the same shape.
  const middle = FileList({ t, files: big, selectedFile: null, scrollTop: 58 * 60, onScroll: () => {}, onPickFile })
  const middlePads = flat(middle.children).map(renderFn).filter((child) => child.props.className === 'dwm-list-pad')
  assert.equal(middlePads.length, 2, 'both pads exist mid-list')
  assertObjectStyles(middle)
  for (const pad of middlePads) assertPadStyle(pad)
  assert.ok(virtualRows.length < big.length, 'only a window of rows renders fully')
  // Each rendered row is li > button.dwm-item > [span.dwm-item-name, …].
  const firstButton = virtualRows[0].children[0]
  assert.equal(firstButton.props.className, 'dwm-item')
  // dwm-item-name children: kind badge, name span, optional type badge, size badge.
  const nameSpan = firstButton.children.find((child) => child.props.className === 'dwm-item-name')
  assert.equal(nameSpan.children[1].children[0], 'fact-000.md')

  virtual.props.onScroll({ target: { scrollTop: 58 * 60 } })
  assert.deepEqual(scrolled, [58 * 60])
})

test('FileColumn shows the filtered count, empty state, and keeps the file panel', () => {
  const { FileColumn } = __internals
  const t = makeStubT()
  const workspace = {
    path: 'C:/work/demo',
    title: 'demo',
    memoryRoot: 'C:/work/demo/.dsh/memory',
    files: [
      { name: 'MEMORY.md', kind: 'index', size: 5, updatedAt: 0 },
      { name: 'a.md', kind: 'fact', type: 'user', size: 7, updatedAt: 0 },
    ],
  }

  // Unfiltered: count shows the total.
  const all = FileColumn({
    t,
    selected: workspace,
    files: workspace.files,
    totalCount: 2,
    filter: { type: 'all', keyword: '' },
    onFilter: () => {},
    scrollTop: 0,
    onScroll: () => {},
    selectedFile: workspace.files[1],
    fileState: { status: 'idle', error: null, value: null },
    onPickFile: () => {},
    onReload: () => {},
  })
  const title = colTitle(all)
  assert.equal(title.children[0], 'catalog.files · 2 file(s)')

  // Filtered to nothing: an explicit empty state instead of a blank list —
  // FileColumn renders a bare StateBlock function element as its child.
  const none = FileColumn({
    t,
    selected: workspace,
    files: [],
    totalCount: 2,
    filter: { type: 'project', keyword: '' },
    onFilter: () => {},
    scrollTop: 0,
    onScroll: () => {},
    selectedFile: null,
    fileState: { status: 'idle', error: null, value: null },
    onPickFile: () => {},
    onReload: () => {},
  })
  const emptyState = flat(none.children).map(renderFn)
    .find((child) => child !== null && child.props.className === 'dwm-state')
  assert.notEqual(emptyState, undefined)

  // Filtered but not empty: the count reads filtered/total.
  const some = FileColumn({
    t,
    selected: workspace,
    files: [workspace.files[0]],
    totalCount: 2,
    filter: { type: 'all', keyword: 'MEMORY' },
    onFilter: () => {},
    scrollTop: 0,
    onScroll: () => {},
    selectedFile: workspace.files[0],
    fileState: { status: 'ready', error: null, value: { path: 'p', content: 'x', truncated: false } },
    onPickFile: () => {},
    onReload: () => {},
  })
  const someTitle = colTitle(some)
  assert.equal(someTitle.children[0], 'catalog.files · 1/2 file(s)')
})

test('both locale dictionaries carry the C4 search/filter keys', () => {
  const { filterFiles } = __internals
  assert.match(source, /'catalog\.typeAll': '全部'/)
  assert.match(source, /'catalog\.typeAll': 'All'/)
  assert.match(source, /'catalog\.searchPlaceholder': '搜索文件名或类型…'/)
  assert.match(source, /'catalog\.searchPlaceholder': 'Search names or types…'/)
  assert.match(source, /'catalog\.filterEmpty': '没有符合筛选条件的文件'/)
  assert.match(source, /'catalog\.filterEmpty': 'No file matches the current filter'/)
  for (const type of ['user', 'feedback', 'project', 'reference']) {
    assert.match(source, new RegExp("'catalog\\.type\\." + type + "':"))
  }
  // The type chips list mirrors the memory-core type set.
  assert.equal(filterFiles([{ name: 'a.md', kind: 'fact', type: 'user' }], 'user', '').length, 1)
})

/* ---------------------------------------------------------------- host side */

const HOST = new URL('file:///' + join(here, '..', 'lib', 'host.js').replace(/\\/g, '/'))
let hostInternals = null

async function host() {
  if (hostInternals === null) hostInternals = await import(HOST)
  return hostInternals.__internals
}

test('listMemoryFiles annotates fact types from frontmatter, index stays untyped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-c4-type-'))
  try {
    const memoryDir = join(workspace, '.dsh', 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [Prefs](user-prefs.md) — Uses tabs\n', 'utf8')
    await writeFile(
      join(memoryDir, 'user-prefs.md'),
      '---\nname: user-prefs\ndescription: Prefers tabs\nmetadata:\n  node_type: memory\n  type: user\n---\n\nUses tabs.\n',
      'utf8',
    )
    await writeFile(
      join(memoryDir, 'weird-type.md'),
      '---\nname: weird-type\ndescription: Odd\nmetadata:\n  node_type: memory\n  type: architecture\n---\n\nOdd.\n',
      'utf8',
    )
    const { listMemoryFiles } = await host()
    const files = await listMemoryFiles(
      { ctx: { get: () => undefined } },
      {
        resolve: async (path) => ({ targetKey: path, displayPath: path }),
        stat: async (target) => {
          try {
            const info = await (await import('node:fs/promises')).stat(target.displayPath)
            return { version: 'v1', type: info.isFile() ? 'file' : 'directory', size: info.size }
          } catch (_error) {
            return undefined
          }
        },
        readText: async (target) => readFile(target.displayPath, 'utf8').catch(() => undefined),
        listDir: async (target) => {
          const names = await (await import('node:fs/promises')).readdir(target.displayPath, { withFileTypes: true })
          return names.map((entry) => ({
            name: entry.name,
            type: entry.isFile() ? 'file' : 'directory',
            target: { targetKey: join(target.displayPath, entry.name), displayPath: join(target.displayPath, entry.name) },
          }))
        },
        contains: () => true,
      },
      workspace,
    )
    const byName = new Map(files.map((file) => [file.name, file]))
    assert.equal(byName.get('MEMORY.md').kind, 'index')
    assert.equal(byName.get('MEMORY.md').type, undefined)
    assert.equal(byName.get('user-prefs.md').type, 'user')
    assert.equal(byName.get('weird-type.md').type, undefined, 'unknown frontmatter types stay undefined')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('catalog RPC exposes the enriched types and stays backward compatible', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-c4-catalog-'))
  try {
    const memoryDir = join(workspace, '.dsh', 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [Prefs](user-prefs.md) — Uses tabs\n', 'utf8')
    await writeFile(
      join(memoryDir, 'user-prefs.md'),
      '---\nname: user-prefs\ndescription: Prefers tabs\nmetadata:\n  node_type: memory\n  type: user\n---\n\nUses tabs.\n',
      'utf8',
    )
    const hostModule = await import(HOST)
    const handlers = new Map()
    const routes = []
    const services = {
      systemPrompt: { section: () => () => {} },
      connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
      agents: { list: () => [] },
      sessions: { list: () => [] },
      workspaceRegistry: { list: () => [{ path: workspace, title: 'demo' }] },
      fs: {
        resolve: async (path) => ({ targetKey: path, displayPath: path }),
        stat: async (target) => {
          try {
            const info = await (await import('node:fs/promises')).stat(target.displayPath)
            return { version: 'v1', type: info.isFile() ? 'file' : 'directory', size: info.size }
          } catch (_error) {
            return undefined
          }
        },
        readText: async (target) => readFile(target.displayPath, 'utf8').catch(() => undefined),
        listDir: async (target) => {
          const names = await (await import('node:fs/promises')).readdir(target.displayPath, { withFileTypes: true })
          return names.map((entry) => ({
            name: entry.name,
            type: entry.isFile() ? 'file' : 'directory',
            target: { targetKey: join(target.displayPath, entry.name), displayPath: join(target.displayPath, entry.name) },
          }))
        },
        writeText: async () => {
          throw new Error('FS_SANDBOX_DENIED')
        },
        contains: () => true,
      },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }
    const ctx = {
      services,
      handlers,
      sections: [],
      rpcRoutes: routes,
      get: (name) => services[name],
      effect: (callback) => callback(),
      on: (name, handlerFn) => {
        const list = handlers.get(name) ?? []
        list.push(handlerFn)
        handlers.set(name, list)
        return () => {}
      },
      inject: () => {},
    }
    hostModule.apply(ctx, { enabled: true, autoExtract: true })
    assert.equal(routes.length, 1)

    const request = new Request('http://localhost/api/dsh-workspace-memory/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rpcId: 'r1',
        type: 'client-request',
        method: 'dsh-workspace-memory/call',
        payload: { endpoint: 'catalog', payload: {} },
      }),
    })
    const catalog = await (await routes[0].fetch(request)).json()
    assert.equal(catalog.result.ok, true)
    const files = catalog.result.value.workspaces[0].files
    const byName = new Map(files.map((file) => [file.name, file]))
    assert.equal(byName.get('user-prefs.md').type, 'user')
    assert.equal(byName.get('MEMORY.md').type, undefined)
    // Backward compatibility: the pre-C4 fields are all still present, and a
    // fact row carries `type` only when its frontmatter named a known type.
    // D2 adds the three epoch-ms timestamps (0 when unknown) to fact rows.
    const indexKeys = Object.keys(byName.get('MEMORY.md')).sort()
    assert.deepEqual(indexKeys, ['kind', 'name', 'size', 'updatedAt'])
    const factKeys = Object.keys(byName.get('user-prefs.md')).sort()
    assert.deepEqual(factKeys, ['createdAt', 'kind', 'lastAccessedAt', 'name', 'size', 'type', 'updatedAt'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
