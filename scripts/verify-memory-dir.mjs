/**
 * Verification helper (Lead-owned): validate one workspace's memory directory
 * against the frozen protocol using the plugin's own pure functions.
 *
 * Usage: node scripts/verify-memory-dir.mjs <workspaceRoot>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildManifest,
  memoryRoot,
  parseFactFileName,
  parseFactFrontmatter,
  renderMemorySection,
} from '../lib/memory-core.js'

const workspace = process.argv[2]
if (typeof workspace !== 'string' || workspace.length === 0) {
  console.error('usage: node scripts/verify-memory-dir.mjs <workspaceRoot>')
  process.exit(2)
}

const root = memoryRoot(workspace)
let entries = []
try {
  entries = readdirSync(root)
} catch (error) {
  console.log(JSON.stringify({ root, exists: false, error: String(error?.code ?? error) }, null, 2))
  process.exit(0)
}

const accepted = entries.filter((name) => name === 'MEMORY.md' || parseFactFileName(name) !== undefined)
const rejected = entries.filter((name) => !accepted.includes(name))
const facts = accepted
  .filter((name) => name !== 'MEMORY.md')
  .map((name) => ({ fileName: name, content: readFileSync(join(root, name), 'utf8') }))

let indexText = ''
try {
  indexText = readFileSync(join(root, 'MEMORY.md'), 'utf8')
} catch (_error) {
  indexText = ''
}

const section = renderMemorySection({ root, rawIndex: indexText })

console.log(JSON.stringify({
  root,
  entries,
  accepted,
  rejected,
  manifest: buildManifest(facts),
  frontmatter: facts.map((fact) => ({ fileName: fact.fileName, ...parseFactFrontmatter(fact.content) })),
  sizes: accepted.map((name) => ({ name, bytes: statSync(join(root, name)).size })),
  injectedIndexBlock: section.text.slice(section.text.indexOf('Contents of')),
  sectionStartsWithRules: section.text.startsWith('# Memory'),
}, null, 2))
