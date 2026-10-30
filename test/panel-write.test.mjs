/**
 * Panel write endpoints (roadmap C3): `fact-read`, `fact-save`, `fact-delete`,
 * `trash-list`, `trash-restore`.
 *
 * Everything here goes through the real `dispatch` seam so each test exercises
 * the guards the panel actually depends on: the workspace allow-list, the
 * per-workspace lock, the index-replacement guard and the trash move. The trash
 * half of the host talks to node fs directly (the fs seam cannot list a
 * directory that does not exist yet), so these tests use a real temp workspace
 * with a thin fs adapter over it — a Map-backed fake would not see `trash/`.
 *
 * Covered:
 *   1. save creates the fact file and its MEMORY.md pointer;
 *   2. save on an existing fact keeps createdAt/originSessionId and rewrites
 *      the pointer;
 *   3. save refuses invalid name, type, empty description/body, traversal and
 *      unknown workspace paths, leaving the memory root untouched;
 *   4. save refuses to write when the index cannot be read (or is full) — the
 *      same guard every other write path uses;
 *   5. fact-read returns the parsed prefill;
 *   6. delete moves the fact into trash/, drops the pointer, and trash-list
 *      reports it;
 *   7. trash-restore puts the file back, re-adds the pointer, and refuses once
 *      the name is taken again;
 *   8. every endpoint reports a contracted failure for a bad name / missing fact.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { __internals } from '../lib/host.js'
import {
  INDEX_FILE,
  TRASH_DIR,
  memoryRoot,
  parseFactFrontmatter,
  parseIndexPointers,
} from '../lib/memory-core.js'

const {
  dispatch,
  normalizeResult,
  workspaceLockSize,
  resetWorkspaceActivities,
} = __internals

/** The index every test starts from: one unrelated pointer to keep honest. */
const SEED_INDEX = [
  '# Memory',
  '',
  '- [Editor default](editor-default.md) — the user opens files with vim',
  '',
].join('\n')

