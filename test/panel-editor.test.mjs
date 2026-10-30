/**
 * Panel-side tests for the fact editor, the delete confirm, and the trash view
 * (roadmap C3). `lib/client.js` is a plain browser module that hands its factory
 * to `window.__ModuleLoader__`, so this suite loads it inside a `vm` sandbox
 * with a recording React stand-in and drives the hook-free views directly.
 *
 * Like `test/panel.test.mjs`, elements come from another vm realm: compare
 * values through `JSON.parse(JSON.stringify(...))`, never by reference.
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
    Component: class {},
  }
}

/** Evaluate the client source and return its factory result. */
function loadClient() {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load(module) { captured = module } } },
    setTimeout(fn) { fn() },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.notEqual(captured, null)
  return captured.factory((name) => {
    assert.equal(name, 'react')
    return createFakeReact()
  })
}

const { __internals } = loadClient()

const EN = {
  'fact.editTitle': 'Edit {name}',
  'fact.newTitle': 'New fact',
  'fact.name': 'Name',
  'fact.type': 'Type',
  'fact.description': 'Description',
  'fact.body': 'Body',
  'fact.save': 'Save',
  'fact.saving': 'Saving…',
  'fact.cancel': 'Cancel',
  'fact.edit': 'Edit',
  'fact.delete': 'Delete',
  'fact.deleteConfirm': '删除后可在回收站恢复',
  'fact.deleteYes': 'Delete it',
  'fact.deleteNo': 'Keep it',
  'fact.trashTitle': 'Trash',
  'fact.trashHint': '{n} files are kept',
  'fact.trashEmpty': 'Nothing in the trash',
  'fact.restore': 'Restore',
  'fact.restoring': 'Restoring…',
  'fact.errorName': 'bad name',
  'fact.errorType': 'bad type',
  'fact.errorDescription': 'no description',
  'fact.errorDescriptionLong': 'too long (max {n})',
  'fact.errorBody': 'no body',
  'catalog.type.user': 'User',
  'catalog.type.feedback': 'Feedback',
  'catalog.type.project': 'Project',
  'catalog.type.reference': 'Reference',
}

const t = __internals.makeT((key, vars) => {
  const template = EN[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    const value = vars === undefined ? undefined : vars[name]
    return value === undefined ? '{' + name + '}' : String(value)
  })
})

/** Depth-first walk of a rendered element tree (arrays and nulls tolerated). */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

/** Every element in the tree with the matching tag. */
function findAll(tree, tag) {
  const found = []
  walk(tree, (node) => {
    if (node.tag === tag) found.push(node)
  })
  return found
}

/** All text carried as children, concatenated. */
function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child)
      else if (typeof child === 'number') parts.push(String(child))
    }
  })
  return parts.join(' ')
}

/** A host stand-in recording every rpc call and answering one canned value. */
function recordingRoot(answer = { ok: true, value: {} }) {
  const calls = []
  return {
    calls,
    root: {
      get(name) {
        if (name !== 'connection') return undefined
        return {
          rpc: {
            async call(base, endpoint, args) {
              calls.push({ base, endpoint, args: JSON.parse(JSON.stringify(args)) })
              return answer
            },
          },
        }
      },
    },
  }
}

test('the editor prefills every field from a fact-read value', () => {
  const { FactEditor, draftFromFact } = __internals
  const draft = draftFromFact({
    name: 'prefers-tabs.md',
    type: 'feedback',
    description: 'the user indents with tabs',
    body: 'Tabs everywhere, two spaces never.',
    createdAt: '2020-01-01T00:00:00.000Z',
  })

  assert.equal(draft.name, 'prefers-tabs')
  assert.equal(draft.creating, false)

  const editor = FactEditor({ t, draft, onField() {}, onSave() {}, onCancel() {} })
  assert.equal(editor.tag, 'form')
  assert.equal(textOf(editor).includes('Edit prefers-tabs'), true, 'the title names the fact')

  const inputs = findAll(editor, 'input')
  const nameInput = inputs[0]
  assert.equal(nameInput.props.value, 'prefers-tabs')
  assert.equal(nameInput.props.readOnly, true, 'the name is immutable when editing')
  assert.equal(nameInput.props.onChange, undefined)

  const select = findAll(editor, 'select')[0]
  assert.equal(select.props.value, 'feedback')
  const options = findAll(select, 'option')
  assert.deepEqual(options.map((option) => option.props.value), ['user', 'feedback', 'project', 'reference'])
  assert.deepEqual(options.map((option) => option.children[0]), ['User', 'Feedback', 'Project', 'Reference'])

  assert.equal(inputs[1].props.value, 'the user indents with tabs')
  const textarea = findAll(editor, 'textarea')[0]
  assert.equal(textarea.props.value, 'Tabs everywhere, two spaces never.')

  const labels = textOf(editor)
  for (const label of ['Name', 'Type', 'Description', 'Body']) {
    assert.equal(labels.includes(label), true, 'the editor labels ' + label)
  }
  const buttons = findAll(editor, 'button').map((button) => textOf(button))
  assert.deepEqual(buttons, ['Save', 'Cancel'])
})

