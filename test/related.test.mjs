/**
 * W1 — "possibly related existing memories" before the extraction write.
 *
 * The extraction prompt lists existing file names and one-line descriptions.
 * That is enough to spot an exact name collision but not enough to notice that
 * this turn is about something an older fact already covers under a different
 * name — which is exactly the Read/Grep self-check ZCode's extraction agent
 * does. These tests freeze the deterministic stand-in: keyword-overlap ranking
 * over the manifest, after the D3 scorer, rendered as a bounded prompt block.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildManifest,
  renderFactFile,
} from '../lib/memory-core.js'
import {
  RELATED_MEMORY_EXCERPT_CHARS,
  RELATED_MEMORY_HEADING,
  RELATED_MEMORY_LIMIT,
  RELATED_MEMORY_TOTAL_CHARS,
  rankRelatedMemories,
  renderRelatedMemories,
} from '../lib/related.js'

/** The note line, copied verbatim from the contract. */
const NOTE =
  'These existing memories overlap with this conversation. If one already covers a fact, '
  + 'update that file and reuse its name instead of creating a near-duplicate. '
  + 'Read it before overwriting.'

/** Count the bullet lines of a rendered block. */
function bulletCount(text) {
  return (text.match(/^- /gm) ?? []).length
}

/* ------------------------------------------------------------------- ranking */

test('rankRelatedMemories returns [] for an empty manifest', () => {
  assert.deepEqual(rankRelatedMemories([], 'tabs and spaces'), [])
  assert.deepEqual(rankRelatedMemories(undefined, 'tabs and spaces'), [])
  assert.deepEqual(rankRelatedMemories(null, 'tabs and spaces'), [])
})

test('rankRelatedMemories returns [] when the query carries no ranking terms', () => {
  const manifest = [{ name: 'prefers-tabs', description: 'tabs over spaces', excerpt: 'x' }]
  assert.deepEqual(rankRelatedMemories(manifest, ''), [])
  assert.deepEqual(rankRelatedMemories(manifest, 'the and of'), [])
  assert.deepEqual(rankRelatedMemories(manifest, undefined), [])
})

test('rankRelatedMemories drops entries that do not overlap the query', () => {
  const manifest = [
    { name: 'oat-milk', description: 'coffee order', excerpt: 'Oat milk.' },
    { name: 'prefers-tabs', description: 'tabs over spaces', excerpt: 'Tabs.' },
  ]
  const ranked = rankRelatedMemories(manifest, 'indentation with tabs')
  assert.deepEqual(ranked.map((entry) => entry.name), ['prefers-tabs'])
})

test('rankRelatedMemories sorts by score, then by name for ties', () => {
  const manifest = [
    { name: 'alpha', description: 'review notes', excerpt: 'a' },
    { name: 'beta', description: 'tab review', excerpt: 'b' },
    { name: 'gamma', description: 'space', excerpt: 'g' },
    { name: 'delta', description: 'unrelated', excerpt: 'd' },
  ]
  const ranked = rankRelatedMemories(manifest, 'tabs spaces review')
  // beta hits hook twice; alpha and gamma tie at 1 and break on the name.
  assert.deepEqual(ranked.map((entry) => entry.name), ['beta', 'alpha', 'gamma'])
})

test('rankRelatedMemories breaks equal scores by code-point name order', () => {
  const manifest = [
    { name: 'zeta-note', description: 'review', excerpt: 'z' },
    { name: 'beta-note', description: 'review', excerpt: 'b' },
  ]
  assert.deepEqual(rankRelatedMemories(manifest, 'review').map((e) => e.name), ['beta-note', 'zeta-note'])
})

test('rankRelatedMemories caps at RELATED_MEMORY_LIMIT and honours an explicit limit', () => {
  const manifest = Array.from({ length: 10 }, (_value, index) => ({
    name: `item-${index}`,
    description: 'review notes',
    excerpt: '',
  }))
  const byDefault = rankRelatedMemories(manifest, 'review')
  assert.equal(RELATED_MEMORY_LIMIT, 8)
  assert.equal(byDefault.length, 8)
  assert.deepEqual(byDefault.map((entry) => entry.name), manifest.slice(0, 8).map((entry) => entry.name))
  assert.deepEqual(rankRelatedMemories(manifest, 'review', 2).map((entry) => entry.name), ['item-0', 'item-1'])
  assert.deepEqual(rankRelatedMemories(manifest, 'review', 0), [])
})

test('rankRelatedMemories returns plain { name, description, excerpt } and never mutates the manifest', () => {
  const manifest = [{ name: 'prefers-tabs', description: 'tabs over spaces', excerpt: 'Tabs, not spaces.' }]
  const snapshot = JSON.stringify(manifest)
  const ranked = rankRelatedMemories(manifest, 'tabs')
  assert.deepEqual(Object.keys(ranked[0]).sort(), ['description', 'excerpt', 'name'])
  assert.equal(ranked[0].description, 'tabs over spaces')
  assert.equal(ranked[0].excerpt, 'Tabs, not spaces.')
  assert.equal(JSON.stringify(manifest), snapshot)

  const noExcerpt = rankRelatedMemories([{ name: 'prefers-tabs', description: 'tabs' }], 'tabs')
  assert.equal(noExcerpt[0].excerpt, '')
})

