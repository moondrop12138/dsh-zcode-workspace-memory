/**
 * W1 — "possibly related existing memories" for the extraction prompt.
 *
 * Adapted from ZCode `apps/zcode-cli/packages/core/src/memory/recall-selector.ts`
 * (Apache-2.0). Changes: ZCode runs an auxiliary model to pick memory files
 * before a turn, and the extraction agent walks its own Read/Grep self-check.
 * This port keeps the intent — look at what is already stored before writing —
 * but ranks the extraction manifest deterministically with the D3 keyword
 * scorer (no model call, no embeddings, no I/O) and renders the picks as a
 * prompt block, so an overlapping fact is steered onto the existing file at
 * write time instead of after the fact.
 *
 * Everything here is pure and frozen in `docs/alignment/w1-related.md`.
 */

import {
  conflictExcerpt,
  factFileName,
  queryTermsForRanking,
  scoreIndexPointer,
} from './memory-core.js'

/** How many related entries the block keeps at most. */
export const RELATED_MEMORY_LIMIT = 8

/** Per-entry excerpt cap (chars), applied after {@link conflictExcerpt} flattens it. */
export const RELATED_MEMORY_EXCERPT_CHARS = 400

/** Whole-block budget (chars), heading and note included. */
export const RELATED_MEMORY_TOTAL_CHARS = 3200

/** Heading of the rendered block. */
export const RELATED_MEMORY_HEADING = '## Possibly related existing memories'

/** The one-line instruction under the heading. */
const RELATED_MEMORY_NOTE =
  'These existing memories overlap with this conversation. If one already covers a fact, '
  + 'update that file and reuse its name instead of creating a near-duplicate. '
  + 'Read it before overwriting.'

/** Notice appended when entries are withheld. */
const RELATED_MEMORY_OMITTED_PREFIX = '(+'
const RELATED_MEMORY_OMITTED_SUFFIX = ' more related memories not shown)'

/**
 * Coerce a caller-supplied limit/budget to a non-negative integer.
 * @param {unknown} value
 * @param {number} fallback used when `value` is not a finite number
 * @returns {number}
 */
function asCount(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value))
}

/**
 * One manifest entry in the shape both exported functions return and render.
 * Malformed entries (no usable name) are dropped: a nameless memory cannot be
 * reused by name, which is the whole point of the block.
 * @param {unknown} entry a `buildManifest` item (or anything shaped like one)
 * @returns {{ name: string, description: string, excerpt: string } | undefined}
 */
function normalizeRelatedEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name.length === 0) return undefined
  const description = typeof entry.description === 'string'
    ? entry.description.replace(/\s+/gu, ' ').trim()
    : ''
  const excerpt = typeof entry.excerpt === 'string' ? entry.excerpt : ''
  return { name, description, excerpt }
}

/**
 * Code-point ordering for the tie-break. `localeCompare` would make the order
 * depend on the host locale, so it is deliberately not used.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareName(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * W1: pick the existing memories whose index pointer overlaps the conversation.
 *
 * The manifest has no pointer lines, so each entry is scored through a shadow
 * pointer `{ file, title, hook }` built from its own fields — `scoreIndexPointer`
 * is reused untouched, which keeps the weighting (title ×2, hook ×1, file ×1)
 * identical to the D3 injection ranking.
 * @param {Array<{ name: string, description?: string, excerpt?: string }> | undefined} manifest
 *   output of `buildManifest`
 * @param {unknown} queryText the turn transcript or other query text
 * @param {number} [limit] how many entries to keep
 * @returns {Array<{ name: string, description: string, excerpt: string }>}
 *   score-descending, name-ascending on ties; `[]` when nothing overlaps
 */