test('a create draft starts blank with an editable name and user type', () => {
  const { FactEditor, blankFactDraft } = __internals
  const draft = blankFactDraft()
  const editor = FactEditor({ t, draft, onSave() {}, onCancel() {} })

  const nameInput = findAll(editor, 'input')[0]
  assert.equal(nameInput.props.value, '')
  assert.equal(nameInput.props.readOnly, false)
  assert.equal(typeof nameInput.props.onChange, 'function', 'the name is editable when creating')
  assert.equal(findAll(editor, 'select')[0].props.value, 'user')
  assert.equal(textOf(editor).includes('New fact'), true)
})

test('typing in a field reports the change through onField', () => {
  const { FactEditor, blankFactDraft } = __internals
  const changes = []
  const editor = FactEditor({
    t,
    draft: blankFactDraft(),
    onField: (field, value) => changes.push([field, value]),
    onSave() {},
    onCancel() {},
  })

  findAll(editor, 'input')[0].props.onChange({ target: { value: 'new-fact' } })
  findAll(editor, 'input')[1].props.onChange({ target: { value: 'the hook line' } })
  findAll(editor, 'textarea')[0].props.onChange({ target: { value: 'the body text' } })
  findAll(editor, 'select')[0].props.onChange({ target: { value: 'project' } })

  assert.deepEqual(changes, [
    ['name', 'new-fact'],
    ['description', 'the hook line'],
    ['body', 'the body text'],
    ['type', 'project'],
  ])
})

test('Save builds the exact fact-save payload and sends it over the call route', async () => {
  const { factSavePayload, callHost } = __internals
  const draft = {
    name: '  prefers-tabs  ',
    type: 'feedback',
    description: '  the user indents with tabs  ',
    body: '  Tabs everywhere.  ',
    creating: true,
  }
  const payload = factSavePayload('C:/work/demo', draft)
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    path: 'C:/work/demo',
    name: 'prefers-tabs',
    type: 'feedback',
    description: 'the user indents with tabs',
    body: 'Tabs everywhere.',
  })

  const { root, calls } = recordingRoot({ ok: true, value: { name: 'prefers-tabs', created: true } })
  const result = await callHost(root, 'fact-save', payload)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].base, '/api')
  assert.equal(calls[0].endpoint, 'dsh-workspace-memory/call')
  assert.equal(calls[0].args.endpoint, 'fact-save')
  assert.equal(calls[0].args.payload.name, 'prefers-tabs')
  assert.equal(calls[0].args.payload.type, 'feedback')
})

test('the editor validation mirrors the host rules before any request', () => {
  const { validateFactDraft } = __internals
  const base = { name: 'ok-name', type: 'user', description: 'hook', body: 'text' }
  assert.equal(validateFactDraft(base, t), null)

  assert.equal(validateFactDraft({ ...base, name: '' }, t), 'bad name')
  assert.equal(validateFactDraft({ ...base, name: 'MEMORY' }, t), 'bad name')
  assert.equal(validateFactDraft({ ...base, name: 'Not_Kebab' }, t), 'bad name')
  assert.equal(validateFactDraft({ ...base, name: 'x'.repeat(49) }, t), 'bad name')
  assert.equal(validateFactDraft({ ...base, type: 'nonsense' }, t), 'bad type')
  assert.equal(validateFactDraft({ ...base, description: '   ' }, t), 'no description')
  assert.equal(validateFactDraft({ ...base, description: 'x'.repeat(301) }, t), 'too long (max 300)')
  assert.equal(validateFactDraft({ ...base, body: '  ' }, t), 'no body')
})

test('delete is a two-step confirm that ends in a fact-delete call', async () => {
  const { FactActions, factDeletePayload, callHost } = __internals
  const asked = []
  const idle = FactActions({
    t,
    confirm: false,
    onEdit() {},
    onAskDelete: () => asked.push('ask'),
  })
  const idleButtons = findAll(idle, 'button')
  assert.deepEqual(idleButtons.map((button) => textOf(button)), ['Edit', 'Delete'])
  idleButtons[1].props.onClick()
  assert.deepEqual(asked, ['ask'])

  // The confirm step names the recoverable trash so no native dialog is needed.
  const confirmed = []
  const confirm = FactActions({
    t,
    confirm: true,
    onConfirmDelete: () => confirmed.push('yes'),
    onCancelDelete: () => confirmed.push('no'),
  })
  assert.equal(textOf(confirm).includes('删除后可在回收站恢复'), true, 'the confirm explains the trash')
  const confirmButtons = findAll(confirm, 'button')
  assert.deepEqual(confirmButtons.map((button) => textOf(button)), ['Delete it', 'Keep it'])
  confirmButtons[0].props.onClick()
  confirmButtons[1].props.onClick()
  assert.deepEqual(confirmed, ['yes', 'no'])

  const payload = factDeletePayload('C:/work/demo', 'prefers-tabs.md')
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { path: 'C:/work/demo', name: 'prefers-tabs.md' })
  const { root, calls } = recordingRoot({ ok: true, value: { name: 'prefers-tabs', trashed: true } })
  const result = await callHost(root, 'fact-delete', payload)
  assert.equal(result.ok, true)
  assert.equal(calls[0].args.endpoint, 'fact-delete')
  assert.equal(calls[0].args.payload.name, 'prefers-tabs.md')
})