test('rankRelatedMemories consumes a real buildManifest output', () => {
  const files = [
    {
      fileName: 'prefers-tabs.md',
      content: renderFactFile({
        name: 'prefers-tabs',
        type: 'user',
        description: 'tabs over spaces',
        body: 'The user always indents with tabs, never spaces.',
      }),
    },
    {
      fileName: 'oat-milk.md',
      content: renderFactFile({
        name: 'oat-milk',
        type: 'reference',
        description: 'coffee order',
        body: 'The user drinks oat-milk flat whites.',
      }),
    },
  ]
  const manifest = buildManifest(files)
  assert.equal(manifest.length, 2)
  const ranked = rankRelatedMemories(manifest, 'tabs spaces')
  assert.deepEqual(ranked.map((entry) => entry.name), ['prefers-tabs'])
  assert.ok(ranked[0].excerpt.includes('tabs'))
})

/* ----------------------------------------------------------------- rendering */

test('renderRelatedMemories returns "" for no entries', () => {
  assert.equal(renderRelatedMemories([]), '')
  assert.equal(renderRelatedMemories(undefined), '')
  assert.equal(renderRelatedMemories(null), '')
  assert.equal(renderRelatedMemories([{ name: '' }]), '')
  assert.equal(renderRelatedMemories([{ description: 'no name' }]), '')
})

test('renderRelatedMemories renders the frozen block shape', () => {
  const text = renderRelatedMemories([
    { name: 'prefers-tabs', description: 'tabs over spaces', excerpt: 'Indents with tabs.' },
  ])
  assert.equal(
    text,
    [
      RELATED_MEMORY_HEADING,
      NOTE,
      '',
      '- prefers-tabs — tabs over spaces',
      '  Indents with tabs.',
    ].join('\n'),
  )
})

test('renderRelatedMemories omits the dash when there is no description and separates entries with a blank line', () => {
  const text = renderRelatedMemories([
    { name: 'bare', description: '', excerpt: 'Body one.' },
    { name: 'hooked', description: 'has a hook', excerpt: '' },
  ])
  assert.equal(
    text,
    [RELATED_MEMORY_HEADING, NOTE, '', '- bare', '  Body one.', '', '- hooked — has a hook'].join('\n'),
  )
})

test('renderRelatedMemories flattens the excerpt to one line and truncates at 400 chars', () => {
  const multiline = renderRelatedMemories([
    { name: 'spread', description: '', excerpt: '  line one\n\nline   two\t ' },
  ])
  assert.ok(multiline.endsWith('\n  line one line two'))

  const long = renderRelatedMemories([
    { name: 'long', description: '', excerpt: 'x'.repeat(500) },
  ])
  const excerptLine = long.split('\n').find((line) => line.startsWith('  '))
  const excerptText = excerptLine.slice(2)
  assert.equal(RELATED_MEMORY_EXCERPT_CHARS, 400)
  assert.equal(excerptText.length, 401)
  assert.ok(excerptText.endsWith('…'))
  assert.ok(excerptLine.startsWith('  '), 'excerpt is indented two spaces')
})

test('renderRelatedMemories applies the total budget and appends the omitted notice', () => {
  const entries = Array.from({ length: 8 }, (_value, index) => ({
    name: `note-${index}`,
    description: 'overlap',
    excerpt: 'x'.repeat(400),
  }))
  const text = renderRelatedMemories(entries)
  assert.equal(RELATED_MEMORY_TOTAL_CHARS, 3200)
  assert.ok(text.length <= RELATED_MEMORY_TOTAL_CHARS, 'block stays inside the budget')
  const kept = bulletCount(text)
  assert.ok(kept >= 1 && kept < entries.length, 'tail entries are dropped')
  assert.ok(text.includes(`(+${entries.length - kept} more related memories not shown)`))
  assert.ok(text.startsWith(RELATED_MEMORY_HEADING))
})

test('renderRelatedMemories keeps at least one entry even when it alone exceeds the budget', () => {
  const entries = Array.from({ length: 8 }, (_value, index) => ({
    name: `note-${index}`,
    description: 'overlap',
    excerpt: 'x'.repeat(400),
  }))
  const text = renderRelatedMemories(entries, { totalChars: 300 })
  assert.equal(bulletCount(text), 1)
  assert.ok(text.includes('(+7 more related memories not shown)'))
})

test('renderRelatedMemories honours the limit override and stays byte-identical when empty', () => {
  const entries = Array.from({ length: 3 }, (_value, index) => ({
    name: `note-${index}`,
    description: '',
    excerpt: '',
  }))
  const capped = renderRelatedMemories(entries, { limit: 2 })
  assert.equal(bulletCount(capped), 2)
  assert.ok(capped.includes('(+1 more related memories not shown)'))
  assert.equal(renderRelatedMemories(entries, { limit: 0 }), '')
})

test('renderRelatedMemories end to end on a ranked manifest', () => {
  const manifest = [
    { name: 'prefers-tabs', description: 'tabs over spaces', excerpt: 'Indents with tabs.' },
    { name: 'oat-milk', description: 'coffee order', excerpt: 'Oat milk.' },
  ]
  const text = renderRelatedMemories(rankRelatedMemories(manifest, 'tabs'))
  assert.ok(text.startsWith(RELATED_MEMORY_HEADING))
  assert.ok(text.includes('- prefers-tabs — tabs over spaces'))
  assert.ok(!text.includes('oat-milk'))
  assert.ok(!text.includes('more related memories not shown'))
})
