/**
 * Verification helper (Lead-owned, roadmap D7): validate one exported snapshot
 * directory the way an import would — manifest shape, layer names, file names
 * and content checksums — without touching a memory root.
 *
 * Usage: node scripts/verify-snapshot.mjs <exportDir>
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isIndexFile, parseFactFileName } from '../lib/memory-core.js'

const EXPORT_FORMAT = 'dsh-workspace-memory-export'
const EXPORT_VERSION = 1
const MAX_FILES = 5000

const dir = process.argv[2]
if (typeof dir !== 'string' || dir.length === 0) {
  console.error('usage: node scripts/verify-snapshot.mjs <exportDir>')
  process.exit(2)
}

const problems = []

const fail = (message) => problems.push(message)

const read = (path, label) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail('cannot read ' + label + ': ' + String(error?.code ?? error))
    return undefined
  }
}

const manifestText = read(join(dir, 'manifest.json'), 'manifest.json')
let manifest
if (manifestText !== undefined) {
  try {
    manifest = JSON.parse(manifestText)
  } catch (_error) {
    fail('manifest.json is not valid JSON')
  }
}
if (manifest !== undefined) {
  if (manifest.format !== EXPORT_FORMAT) fail('unexpected format: ' + String(manifest.format))
  if (manifest.version !== EXPORT_VERSION) fail('unsupported version: ' + String(manifest.version))
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) fail('manifest carries no layers')
  for (const layer of Array.isArray(manifest.layers) ? manifest.layers : []) {
    if (!layer || (layer.layer !== 'workspace' && layer.layer !== 'global')) {
      fail('unknown layer: ' + String(layer?.layer))
      continue
    }
    if (!Array.isArray(layer.files) || layer.files.length === 0) {
      fail('layer ' + layer.layer + ' carries no files')
      continue
    }
    if (layer.files.length > MAX_FILES) fail('layer ' + layer.layer + ' carries too many files')
    const seen = new Set()
    for (const file of layer.files) {
      const name = file?.name
      if (typeof name !== 'string' || name.length === 0) {
        fail('file entry without a name in layer ' + layer.layer)
        continue
      }
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        fail('unsafe file name: ' + name)
        continue
      }
      const expected = isIndexFile(name) ? 'index' : parseFactFileName(name) === undefined ? undefined : 'fact'
      if (expected === undefined) fail('not a memory file name: ' + name)
      else if (file.kind !== expected) fail('kind mismatch for ' + name + ' (expected ' + expected + ')')
      if (seen.has(name)) fail('duplicate file name in layer ' + layer.layer + ': ' + name)
      seen.add(name)
      const content = read(join(dir, layer.layer, name), layer.layer + '/' + name)
      if (content === undefined) continue
      if (typeof file.bytes === 'number' && file.bytes !== Buffer.byteLength(content, 'utf8')) {
        fail('byte count mismatch for ' + name)
      }
      if (typeof file.sha256 === 'string') {
        const digest = createHash('sha256').update(content, 'utf8').digest('hex')
        if (digest !== file.sha256) fail('checksum mismatch for ' + name)
      }
    }
  }
}

const layers = Array.isArray(manifest?.layers)
  ? manifest.layers.map((layer) => ({ layer: layer?.layer, files: Array.isArray(layer?.files) ? layer.files.length : 0 }))
  : []
const fileCount = layers.reduce((total, layer) => total + layer.files, 0)
console.log(JSON.stringify({ dir, ok: problems.length === 0, createdAt: manifest?.createdAt ?? '', fileCount, layers, problems }, null, 2))
process.exit(problems.length === 0 ? 0 : 1)