export function rankRelatedMemories(manifest, queryText, limit = RELATED_MEMORY_LIMIT) {
  const entries = Array.isArray(manifest) ? manifest : []
  const terms = queryTermsForRanking(queryText)
  if (entries.length === 0 || terms.length === 0) return []
  const scored = []
  for (const raw of entries) {
    const entry = normalizeRelatedEntry(raw)
    if (entry === undefined) continue
    const score = scoreIndexPointer({
      file: factFileName(entry.name),
      title: entry.name,
      hook: entry.description,
    }, terms)
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score || compareName(a.entry.name, b.entry.name))
  return scored
    .slice(0, asCount(limit, RELATED_MEMORY_LIMIT))
    .map((hit) => hit.entry)
}

/**
 * One entry's excerpt: flattened to a single line by {@link conflictExcerpt},
 * then cut to {@link RELATED_MEMORY_EXCERPT_CHARS} with a trailing ellipsis.
 * @param {string} text
 * @returns {string}
 */
function excerptLine(text) {
  // The cap is passed as "no cap" on purpose: the flattening is shared with the
  // conflict prompt, but the cut belongs to the 400-char budget below.
  const single = conflictExcerpt(text, Number.MAX_SAFE_INTEGER)
  if (single.length <= RELATED_MEMORY_EXCERPT_CHARS) return single
  return `${single.slice(0, RELATED_MEMORY_EXCERPT_CHARS).trimEnd()}…`
}

/**
 * One entry as prompt lines: the bullet, then the excerpt indented two spaces.
 * @param {{ name: string, description: string, excerpt: string }} entry
 * @returns {string}
 */
function renderRelatedEntry(entry) {
  const head = entry.description.length === 0
    ? `- ${entry.name}`
    : `- ${entry.name} — ${entry.description}`
  const excerpt = excerptLine(entry.excerpt)
  return excerpt.length === 0 ? head : `${head}\n  ${excerpt}`
}

/**
 * Render a prefix of the ranked list, plus the omitted notice when a tail was
 * withheld. The notice counts against `totalChars` like any other line.
 * @param {Array<{ name: string, description: string, excerpt: string }>} entries
 * @param {number} count how many leading entries to render
 * @returns {string}
 */
function composeRelatedBlock(entries, count) {
  const omitted = entries.length - count
  const parts = [RELATED_MEMORY_HEADING, RELATED_MEMORY_NOTE, '', entries.slice(0, count).map(renderRelatedEntry).join('\n\n')]
  if (omitted > 0) {
    parts.push('', `${RELATED_MEMORY_OMITTED_PREFIX}${omitted}${RELATED_MEMORY_OMITTED_SUFFIX}`)
  }
  return parts.join('\n')
}

/**
 * W1: render the related-memories prompt block.
 *
 * Returns `''` for no entries so a caller can append the result unconditionally
 * and leave the prompt byte-identical when there is nothing to say. Character
 * accounting is UTF-16 code units against {@link RELATED_MEMORY_TOTAL_CHARS}.
 * When the budget cuts entries the tail is dropped in score order and a
 * `(+N more related memories not shown)` line is appended; at least one entry
 * survives even when a single entry alone exceeds the budget.
 * @param {Array<{ name: string, description?: string, excerpt?: string }> | undefined} entries
 *   output of {@link rankRelatedMemories}
 * @param {{ limit?: number, totalChars?: number }} [options] overrides for the
 *   defaults; `limit` lower than the entry count also triggers the notice
 * @returns {string}
 */
export function renderRelatedMemories(entries, options = {}) {
  const list = Array.isArray(entries)
    ? entries.map(normalizeRelatedEntry).filter((entry) => entry !== undefined)
    : []
  if (list.length === 0) return ''
  const settings = options ?? {}
  const limit = Math.min(asCount(settings.limit, RELATED_MEMORY_LIMIT), list.length)
  if (limit === 0) return ''
  const totalChars = asCount(settings.totalChars, RELATED_MEMORY_TOTAL_CHARS)
  let count = 1
  for (let candidate = 1; candidate <= limit; candidate += 1) {
    if (composeRelatedBlock(list, candidate).length > totalChars) break
    count = candidate
  }
  return composeRelatedBlock(list, count)
}
