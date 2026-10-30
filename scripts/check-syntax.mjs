/**
 * Syntax lint: parse every JS source as an ES module without executing it.
 *
 * `node --check` is not usable here: for `.js` sources its module handling is
 * not deterministic across versions — on this repo (Node 24, package
 * `type: module`) an invalid ESM `.js` file exits 0, and `--input-type=module`
 * cannot be combined with a file argument — so the check parses sources
 * itself: `vm.SourceTextModule` constructs the module record from the source
 * text (a parse, never an evaluation) and throws on any syntax error.
 *
 * SourceTextModule is only defined under `--experimental-vm-modules`, so the
 * script re-spawns itself with that flag when it is missing. Zero dependencies.
 *
 * Usage: node scripts/check-syntax.mjs
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))
// Optional argv override: a directory (relative to the repo root) to check
// instead of the default targets — used by the test suite to probe failures.
const overrideDir = process.argv[2]
const targets = overrideDir
  ? [{ dir: overrideDir, exts: ['.js', '.mjs'] }]
  : [
      { dir: 'lib', exts: ['.js'] },
      { dir: 'test', exts: ['.js', '.mjs'] },
      { dir: 'scripts', exts: ['.js', '.mjs'] },
    ]

/** Every JS file under `dir` (recursive for lib/ subdirectories). */
async function listFiles(dir, exts) {
  const out = []
  const base = isAbsolute(dir) ? dir : join(root, dir)
  const queue = [base]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full)
    }
  }
  return out.sort()
}

/** Parse `source` as a module record; throws on syntax errors, never evaluates. */
function parseModule(source, id) {
  new vm.SourceTextModule(source, { identifier: id })
}

const isFlagged = typeof vm.SourceTextModule === 'function'

/* ------------------------------------------------- parent: spawn flagged child */

if (!isFlagged) {
  const { spawnSync } = await import('node:child_process')
  const self = fileURLToPath(import.meta.url)
  const args = ['--experimental-vm-modules', self, ...process.argv.slice(2)]
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

/* ------------------------------------------------------------ flagged child */

const failures = []
let checked = 0

for (const { dir, exts } of targets) {
  for (const file of await listFiles(dir, exts)) {
    checked += 1
    const source = await readFile(file, 'utf8')
    try {
      parseModule(source, relative(root, file).split(sep).join('/'))
    } catch (error) {
      failures.push(`${relative(root, file)}: ${error.message}`)
    }
  }
}

if (checked === 0) failures.push('no JS files found — the target list is stale')

for (const failure of failures) console.error(`✗ ${failure}`)
console.log(`${checked - failures.length}/${checked} files parse as ES modules`)

if (failures.length > 0) process.exit(1)
