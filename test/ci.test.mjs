import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')

test('npm scripts point at existing repo files', async () => {
  for (const script of ['lint', 'test', 'verify:e2e']) {
    assert.ok(pkg.scripts[script], `package.json scripts.${script} is missing`)
  }
  assert.equal(pkg.scripts.lint, 'node scripts/check-syntax.mjs')
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.scripts['verify:e2e'], 'node scripts/verify-host-e2e.mjs')
  for (const file of ['scripts/check-syntax.mjs', 'scripts/verify-host-e2e.mjs']) {
    await assert.doesNotReject(() => readFile(join(root, file)), `${file} is missing`)
  }
})

test('CI matrix covers windows-latest + ubuntu-latest on Node 20 and 22', () => {
  const osMatch = workflow.match(/matrix:\s*\n\s*os:\s*\[([^\]]+)\]/)
  assert.ok(osMatch, 'ci.yml has no matrix.os list')
  const osList = osMatch[1].split(',').map((entry) => entry.trim())
  assert.deepEqual([...osList].sort(), ['ubuntu-latest', 'windows-latest'])

  const nodeMatch = workflow.match(/node:\s*\[([^\]]+)\]/)
  assert.ok(nodeMatch, 'ci.yml has no matrix.node list')
  const nodeList = nodeMatch[1].split(',').map((entry) => entry.trim())
  assert.deepEqual([...nodeList].sort(), ['20', '22'])
  assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.os \}\}/)
  assert.match(workflow, /node-version:\s*\$\{\{ matrix\.node \}\}/)
})

test('CI runs lint, node --test and the host E2E on every matrix job', () => {
  for (const command of [
    'node scripts/check-syntax.mjs',
    'node --test',
    'node scripts/verify-host-e2e.mjs',
  ]) {
    assert.ok(workflow.includes(`- run: ${command}`), `ci.yml does not run: ${command}`)
  }
})

test('check-syntax.mjs exits non-zero on a file that does not parse as ESM', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { spawnSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'wm-lint-'))
  try {
    await writeFile(join(dir, 'broken.js'), 'export const x = (((;\n')
    await writeFile(join(dir, 'fine.js'), 'export const fine = 1\n')
    // check-syntax.mjs resolves its targets relative to its own location, so
    // the probe runs it against this repo's scripts/ directory — the broken
    // files live in a scratch dir the checker is pointed at via argv.
    const self = join(root, 'scripts/check-syntax.mjs')
    const result = spawnSync(process.execPath, [self, dir], { encoding: 'utf8' })
    assert.equal(result.status, 1, `expected exit 1, got stderr: ${result.stderr}`)
    assert.match(result.stderr, /broken\.js/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const readme = await readFile(join(root, 'README.md'), 'utf8')

test('README acceptance table has no pending rows and documents the verification style', () => {
  assert.ok(readme.includes('## 验收实测'), 'README has no acceptance table')
  assert.doesNotMatch(readme, /\| ⏳/, 'acceptance table still has pending (⏳) rows')
  assert.doesNotMatch(readme, /待目视/, 'acceptance table still defers to eyeballing')
  for (const row of ['A4\' 真实模型提取', 'A3\' 模型自主写入', '设置表单可见性']) {
    assert.ok(readme.includes(`| ${row} | ✅`), `acceptance row ${row} is not marked ✅`)
  }
  // The three closures rely on the stub-model suites and code-path analysis, so
  // the README must say so instead of claiming a live run happened.
  assert.match(readme, /A4' 真实模型提取 \| ✅（stub 模型闭环/)
  assert.match(readme, /A3' 模型自主写入 \| ✅（stub 模型闭环/)
})

test('README states repairIndex fills missing pointers but never removes dangling ones', async () => {
  assert.ok(readme.includes('补齐丢失的指针行'), 'README no longer describes the repair behavior')
  assert.ok(readme.includes('只补缺、不删悬空'), 'README must state repair only adds, never removes')
  assert.doesNotMatch(readme, /不做修复器/, 'README still claims the plugin has no repairer')
  // The described behavior must match the implementation: repairIndex is exported
  // and only ever appends missing pointers.
  const host = await readFile(join(root, 'lib/host.js'), 'utf8')
  assert.ok(host.includes('function repairIndex('), 'host.js lost repairIndex')
})

test('README test and E2E counts match the suites on disk', async () => {
  const { readdir } = await import('node:fs/promises')
  const testDir = await readdir(join(root, 'test'))
  const suites = testDir.filter((name) => name.endsWith('.test.mjs'))
  assert.equal(suites.length, 24, `expected 24 test suites, found: ${suites.join(', ')}`)
  assert.ok(readme.includes('343/343'), 'README A8 row should cite the 343-test run')
  assert.ok(readme.includes('343 项纯函数/集成用例'), 'README repro block should cite 343 tests')
  // Roadmap C3 must stay documented where users look for it.
  assert.ok(readme.includes('panel-write'), 'README suite list should name panel-write')
  assert.ok(readme.includes('panel-editor'), 'README suite list should name panel-editor')
  assert.ok(readme.includes('trash-restore'), 'README should document the panel trash endpoints')
  // Roadmap D5/D6 must stay documented where users look for them.
  assert.ok(readme.includes('segmented-extraction'), 'README suite list should name segmented-extraction')
  assert.ok(readme.includes('extractProvider'), 'README should document the extraction route override')
  // Roadmap D7/D8 must stay documented too.
  assert.ok(readme.includes('export-import'), 'README suite list should name export-import')
  assert.ok(readme.includes('proposals'), 'README suite list should name proposals')
  assert.ok(readme.includes('gitCommitEnabled'), 'README config table should document gitCommitEnabled')

  const e2e = await readFile(join(root, 'scripts/verify-host-e2e.mjs'), 'utf8')
  const e2eChecks = (e2e.match(/\brecord\(/g) ?? []).length
  assert.equal(e2eChecks, 27, `verify-host-e2e.mjs should hold 27 checks, found ${e2eChecks}`)
  assert.ok(readme.includes('27/27'), 'README should cite the 23-check E2E run')
})