test('an inline error line renders in the editor and in the confirm step', () => {
  const { FactEditor, FactActions, blankFactDraft } = __internals
  const editor = FactEditor({ t, draft: blankFactDraft(), error: 'bad name', busy: true, onSave() {}, onCancel() {} })
  const alerts = findAll(editor, 'p').filter((node) => node.props.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(textOf(alerts[0]), 'bad name')
  const save = findAll(editor, 'button')[0]
  assert.equal(save.props.disabled, true)
  assert.equal(textOf(save), 'Saving…')

  const confirm = FactActions({ t, confirm: true, error: 'index refused', onConfirmDelete() {}, onCancelDelete() {} })
  const confirmAlerts = findAll(confirm, 'p').filter((node) => node.props.role === 'alert')
  assert.equal(textOf(confirmAlerts[0]), 'index refused')
})

test('the trash view lists entries and Restore calls trash-restore', async () => {
  const { TrashPanel, trashRestorePayload, callHost } = __internals
  const entries = [
    { name: 'older-note', fileName: 'older-note.md', size: 800, modifiedAt: 1_600_000_000_000 },
    { name: 'newest-note', fileName: 'newest-note.md', size: 2048, modifiedAt: 1_700_000_000_000 },
  ]
  const restored = []
  const panel = TrashPanel({ t, entries, keep: 50, onRestore: (name) => restored.push(name) })

  assert.equal(textOf(panel).includes('Trash'), true)
  assert.equal(textOf(panel).includes('50 files are kept'), true)

  const rows = findAll(panel, 'li')
  assert.equal(rows.length, 2)
  const rowText = rows.map((row) => textOf(row))
  assert.equal(rowText[0].includes('older-note'), true)
  assert.equal(rowText[0].includes('800 B'), true)
  assert.equal(rowText[1].includes('newest-note'), true)
  assert.equal(rowText[1].includes('2 KB'), true)

  const restoreButtons = findAll(panel, 'button')
  assert.equal(restoreButtons.length, 2)
  assert.equal(textOf(restoreButtons[1]), 'Restore')
  restoreButtons[1].props.onClick()
  assert.deepEqual(restored, ['newest-note'])

  const payload = trashRestorePayload('C:/work/demo', 'newest-note')
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { path: 'C:/work/demo', name: 'newest-note' })
  const { root, calls } = recordingRoot({ ok: true, value: { name: 'newest-note', restored: true } })
  const result = await callHost(root, 'trash-restore', payload)
  assert.equal(result.ok, true)
  assert.equal(calls[0].args.endpoint, 'trash-restore')
  assert.equal(calls[0].args.payload.name, 'newest-note')
})

test('the trash view explains an empty trash and a busy restore', () => {
  const { TrashPanel, StateBlock } = __internals
  const empty = TrashPanel({ t, entries: [] })
  const states = findAll(empty, StateBlock)
  assert.equal(states.length, 1)
  assert.equal(states[0].props.title, 'Nothing in the trash')
  assert.equal(findAll(empty, 'button').length, 0)

  const busy = TrashPanel({
    t,
    entries: [{ name: 'one', fileName: 'one.md', size: 12, modifiedAt: 1_700_000_000_000 }],
    busy: true,
    onRestore() {},
  })
  const button = findAll(busy, 'button')[0]
  assert.equal(button.props.disabled, true)
  assert.equal(textOf(button), 'Restoring…')
})

test('no C3 view builds HTML: every node carries text as React children', () => {
  const { FactEditor, FactActions, TrashPanel, blankFactDraft, draftFromFact } = __internals
  const trees = [
    FactEditor({ t, draft: blankFactDraft() }),
    FactEditor({ t, draft: draftFromFact({ name: 'a-b', type: 'user', description: 'd', body: 'b' }) }),
    FactActions({ t, confirm: false }),
    FactActions({ t, confirm: true }),
    TrashPanel({ t, entries: [{ name: '<img src=x>', fileName: '<img src=x>.md', size: 3, modifiedAt: 1 }] }),
  ]
  let visited = 0
  for (const tree of trees) {
    walk(tree, (node) => {
      visited += 1
      assert.equal('dangerouslySetInnerHTML' in node.props, false, 'no dangerouslySetInnerHTML')
      assert.equal('innerHTML' in node.props, false, 'no innerHTML')
    })
  }
  assert.ok(visited > 20, 'the walk actually covered the trees')
})
