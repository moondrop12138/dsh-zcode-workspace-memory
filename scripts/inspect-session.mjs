/**
 * Verification helper (Lead-owned, not shipped in the plugin `files` list).
 *
 * Decode a DSH session artifact into JSONL and report the workspace-memory
 * facts we need for acceptance:
 *   - the latest `system/message` text and whether it carries the `# Memory` section
 *   - turn/end reasons
 *   - assistant/user message counts
 *
 * Usage: node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [needle]
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress a possibly multi-frame zstd file (DSH appends one frame per flush).
 * @param {Buffer} bytes
 * @returns {string}
 */
function decodeZstdFrames(bytes) {
  const frames = []
  let index = 0
  while (index < bytes.length) {
    const start = bytes.indexOf(MAGIC, index)
    if (start < 0) break
    let end = bytes.indexOf(MAGIC, start + 4)
    while (end >= 0) {
      try {
        frames.push(zstdDecompressSync(bytes.subarray(start, end)))
        break
      } catch (_error) {
        end = bytes.indexOf(MAGIC, end + 1)
      }
    }
    if (end < 0) {
      try {
        frames.push(zstdDecompressSync(bytes.subarray(start)))
      } catch (_error) {
        // A truncated tail frame is not decodable; stop here.
      }
      break
    }
    index = end
  }
  return Buffer.concat(frames).toString('utf8')
}

const path = process.argv[2]
const needle = process.argv[3] ?? '# Memory'
if (typeof path !== 'string') {
  console.error('usage: node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [needle]')
  process.exit(2)
}

const text = decodeZstdFrames(readFileSync(path))
const events = []
for (const line of text.split('\n')) {
  const trimmed = line.trim()
  if (trimmed.length === 0) continue
  try {
    events.push(JSON.parse(trimmed))
  } catch (_error) {
    // Skip a partial trailing line.
  }
}

const systems = events.filter((event) => event.type === 'system/message')
const lastSystem = systems.at(-1)
const lastSystemText = lastSystem?.data?.message?.content
  ?.filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n') ?? ''

const turnEnds = events.filter((event) => event.type === 'turn/end').map((event) => event.data?.reason?.kind)
const userMessages = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
const assistantMessages = events.filter((event) => event.type === 'assistant/message')

const report = {
  events: events.length,
  systemNodes: systems.length,
  lastSystemHasNeedle: lastSystemText.includes(needle),
  lastSystemLength: lastSystemText.length,
  lastSystemHead: lastSystemText.slice(0, 400),
  turnEnds,
  userMessages: userMessages.length,
  userMessageSources: events
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data?.source?.kind ?? '(none)')
    .reduce((counts, kind) => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return counts
    }, {}),
  assistantMessages: assistantMessages.length,
  memorySectionExcerpt: (() => {
    const at = lastSystemText.indexOf(needle)
    return at < 0 ? '' : lastSystemText.slice(at, at + 700)
  })(),
}
console.log(JSON.stringify(report, null, 2))
