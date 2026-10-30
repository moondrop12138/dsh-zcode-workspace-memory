import test from 'node:test'
import assert from 'node:assert/strict'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildManifest,
  evaluateIndexReplacement,
  parseFactFileName,
  parseFactFrontmatter,
  parseIndexPointers,
  renderFactFile,
  renderMemorySection,
  upsertPointer,
} from '../lib/memory-core.js'

const FACT_NAME = 'workspace-memory-index-overwrite-bug'
const FACT_FILE = `${FACT_NAME}.md`
const FACT_TITLE = '工作区记忆的索引覆盖 bug 已修复'
const FACT_HOOK =
  '旧档案“读失败当空索引整体覆盖 MEMORY.md”已在 v0.1.3 前修复（readFileState 区分 missing/error、applyExtraction 索引不可读即中止），' +
  'v0.1.4 起 evaluateIndexReplacement 另做指针集合 diff；别再当未修复问题排查'

function factObject() {
  return {
    name: FACT_NAME,
    description: '工作区记忆的索引覆盖 bug 已修复：v0.1.3 前已区分 missing/error 并中止写入，v0.1.4 起另有内容级 diff 守卫（A3）',
    type: 'project',
    body: [
      '2026-10-23 曾记录：lib/host.js 把索引读失败当成空索引，但该 bug 已在 v0.1.3 之前修复，v0.1.4 起又加了内容级守卫。',
      '',
      '- `readFileState`（lib/host.js）返回 `ok|missing|error` 三态：只有 missing 视为空索引，error（权限/IO 失败）会让 `applyExtraction` 在写索引前中止并记日志。',
      '- `evaluateIndexReplacement`（lib/memory-core.js）在行数下限之上加了指针集合 diff：after 中每个指针行要么存在于 before，要么属于本轮 plan 的 writes。',
    ].join('\n'),
    why: '旧档案声称“索引覆盖 bug 未修”已过时；留着会误导后续会话重复排查一个已修复的问题。',
    howToApply: '遇到“索引被覆盖/丢指针”的怀疑时，先检查 readFileState 与 evaluateIndexReplacement 的现状与日志，不要按旧档案结论当作未修复问题重新排查。',
  }
}

// This suite is the plugin's first dogfood: it validates the real workspace
// memory archive against the frozen protocol using the plugin's own pure
// functions. The archive lives outside the repo and is not shipped, so when it
// is absent (fresh clone, CI runner) the real-archive cases skip instead of
// failing.
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WORKSPACE = resolve(REPO_ROOT, '..')
const MEMORY_DIR = join(WORKSPACE, '.dsh', 'memory')
const ARCHIVE_PRESENT = existsSync(join(MEMORY_DIR, 'MEMORY.md'))

test('dogfood: renderFactFile round-trips through parseFactFrontmatter', () => {
  const text = renderFactFile(factObject())
  assert.ok(text.length > 0)
  assert.ok(text.endsWith('\n'))
  assert.ok(!text.includes('\r'))

  const frontmatter = parseFactFrontmatter(text)
  assert.equal(frontmatter?.name, FACT_NAME)
  assert.equal(frontmatter?.type, 'project')
  assert.ok(frontmatter?.description?.includes('v0.1.3 前已区分 missing/error'))

  assert.equal(parseFactFileName(FACT_FILE), FACT_NAME)
})

test('dogfood: upsertPointer keeps one pointer per fact and is idempotent', () => {
  const first = upsertPointer('', { title: FACT_TITLE, file: FACT_FILE, hook: FACT_HOOK })
  assert.equal(parseIndexPointers(first).length, 1)
  assert.equal(first.endsWith('\n'), true)

  // A second run must not add a duplicate line for the same file.
  const second = upsertPointer(first, { title: FACT_TITLE, file: FACT_FILE, hook: FACT_HOOK })
  assert.equal(second, first)
  assert.equal(parseIndexPointers(second).filter((entry) => entry.file === FACT_FILE).length, 1)

  // An unrelated pointer survives untouched, and the fact line goes last.
  const base = '- [Earlier](earlier.md) — earlier hook\n'
  const mixed = upsertPointer(base, { title: FACT_TITLE, file: FACT_FILE, hook: FACT_HOOK })
  const lines = parseIndexPointers(mixed)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].file, 'earlier.md')
  assert.equal(lines[1].file, FACT_FILE)
  assert.equal(parseIndexPointers(base).length, 1)
})

