/**
 * Panel-side tests for the extraction activity badge (roadmap B2) and the
 * activity feed with its index diff (roadmap C1).
 *
 * `lib/client.js` is a plain browser module that hands its factory to
 * `window.__ModuleLoader__`, so these tests load it inside a `vm` sandbox
 * with a stubbed loader and a recording React stand-in, then drive the
 * hook-free views through the factory's `__internals` test seam.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('the panel top bar shows the extraction count of the selected workspace', () => {
  const { PageHead, Chip, makeT } = __internals
  const t = makeT((key, vars) => (key === 'catalog.extractCount' ? '今日提取 ' + vars.n + ' 次' : key))

  const head = PageHead({ t, activity: { todayCount: 2, lastAt: 42 }, busy: false })
  const tools = head.children.find((child) => child.props.className === 'dwm-headtools')
  const chip = tools.children[0]
  assert.equal(chip.tag, Chip)
  assert.equal(chip.props.tone, 'on')
  assert.equal(chip.props.text, '今日提取 2 次')

  // The chip carries the themed class the --dsw-alias-* tokens style.
  assert.equal(Chip({ tone: 'on', text: '今日提取 2 次' }).props.className, 'dwm-chip is-on')
})

test('the count chip falls back to the off tone at zero and hides without activity', () => {
  const { PageHead, Chip, makeT } = __internals
  const t = makeT((key, vars) => (key === 'catalog.extractCount' ? vars.n + ' extraction(s) today' : key))

  const zero = PageHead({ t, activity: { todayCount: 0 } })
  const tools = zero.children.find((child) => child.props.className === 'dwm-headtools')
  assert.equal(tools.children[0].tag, Chip)
  assert.equal(tools.children[0].props.tone, 'off')
  assert.equal(tools.children[0].props.text, '0 extraction(s) today')

  // Loading and error states pass no activity: no chip, refresh button stays.
  const bare = PageHead({ t })
  const bareTools = bare.children.find((child) => child.props.className === 'dwm-headtools')
  assert.equal(bareTools.children.some((child) => child !== null && child.tag === Chip), false)
})

test('normalizeCatalog passes todayCount and lastAt through', () => {
  const { normalizeCatalog } = __internals
  const catalog = normalizeCatalog({
    config: { enabled: true, autoExtract: true },
    workspaces: [{
      path: 'C:/work/demo',
      files: [{ name: 'MEMORY.md', kind: 'index', size: 5, updatedAt: 0 }],
      todayCount: 3,
      lastAt: 1699999999999,
    }],
  })
  assert.equal(catalog.workspaces[0].todayCount, 3)
  assert.equal(catalog.workspaces[0].lastAt, 1699999999999)

  // Missing counters collapse to 0 so the chip renders the off state.
  const empty = normalizeCatalog({
    workspaces: [{ path: 'C:/w', files: [{ name: 'MEMORY.md', kind: 'index', size: 1, updatedAt: 0 }] }],
  })
  assert.equal(empty.workspaces[0].todayCount, 0)
  assert.equal(empty.workspaces[0].lastAt, 0)
})

test('normalizeCatalog keeps the per-session skip flag (roadmap C2)', () => {
  const { normalizeCatalog } = __internals

  // The host echoes the volatile session state next to the catalog config.
  // Elements come from another vm realm; compare values, not references.
  const tracked = normalizeCatalog({
    config: { enabled: true, autoExtract: true },
    session: { sessionId: 'sess_main', skipTurnExtraction: true },
    workspaces: [],
  })
  assert.deepEqual(JSON.parse(JSON.stringify(tracked.session)), { sessionId: 'sess_main', skipTurnExtraction: true })

  // An untracked or absent session collapses to null so the toggle hides.
  const untracked = normalizeCatalog({ config: {}, workspaces: [] })
  assert.equal(untracked.session, null)
  const broken = normalizeCatalog({ session: 'garbage', workspaces: [] })
  assert.equal(broken.session, null)
  // A present flag survives; a missing or non-boolean one collapses to false.
  const coerced = normalizeCatalog({ session: { skipTurnExtraction: 'yes' }, workspaces: [] })
  assert.deepEqual(JSON.parse(JSON.stringify(coerced.session)), { sessionId: '', skipTurnExtraction: false })
})

test('ConfigBar renders the session incognito toggle only for tracked sessions', () => {
  const { ConfigBar, Chip, makeT } = __internals
  const t = makeT((key) => (key === 'config.skipTurnOn' ? '本轮不提取：已开启' : key === 'config.skipTurnOff' ? '本轮不提取' : key))

  // Tracked session: a toggle button reflecting the current flag state.
  const tracked = ConfigBar({
    t,
    config: { enabled: true, autoExtract: true },
    session: { sessionId: 'sess_main', skipTurnExtraction: true },
    onToggleSkip: () => {},
  })
  const chips = tracked.children.find((child) => child.props.className === 'dwm-chips')
  const button = chips.children.find((child) => child !== null && child.tag === 'button')
  assert.notEqual(button, undefined)
  assert.equal(button.props.className, 'dwm-btn dwm-session-toggle is-on')
  assert.equal(button.props.onClick, tracked.children.find((child) => child.props.className === 'dwm-chips')
    .children.find((child) => child !== null && child.tag === 'button').props.onClick)
  assert.deepEqual(button.children, ['本轮不提取：已开启'])

  // Off state: same button element, off label, no is-on class.
  const off = ConfigBar({
    t,
    config: { enabled: true, autoExtract: true },
    session: { sessionId: 'sess_main', skipTurnExtraction: false },
    onToggleSkip: () => {},
  })
  const offButton = off.children.find((child) => child.props.className === 'dwm-chips')
    .children.find((child) => child !== null && child.tag === 'button')
  assert.equal(offButton.props.className, 'dwm-btn dwm-session-toggle')
  assert.deepEqual(offButton.children, ['本轮不提取'])

  // Untracked session: no toggle, the read-only chips stay.
  const bare = ConfigBar({ t, config: { enabled: true, autoExtract: true }, session: null, onToggleSkip: () => {} })
  const bareChips = bare.children.find((child) => child.props.className === 'dwm-chips')
  assert.equal(bareChips.children.some((child) => child !== null && child.tag === 'button'), false)
  assert.equal(bareChips.children.filter((child) => child !== null && child.tag === Chip).length, 2)
})

test('both locale dictionaries carry the session toggle keys', () => {
  assert.match(source, /'config\.skipTurnOn': '本轮不提取：已开启'/)
  assert.match(source, /'config\.skipTurnOff': '本轮不提取'/)
  assert.match(source, /'config\.skipTurnOn': 'No extraction this session: on'/)
  assert.match(source, /'config\.skipTurnOff': 'No extraction this session'/)
})

test('both locale dictionaries carry the extraction count key', () => {
  assert.match(source, /'catalog\.extractCount': '今日提取 \{n\} 次'/)
  assert.match(source, /'catalog\.extractCount': '\{n\} extraction\(s\) today'/)
})

test('both locale dictionaries carry the activity feed keys', () => {
  assert.match(source, /'activity\.title': '最近提取活动'/)
  assert.match(source, /'activity\.empty': '还没有提取活动'/)
  assert.match(source, /'activity\.remembered': '记住了 \{n\} 条'/)
  assert.match(source, /'activity\.forgot': '忘了 \{n\} 条'/)
  assert.match(source, /'activity\.noDiff': '这条记录没有保存索引前后文本'/)
  assert.match(source, /'activity\.diffSame': '索引内容没有变化'/)
  assert.match(source, /'activity\.title': 'Recent extraction activity'/)
  assert.match(source, /'activity\.empty': 'No extraction activity yet'/)
  assert.match(source, /'activity\.remembered': 'Remembered \{n\}'/)
  assert.match(source, /'activity\.forgot': 'Forgot \{n\}'/)
  assert.match(source, /'activity\.noDiff': 'This entry has no before\/after index text'/)
  assert.match(source, /'activity\.diffSame': 'Index content unchanged'/)
})

test('normalizeActivities guards entries and sorts newest first', () => {
  const { normalizeActivities } = __internals
  const entries = normalizeActivities({
    activities: [
      { at: 100, workspace: 'C:/w', wrote: ['a.md', 42, null], forgot: ['b.md'], diffSummary: '+1 -0', indexBefore: '# x', indexAfter: '# y' },
      { at: 300, workspace: 'C:/w', wrote: ['c.md'] },
      { at: 200, workspace: 'C:/other', wrote: [], forgot: ['d.md'] },
      'garbage',
      null,
    ],
    unexpected: true,
  })
  assert.equal(entries.length, 3)
  // Elements come from another vm realm; compare values, not references.
  assert.deepEqual(entries.map((entry) => entry.at).join(','), '300,200,100')
  assert.deepEqual(entries[0].wrote.join(','), 'c.md')
  assert.deepEqual(entries[0].forgot.join(','), '')
  // Non-string array members are dropped.
  assert.deepEqual(entries[2].wrote.join(','), 'a.md')
  assert.equal(entries[2].indexBefore, '# x')

  // Malformed payloads degrade to an empty feed instead of throwing.
  assert.equal(normalizeActivities(undefined).length, 0)
  assert.equal(normalizeActivities({ activities: 'nope' }).length, 0)
  assert.equal(normalizeActivities(null).length, 0)
})

test('diffLines renders removed-before-added runs with no dependencies', () => {
  const { diffLines } = __internals
  const before = '- [Old fact](old.md) — old\n- [Kept](kept.md) — keep\n'
  const after = '- [Kept](kept.md) — keep\n- [New fact](new.md) — new\n'
  const hunks = diffLines(before, after)
  const flat = JSON.parse(JSON.stringify(hunks))
  assert.equal(flat.length, 2)
  assert.deepEqual(flat[0], { removed: ['- [Old fact](old.md) — old'], added: [] })
  assert.deepEqual(flat[1], { removed: [], added: ['- [New fact](new.md) — new'] })

  // Identical content and empty inputs produce no hunks.
  assert.deepEqual(diffLines(before, before).length, 0)
  assert.deepEqual(diffLines('', after).length, 1)
})

test('ActivityEntry shows remembered/forgot counts and expands the index diff on click', () => {
  const { ActivityEntry, ActivityDiff, makeT } = __internals
  const t = makeT((key, vars) => (key === 'activity.remembered' ? '记住了 ' + vars.n + ' 条' : key === 'activity.forgot' ? '忘了 ' + vars.n + ' 条' : key))
  const entry = { at: 42, workspace: 'C:/w', wrote: ['a.md', 'b.md'], forgot: ['c.md'], diffSummary: '+2 -1', indexBefore: '# old', indexAfter: '# new' }

  const closed = ActivityEntry({ t, entry, open: false, onToggle: () => {} })
  assert.equal(closed.props.className, 'dwm-activity')
  assert.equal(closed.props.title, 'time.unknown')
  // The fake React keeps array children nested and puts text on element
  // children, so flatten and read both before inspecting.
  const text = (node) => Array.isArray(node.children) ? node.children.join('') : node.children
  const line = closed.children.flat(Infinity).find((child) => child !== null && child.props.className === 'dwm-activity-line')
  assert.deepEqual(line.children.flat(Infinity).map(text).join('|'), '记住了 2 条|忘了 1 条|+2 -1')
  const counts = line.children.flat(Infinity)
  assert.equal(counts[0].props.className, 'dwm-activity-count is-added')
  assert.equal(counts[1].props.className, 'dwm-activity-count is-removed')
  assert.equal(closed.children.flat(Infinity).some((child) => child !== null && child.props.className === 'dwm-activity-diff'), false)

  const open = ActivityEntry({ t, entry, open: true, onToggle: () => {} })
  assert.equal(open.props.className, 'dwm-activity is-open')
  const diff = open.children.flat(Infinity).find((child) => child !== null && child.tag === ActivityDiff)
  assert.equal(diff.props.before, '# old')
  assert.equal(diff.props.after, '# new')

  // Zero-remembered entries keep the count but drop the forgot chip.
  const zero = ActivityEntry({ t, entry: { at: 7, wrote: [], forgot: [], diffSummary: '' }, open: false, onToggle: () => {} })
  const zeroLine = zero.children.flat(Infinity).find((child) => child !== null && child.props.className === 'dwm-activity-line')
  assert.deepEqual(zeroLine.children.flat(Infinity).map(text).join('|'), '记住了 0 条')
  assert.equal(zeroLine.children.flat(Infinity)[0].props.className, 'dwm-activity-count')
})

test('ActivityDiff explains missing and unchanged index text', () => {
  const { ActivityDiff, makeT } = __internals
  const t = makeT((key) => key)
  const note = ActivityDiff({ t, before: '', after: '' })
  assert.equal(note.props.className, 'dwm-activity-note')
  assert.equal(note.children[0], 'activity.noDiff')
  const same = ActivityDiff({ t, before: '# same', after: '# same' })
  assert.equal(same.props.className, 'dwm-activity-note')
  assert.equal(same.children[0], 'activity.diffSame')
  const diff = ActivityDiff({ t, before: 'a\n', after: 'b\n' })
  assert.equal(diff.props.className, 'dwm-activity-diff')
  assert.equal(diff.children.length, 1)
})

test('ActivityFeed lists entries and toggles the open diff', () => {
  const { ActivityFeed, ActivityEntry, makeT } = __internals
  const t = makeT((key) => key)
  const empty = ActivityFeed({ t, entries: [], openIndex: null, onToggle: () => {} })
  assert.equal(empty.props.className, 'dwm-activities')
  const emptyNote = empty.children.find((child) => child !== null && child.props.className === 'dwm-activity-note')
  assert.equal(emptyNote.children[0], 'activity.empty')

  const entries = [
    { at: 100, workspace: 'C:/w', wrote: ['a.md'], forgot: [], diffSummary: '+1 -0', indexBefore: 'x', indexAfter: 'y' },
    { at: 200, workspace: 'C:/w', wrote: ['b.md'], forgot: [], diffSummary: '+1 -0', indexBefore: 'p', indexAfter: 'q' },
  ]
  const feed = ActivityFeed({ t, entries, openIndex: 1, onToggle: () => {} })
  const items = feed.children.flat(Infinity).filter((child) => child !== null && child.tag === ActivityEntry)
  assert.equal(items.length, 2)
  assert.equal(items[0].props.open, false)
  assert.equal(items[1].props.open, true)
  items[0].props.onToggle()
})

test('callHost retries transient rpc failures with exponential backoff and succeeds', async () => {
  const { callHost } = __internals
  let calls = 0
  const root = {
    get: () => ({
      rpc: {
        call() {
          calls += 1
          if (calls < 3) throw new Error('transport down')
          return { ok: true, value: { config: {}, workspaces: [] } }
        },
      },
    }),
  }
  const result = await callHost(root, 'catalog', {})
  assert.equal(result.ok, true)
  assert.equal(calls, 3)
})

test('callHost gives up after three attempts and reports rpc-failed', async () => {
  const { callHost } = __internals
  let calls = 0
  const root = {
    get: () => ({
      rpc: {
        call() {
          calls += 1
          throw new Error('still down')
        },
      },
    }),
  }
  const result = await callHost(root, 'catalog', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'rpc-failed')
  assert.equal(calls, 3)
})

test('callHost does not retry a structured ok:false answer', async () => {
  const { callHost } = __internals
  let calls = 0
  const root = {
    get: () => ({
      rpc: {
        call() {
          calls += 1
          return { ok: false, error: { code: 'not-ready', message: 'host is starting', details: {} } }
        },
      },
    }),
  }
  const result = await callHost(root, 'catalog', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'not-ready')
  assert.equal(calls, 1)
})