/** Real-disk fs adapter: the shape the host's fs seam expects. */
function createRealFs(options = {}) {
  const resolve = async (path) => ({ targetKey: path, displayPath: path })
  return {
    resolve,
    stat: async (target) => {
      if (options.failingPath !== undefined && target.displayPath === options.failingPath) {
        const failure = new Error('denied')
        failure.code = 'EACCES'
        throw failure
      }
      try {
        const info = await stat(target.displayPath)
        return { version: 'v1', type: info.isFile() ? 'file' : 'directory', size: info.size }
      } catch (_error) {
        return undefined
      }
    },
    readText: async (target) => {
      if (options.failingPath !== undefined && target.displayPath === options.failingPath) {
        const failure = new Error('denied')
        failure.code = 'EACCES'
        throw failure
      }
      try {
        return await readFile(target.displayPath, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    listDir: async (target) => {
      const names = await readdir(target.displayPath, { withFileTypes: true })
      return names.map((entry) => ({
        name: entry.name,
        type: entry.isFile() ? 'file' : 'directory',
        target: {
          targetKey: join(target.displayPath, entry.name),
          displayPath: join(target.displayPath, entry.name),
        },
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

/** A plugin stand-in exposing only what the fact endpoints read. */
function createPlugin(workspace, fs) {
  const services = {
    fs,
    workspaceRegistry: { list: () => [{ path: workspace, title: 'demo' }] },
  }
  return {
    disposed: false,
    bySession: new Map(),
    ctx: { get: (name) => services[name] },
    config: {},
    controller: new AbortController(),
  }
}

/** One temp workspace with a seeded index; `run(fn)` owns the cleanup. */
async function withWorkspace(options, run) {
  const workspace = await mkdtemp(join(tmpdir(), 'dwm-c3-'))
  const root = memoryRoot(workspace)
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, INDEX_FILE), options.index ?? SEED_INDEX, 'utf8')
    if (options.fact !== undefined) {
      await writeFile(join(root, options.fact.file), options.fact.content, 'utf8')
    }
    const fs = createRealFs(options.fs)
    const plugin = createPlugin(workspace, fs)
    await run({ workspace, root, fs, plugin })
    // No test may leak a held lock into the next one.
    assert.equal(workspaceLockSize(), 0, 'the workspace lock is released')
  } finally {
    resetWorkspaceActivities()
    await rm(workspace, { recursive: true, force: true })
  }
}

/** Dispatch one endpoint and normalize exactly like the RPC route does. */
async function call(plugin, endpoint, payload) {
  return normalizeResult(await dispatch(plugin, endpoint, payload))
}

/** Every file name inside one memory root, bookkeeping included. */
async function listRoot(root) {
  try {
    const names = await readdir(root)
    return names.sort()
  } catch (_error) {
    return []
  }
}

/** The fact files and the index only: no rollback copy, no trash directory. */
async function factFiles(root) {
  const names = await listRoot(root)
  return names.filter((name) => name.endsWith('.md') && name !== INDEX_FILE && !name.endsWith('.prev'))
}

/** One seeded fact file with host-maintained history. */
function seededFact(overrides = {}) {
  const createdAt = overrides.createdAt ?? '2020-01-01T00:00:00.000Z'
  const updatedAt = overrides.updatedAt ?? '2020-02-02T00:00:00.000Z'
  return [
    '---',
    'name: prefers-tabs',
    'description: ' + (overrides.description ?? 'the user indents with tabs'),
    'metadata:',
    '  node_type: memory',
    '  type: ' + (overrides.type ?? 'user'),
    '  originSessionId: sess_origin',
    '  createdAt: ' + createdAt,
    '  updatedAt: ' + updatedAt,
    '---',
    '',
    overrides.body ?? 'Tabs everywhere, two spaces never.',
    '',
  ].join('\n')
}

test('fact-save creates the fact file and its MEMORY.md pointer', async () => {
  await withWorkspace({}, async ({ workspace, root, plugin }) => {
    const result = await call(plugin, 'fact-save', {
      path: workspace,
      name: 'prefers-tabs',
      type: 'user',
      description: 'the user indents with tabs',
      body: 'Tabs everywhere, two spaces never.',
    })

    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.value.name, 'prefers-tabs')
    assert.equal(result.value.fileName, 'prefers-tabs.md')
    assert.equal(result.value.created, true)
    assert.equal(result.value.indexChanged, true)
    assert.match(result.value.createdAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(result.value.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(
      Date.parse(result.value.updatedAt) >= Date.parse(result.value.createdAt),
      'a fresh fact is never stamped older than its own creation',
    )

    const text = await readFile(join(root, 'prefers-tabs.md'), 'utf8')
    const frontmatter = parseFactFrontmatter(text)
    assert.equal(frontmatter.name, 'prefers-tabs')
    assert.equal(frontmatter.type, 'user')
    assert.equal(frontmatter.description, 'the user indents with tabs')
    assert.equal(frontmatter.originSessionId, undefined)
    assert.match(text, /Tabs everywhere, two spaces never\./)

    const indexText = await readFile(join(root, INDEX_FILE), 'utf8')
    const pointers = parseIndexPointers(indexText)
    assert.deepEqual(pointers.map((pointer) => pointer.file), ['editor-default.md', 'prefers-tabs.md'])
    assert.equal(pointers[1].title, 'Prefers Tabs')
    assert.equal(pointers[1].hook, 'the user indents with tabs')
  })
})

test('fact-save on an existing fact keeps createdAt/originSessionId and rewrites the pointer', async () => {
  await withWorkspace({ fact: { file: 'prefers-tabs.md', content: seededFact() } }, async ({ workspace, root, plugin }) => {
    const index = SEED_INDEX + '- [Prefers tabs](prefers-tabs.md) — the user indents with tabs\n'
    await writeFile(join(root, INDEX_FILE), index, 'utf8')

    const result = await call(plugin, 'fact-save', {
      path: workspace,
      name: 'prefers-tabs.md',
      type: 'feedback',
      description: 'the user wants tab indentation, always',
      body: 'Rewrite with tabs and never spaces.',
    })

    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.value.created, false)
    assert.equal(result.value.createdAt, '2020-01-01T00:00:00.000Z')
    assert.notEqual(result.value.updatedAt, '2020-02-02T00:00:00.000Z')

    const text = await readFile(join(root, 'prefers-tabs.md'), 'utf8')
    const frontmatter = parseFactFrontmatter(text)
    assert.equal(frontmatter.createdAt, '2020-01-01T00:00:00.000Z')
    assert.equal(frontmatter.originSessionId, 'sess_origin')
    assert.equal(frontmatter.type, 'feedback')
    assert.equal(frontmatter.description, 'the user wants tab indentation, always')
    assert.match(text, /Rewrite with tabs and never spaces\./)

    const pointers = parseIndexPointers(await readFile(join(root, INDEX_FILE), 'utf8'))
    assert.equal(pointers.length, 2, 'one pointer per fact, no duplicate line')
    const updated = pointers.find((pointer) => pointer.file === 'prefers-tabs.md')
    assert.equal(updated.hook, 'the user wants tab indentation, always')
    assert.equal(updated.title, 'Prefers Tabs')
  })
})

test('fact-save refuses invalid input without touching the memory root', async () => {
  await withWorkspace({}, async ({ workspace, root, plugin }) => {
    const cases = [
      [{ name: '../escape', type: 'user', description: 'd', body: 'b' }, 'invalid-name'],
      [{ name: 'Memory', type: 'user', description: 'd', body: 'b' }, 'invalid-name'],
      [{ name: 'memory', type: 'user', description: 'd', body: 'b' }, 'invalid-name'],
      [{ name: '', type: 'user', description: 'd', body: 'b' }, 'invalid-name'],
      [{ name: 'a'.repeat(49), type: 'user', description: 'd', body: 'b' }, 'invalid-name'],
      [{ name: 'ok-name', type: 'bogus', description: 'd', body: 'b' }, 'invalid-type'],
      [{ name: 'ok-name', type: 'user', description: '   ', body: 'b' }, 'invalid-fact'],
      [{ name: 'ok-name', type: 'user', description: 'd', body: '   ' }, 'invalid-fact'],
    ]
    for (const [payload, code] of cases) {
      const result = await call(plugin, 'fact-save', { path: workspace, ...payload })
      assert.equal(result.ok, false, 'refused: ' + JSON.stringify(payload))
      assert.equal(result.error.code, code, JSON.stringify(payload))
      assert.equal(typeof result.error.message, 'string')
    }

    // A path the session cannot see is refused before any fs access.
    const outside = await call(plugin, 'fact-save', {
      path: 'C:/not-a-known-workspace',
      name: 'ok-name',
      type: 'user',
      description: 'd',
      body: 'b',
    })
    assert.equal(outside.ok, false)
    assert.equal(outside.error.code, 'unknown-path')

    assert.deepEqual(await listRoot(root), [INDEX_FILE], 'nothing was written')
  })
})

test('fact-save refuses when the index cannot be read, and when it is full', async () => {
  // Unreadable index: refuse rather than rewrite MEMORY.md from an empty string.
  await withWorkspace(
    { fs: { failingPath: undefined } },
    async ({ workspace }) => {
      const denied = createRealFs({ failingPath: join(memoryRoot(workspace), INDEX_FILE) })
      const plugin = createPlugin(workspace, denied)
      const result = await call(plugin, 'fact-save', {
        path: workspace,
        name: 'prefers-tabs',
        type: 'user',
        description: 'd',
        body: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'index-unreadable')
      assert.deepEqual(await listRoot(memoryRoot(workspace)), [INDEX_FILE], 'the fact file is not written')
    },
  )

  // Full index: the grow guard fires before the pointer is appended.
  const many = ['# Memory', '']
  for (let index = 0; index < 220; index += 1) {
    many.push('- [Fact ' + index + '](fact-' + index + '.md) — hook ' + index)
  }
  await withWorkspace({ index: many.join('\n') + '\n' }, async ({ workspace, root, plugin }) => {
    const result = await call(plugin, 'fact-save', {
      path: workspace,
      name: 'one-more',
      type: 'user',
      description: 'd',
      body: 'b',
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'index-full')
    assert.deepEqual(await listRoot(root), [INDEX_FILE])
  })
})

test('fact-read returns the parsed prefill for the editor', async () => {
  await withWorkspace({ fact: { file: 'prefers-tabs.md', content: seededFact() } }, async ({ workspace, plugin }) => {
    const result = await call(plugin, 'fact-read', { path: workspace, name: 'prefers-tabs' })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.value.name, 'prefers-tabs')
    assert.equal(result.value.fileName, 'prefers-tabs.md')
    assert.equal(result.value.type, 'user')
    assert.equal(result.value.description, 'the user indents with tabs')
    assert.equal(result.value.createdAt, '2020-01-01T00:00:00.000Z')
    assert.equal(result.value.updatedAt, '2020-02-02T00:00:00.000Z')
    assert.equal(result.value.originSessionId, 'sess_origin')
    assert.match(result.value.body, /Tabs everywhere/)

    const missing = await call(plugin, 'fact-read', { path: workspace, name: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'not-found')

    const bad = await call(plugin, 'fact-read', { path: workspace, name: '../MEMORY.md' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'invalid-name')
  })
})

test('fact-delete trashes the file, drops the pointer, and trash-list reports it', async () => {
  const index = SEED_INDEX + '- [Prefers tabs](prefers-tabs.md) — the user indents with tabs\n'
  await withWorkspace(
    { index, fact: { file: 'prefers-tabs.md', content: seededFact() } },
    async ({ workspace, root, plugin }) => {
      const listedBefore = await call(plugin, 'trash-list', { path: workspace })
      assert.equal(listedBefore.ok, true)
      assert.deepEqual(listedBefore.value.entries, [])
      assert.equal(typeof listedBefore.value.keep, 'number')

      const deleted = await call(plugin, 'fact-delete', { path: workspace, name: 'prefers-tabs' })
      assert.equal(deleted.ok, true, JSON.stringify(deleted.error))
      assert.equal(deleted.value.trashed, true)
      assert.equal(deleted.value.removedPointers, 1)
      assert.equal(deleted.value.indexChanged, true)

      assert.deepEqual(await factFiles(root), [], 'the fact file left the memory root')
      const pointers = parseIndexPointers(await readFile(join(root, INDEX_FILE), 'utf8'))
      assert.deepEqual(pointers.map((pointer) => pointer.file), ['editor-default.md'])

      const trashNames = await readdir(join(root, TRASH_DIR))
      assert.deepEqual(trashNames, ['prefers-tabs.md'])
      assert.equal(
        parseFactFrontmatter(await readFile(join(root, TRASH_DIR, 'prefers-tabs.md'), 'utf8')).name,
        'prefers-tabs',
      )

      const listed = await call(plugin, 'trash-list', { path: workspace })
      assert.equal(listed.ok, true, JSON.stringify(listed.error))
      assert.equal(listed.value.entries.length, 1)
      const entry = listed.value.entries[0]
      assert.equal(entry.name, 'prefers-tabs')
      assert.equal(entry.fileName, 'prefers-tabs.md')
      assert.ok(entry.size > 0)
      assert.equal(typeof entry.modifiedAt, 'number')

      // A second delete of the same fact has nothing left to remove.
      const again = await call(plugin, 'fact-delete', { path: workspace, name: 'prefers-tabs' })
      assert.equal(again.ok, false)
      assert.equal(again.error.code, 'not-found')
    },
  )
})

test('trash-restore brings the fact and its pointer back, and refuses a taken name', async () => {
  const index = SEED_INDEX + '- [Prefers tabs](prefers-tabs.md) — the user indents with tabs\n'
  await withWorkspace(
    { index, fact: { file: 'prefers-tabs.md', content: seededFact() } },
    async ({ workspace, root, plugin }) => {
      await call(plugin, 'fact-delete', { path: workspace, name: 'prefers-tabs' })

      const restored = await call(plugin, 'trash-restore', { path: workspace, name: 'prefers-tabs' })
      assert.equal(restored.ok, true, JSON.stringify(restored.error))
      assert.equal(restored.value.restored, true)
      assert.equal(restored.value.indexChanged, true)

      assert.deepEqual(await factFiles(root), ['prefers-tabs.md'])
      const frontmatter = parseFactFrontmatter(await readFile(join(root, 'prefers-tabs.md'), 'utf8'))
      assert.equal(frontmatter.name, 'prefers-tabs')
      assert.equal(frontmatter.createdAt, '2020-01-01T00:00:00.000Z', 'history survives the round trip')

      const pointers = parseIndexPointers(await readFile(join(root, INDEX_FILE), 'utf8'))
      assert.deepEqual(pointers.map((pointer) => pointer.file).sort(), ['editor-default.md', 'prefers-tabs.md'])
      assert.equal(pointers.find((pointer) => pointer.file === 'prefers-tabs.md').hook, 'the user indents with tabs')

      // The trash copy is gone, so a second restore is a clean not-found.
      const twice = await call(plugin, 'trash-restore', { path: workspace, name: 'prefers-tabs' })
      assert.equal(twice.ok, false)
      assert.equal(twice.error.code, 'not-found')

      // Recreating the fact makes the name taken: restore refuses, no clobber.
      await call(plugin, 'fact-save', {
        path: workspace,
        name: 'prefers-tabs',
        type: 'user',
        description: 'recreated by hand',
        body: 'A fresh fact with the same name.',
      })
      await call(plugin, 'fact-delete', { path: workspace, name: 'prefers-tabs' })
      await writeFile(
        join(root, 'prefers-tabs.md'),
        seededFact({ description: 'the live one wins' }),
        'utf8',
      )
      const refused = await call(plugin, 'trash-restore', { path: workspace, name: 'prefers-tabs' })
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'already-exists')
      assert.equal(
        parseFactFrontmatter(await readFile(join(root, 'prefers-tabs.md'), 'utf8')).description,
        'the live one wins',
        'the live fact is never overwritten',
      )
    },
  )
})

test('every fact endpoint contracts its failures for bad names and hidden workspaces', async () => {
  await withWorkspace({}, async ({ workspace, plugin }) => {
    for (const endpoint of ['fact-read', 'fact-delete', 'trash-restore']) {
      const badName = await call(plugin, endpoint, { path: workspace, name: '../etc/passwd' })
      assert.equal(badName.ok, false, endpoint)
      assert.equal(badName.error.code, 'invalid-name', endpoint)

      const hidden = await call(plugin, endpoint, { path: 'C:/elsewhere', name: 'ok-name' })
      assert.equal(hidden.ok, false, endpoint)
      assert.equal(hidden.error.code, 'unknown-path', endpoint)
    }

    const hiddenList = await call(plugin, 'trash-list', { path: 'C:/elsewhere' })
    assert.equal(hiddenList.ok, false)
    assert.equal(hiddenList.error.code, 'unknown-path')

    const noPath = await call(plugin, 'trash-list', {})
    assert.equal(noPath.ok, false)
    assert.equal(noPath.error.code, 'invalid-path')
  })

  // A disposed plugin never resolves a workspace, so the path fails first and
  // no endpoint reaches the filesystem.
  const plugin = { disposed: true, bySession: new Map(), ctx: { get: () => undefined }, config: {} }
  const disabled = await call(plugin, 'trash-list', { path: 'C:/anything' })
  assert.equal(disabled.ok, false)
  assert.ok(['disabled', 'unknown-path', 'invalid-path'].includes(disabled.error.code), disabled.error.code)
})