test('dogfood: the content-diff guard accepts this fact upsert and refuses strangers', () => {
  const before = '- [Earlier](earlier.md) — earlier hook\n'
  const after = upsertPointer(before, { title: FACT_TITLE, file: FACT_FILE, hook: FACT_HOOK })

  // The real operation this item performed: append one new pointer for a file
  // written in the same run. Growth covered by a write is allowed.
  assert.equal(evaluateIndexReplacement(before, after, [], [FACT_FILE]).ok, true)

  // The overwrite bug's modern form: the same pointer count but an unrelated
  // line replaced the earlier one.
  const swapped = after.replace('earlier.md', 'stranger.md').replace('earlier hook', 'stranger hook')
  const swappedVerdict = evaluateIndexReplacement(before, swapped, [])
  assert.equal(swappedVerdict.ok, false)
  assert.match(swappedVerdict.reason, /introduces a pointer for stranger\.md/)

  // Silently losing a line is still refused regardless of writes.
  assert.equal(evaluateIndexReplacement(after, before, [], [FACT_FILE]).ok, false)
})

test('dogfood: protocol round-trip in a temp workspace memory dir', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'dsh-dogfood-')), '.dsh', 'memory')
  mkdirSync(root, { recursive: true })
  try {
    writeFileSync(join(root, FACT_FILE), renderFactFile(factObject()), 'utf8')
    writeFileSync(join(root, 'MEMORY.md'), upsertPointer('', { title: FACT_TITLE, file: FACT_FILE, hook: FACT_HOOK }), 'utf8')

    const facts = [{ fileName: FACT_FILE, content: readFileSync(join(root, FACT_FILE), 'utf8') }]
    const manifest = buildManifest(facts)
    assert.equal(manifest.length, 1)
    assert.equal(manifest[0].name, FACT_NAME)
    assert.ok(manifest[0].description.includes('内容级 diff 守卫'))

    const section = renderMemorySection({ root, rawIndex: readFileSync(join(root, 'MEMORY.md'), 'utf8') })
    assert.ok(section.text.includes('Contents of'))
    assert.ok(section.text.includes(`- [${FACT_TITLE}](${FACT_FILE})`))
    assert.equal(section.indexLineCount, 1)
  } finally {
    rmSync(join(root, '..', '..'), { recursive: true, force: true })
  }
})

test('dogfood: the real archive fact file matches the frozen protocol', { skip: !ARCHIVE_PRESENT }, () => {
  const content = readFileSync(join(MEMORY_DIR, FACT_FILE), 'utf8')
  assert.ok(content.endsWith('\n'))
  assert.ok(!content.includes('\r'))

  const frontmatter = parseFactFrontmatter(content)
  assert.equal(frontmatter?.name, FACT_NAME)
  assert.equal(frontmatter?.type, 'project')
  assert.ok(frontmatter?.description?.includes('v0.1.4 起另有内容级 diff 守卫'))

  const manifest = buildManifest([{ fileName: FACT_FILE, content }])
  assert.equal(manifest.length, 1)

  assert.equal(parseFactFileName(FACT_FILE), FACT_NAME)
})

test('dogfood: the real archive index carries exactly one pointer for the fact', { skip: !ARCHIVE_PRESENT }, () => {
  const indexText = readFileSync(join(MEMORY_DIR, 'MEMORY.md'), 'utf8')
  const pointers = parseIndexPointers(indexText).filter((entry) => entry.file === FACT_FILE)
  assert.equal(pointers.length, 1)
  assert.equal(pointers[0].title, FACT_TITLE)
  assert.equal(pointers[0].hook, FACT_HOOK)
})

test('dogfood: the guard accepts the real archive state as a no-op replacement', { skip: !ARCHIVE_PRESENT }, () => {
  const indexText = readFileSync(join(MEMORY_DIR, 'MEMORY.md'), 'utf8')

  // The archive as shipped is a valid replacement of itself: same pointers,
  // no rewrites.
  assert.equal(evaluateIndexReplacement(indexText, indexText, []).ok, true)

  // Appending this fact's pointer to the pre-dogfood index (with the fact
  // written this run) is exactly what this item did, and must stay legal.
  const beforeDogfood = removePointerLine(indexText, FACT_FILE)
  const after = upsertPointer(beforeDogfood, { title: FACT_TITLE, file: FACT_FILE, hook: FACT_HOOK })
  const verdict = evaluateIndexReplacement(beforeDogfood, after, [], [FACT_FILE])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.afterCount, verdict.beforeCount + 1)
})

/**
 * Drop the fact's pointer line so a test can replay the pre-dogfood index.
 * @param {string} indexText
 * @param {string} file
 * @returns {string}
 */
function removePointerLine(indexText, file) {
  const pointers = parseIndexPointers(indexText).filter((entry) => entry.file !== file)
  return pointers.length === 0 ? '' : `${pointers.map((p) => `- [${p.title}](${p.file}) — ${p.hook}`).join('\n')}\n`
}
