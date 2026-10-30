/**
 * Roadmap W2 — semantic-recall primitives.
 *
 * The recall branch stays dormant (`SEMANTIC_RECALL_ENABLED = false`): the
 * default-index pointer injection remains live. These tests freeze the ported
 * ZCode behavior so the branch can be switched on later: manifest scanning
 * (markdown facts only, `MEMORY.md` excluded, mtime ordering, 30-line preview,
 * 200-entry cap), the data-only selector prompt, its JSON response parsing,
 * selection filtering (cap 5, no re-selection), and the recall block renderer
 * (per-fact line/byte clipping on complete lines, age and staleness notices,
 * session character budget).
 *
 * Everything here is pure data in / pure data out: no file system, no model.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACTIVE_RETRIEVAL_BRANCH,
  RECALL_BUDGET_CHARS,
  RECALL_FACT_MAX_BYTES,
  RECALL_FACT_MAX_LINES,
  RECALL_MANIFEST_LIMIT,
  RECALL_MAX_ITEMS,
  RECALL_PREVIEW_LINES,
  RECALL_STALE_AFTER_MS,
  RETRIEVAL_BRANCHES,
  SEMANTIC_RECALL_ENABLED,
  buildRecallManifest,
  buildSelectorPrompt,
  filterRecallSelections,
  formatRecallManifest,
  parseSelectorResponse,
  renderRecallBlock,
  retrievalBranch,
} from '../lib/recall.js'

/** One day in milliseconds (mirrors the module's internal constant). */
const DAY_MS = 86_400_000

/** Frontmatter-shaped fact file content. */
function factFile({ name = 'fact', description = 'A hook', type = 'project', body = 'Body.' } = {}) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${type}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

/** Fresh memory at `nowMs`, with an explicit file path. */
function memory(filePath, content, nowMs, mtimeMs = nowMs) {
  return { filePath, content, mtimeMs }
}

/* ------------------------------------------------------------------ branch */

test('default retrieval branch is default-index until the switch flips', () => {
  assert.equal(SEMANTIC_RECALL_ENABLED, false)
  assert.equal(retrievalBranch(), 'default-index')
  assert.equal(ACTIVE_RETRIEVAL_BRANCH, 'default-index')
  assert.equal(retrievalBranch(false), 'default-index')
  assert.equal(retrievalBranch(undefined), 'default-index')
  assert.equal(retrievalBranch(true), 'semantic-recall')
  assert.deepEqual([...RETRIEVAL_BRANCHES], ['default-index', 'semantic-recall'])
})

test('recall limits match the upstream constants', () => {
  assert.equal(RECALL_MAX_ITEMS, 5)
  assert.equal(RECALL_BUDGET_CHARS, 61440)
  assert.equal(RECALL_FACT_MAX_LINES, 200)
  assert.equal(RECALL_FACT_MAX_BYTES, 4096)
  assert.equal(RECALL_STALE_AFTER_MS, 48 * 60 * 60 * 1000)
  assert.equal(RECALL_PREVIEW_LINES, 30)
  assert.equal(RECALL_MANIFEST_LIMIT, 200)
})

/* ---------------------------------------------------------------- manifest */

test('buildRecallManifest keeps only markdown facts and drops the index file', () => {
  const manifest = buildRecallManifest([
    { filePath: '/ws/.dsh/memory/prefer-cli.md', content: factFile(), mtimeMs: 100 },
    { filePath: '/ws/.dsh/memory/MEMORY.md', content: '# Memory\n', mtimeMs: 900 },
    { filePath: '/ws/.dsh/memory/nested/MEMORY.md', content: 'x', mtimeMs: 950 },
    { filePath: '/ws/.dsh/memory/notes.txt', content: 'plain text', mtimeMs: 800 },
    { filePath: '/ws/.dsh/memory/no-extension', content: 'x', mtimeMs: 700 },
    { filePath: '', content: 'x', mtimeMs: 700 },
    { content: 'x', mtimeMs: 700 },
    { filePath: 42, content: 'x', mtimeMs: 700 },
    null,
    'not a record',
  ])

  assert.equal(manifest.length, 1)
  assert.equal(manifest[0].filename, 'prefer-cli.md')
  assert.equal(manifest[0].filePath, '/ws/.dsh/memory/prefer-cli.md')
})

test('buildRecallManifest reads type and description through parseFactFrontmatter', () => {
  const manifest = buildRecallManifest([
    {
      filePath: '/m/setup.md',
      content: factFile({ description: 'How the repo is wired', type: 'project' }),
      mtimeMs: 300,
    },
    { filePath: '/m/bad-type.md', content: factFile({ type: 'banana' }), mtimeMs: 200 },
    { filePath: '/m/no-frontmatter.md', content: 'just a body\n', mtimeMs: 100 },
    { filePath: '/m/feedback.md', content: factFile({ type: 'feedback' }), mtimeMs: 50 },
  ])

  const byName = new Map(manifest.map((entry) => [entry.filename, entry]))
  assert.equal(byName.get('setup.md').description, 'How the repo is wired')
  assert.equal(byName.get('setup.md').type, 'project')
  assert.equal(byName.get('feedback.md').type, 'feedback')
  // unknown metadata.type is not a recall type
  assert.equal(byName.get('bad-type.md').type, undefined)
  // no frontmatter at all
  assert.equal(byName.get('no-frontmatter.md').description, '')
  assert.equal(byName.get('no-frontmatter.md').type, undefined)
})

test('buildRecallManifest sorts by mtime descending, then filename ascending', () => {
  const manifest = buildRecallManifest([
    { filePath: '/m/b-old.md', content: 'x', mtimeMs: 100 },
    { filePath: '/m/a-old.md', content: 'x', mtimeMs: 100 },
    { filePath: '/m/newest.md', content: 'x', mtimeMs: 500 },
    { filePath: '/m/mid.md', content: 'x', mtimeMs: 300 },
  ])

  assert.deepEqual(
    manifest.map((entry) => entry.filename),
    ['newest.md', 'mid.md', 'a-old.md', 'b-old.md'],
  )
})

test('buildRecallManifest previews the first 30 lines only', () => {
  const lines = Array.from({ length: 40 }, (_ignored, index) => `line ${index + 1}`)
  const [entry] = buildRecallManifest([
    { filePath: '/m/long.md', content: lines.join('\n'), mtimeMs: 1 },
  ])

  assert.equal(entry.preview.split('\n').length, RECALL_PREVIEW_LINES)
  assert.equal(entry.preview, lines.slice(0, RECALL_PREVIEW_LINES).join('\n'))
})

test('buildRecallManifest normalizes CRLF and keeps short previews intact', () => {
  const [entry] = buildRecallManifest([
    { filePath: '/m/crlf.md', content: 'first\r\nsecond\r\n', mtimeMs: 1 },
  ])
  assert.equal(entry.preview, 'first\nsecond\n')
})

test('buildRecallManifest caps the manifest at 200 entries, newest first', () => {
  const records = Array.from({ length: 205 }, (_ignored, index) => ({
    filePath: `/m/fact-${String(index).padStart(3, '0')}.md`,
    content: 'x',
    mtimeMs: index,
  }))
  const manifest = buildRecallManifest(records)

  assert.equal(manifest.length, RECALL_MANIFEST_LIMIT)
  assert.equal(manifest[0].filename, 'fact-204.md')
  assert.equal(manifest[199].filename, 'fact-005.md')
  assert.equal(
    manifest.some((entry) => entry.filename === 'fact-004.md'),
    false,
  )
})

test('buildRecallManifest tolerates a missing or non-array record list', () => {
  assert.deepEqual(buildRecallManifest(undefined), [])
  assert.deepEqual(buildRecallManifest(null), [])
  assert.deepEqual(buildRecallManifest('nope'), [])
})

/* ---------------------------------------------------------------- format */

test('formatRecallManifest renders type, ISO timestamp and description per line', () => {
  const text = formatRecallManifest([
    {
      filename: 'src-setup.md',
      type: 'project',
      mtimeMs: 1000,
      description: 'Project overview',
    },
    { filename: 'no-type.md', mtimeMs: 2000 },
    { filename: 'typed-only.md', type: 'user', mtimeMs: 3000 },
    { filename: 'empty-description.md', type: 'feedback', mtimeMs: 4000, description: '' },
    { filename: 'bad-type.md', type: 'banana', mtimeMs: 5000 },
  ])

  assert.equal(
    text,
    [
      '- [project] src-setup.md (1970-01-01T00:00:01.000Z): Project overview',
      '- no-type.md (1970-01-01T00:00:02.000Z)',
      '- [user] typed-only.md (1970-01-01T00:00:03.000Z)',
      '- [feedback] empty-description.md (1970-01-01T00:00:04.000Z)',
      '- bad-type.md (1970-01-01T00:00:05.000Z)',
    ].join('\n'),
  )
  assert.equal(formatRecallManifest([]), '')
  assert.equal(formatRecallManifest(undefined), '')
})

/* -------------------------------------------------------------- selector */

test('buildSelectorPrompt returns the upstream system prompt, user text and schema', () => {
  const { system, user, schema } = buildSelectorPrompt({
    query: 'why did the tab width change',
    manifest: [
      { filename: 'prefer-cli.md', type: 'feedback', mtimeMs: 1000, description: 'CLI first' },
      { filename: 'alpha.md', type: 'user', mtimeMs: 2000, description: 'Works on parser' },
    ],
  })

  // The three conservative selection rules.
  assert.ok(
    system.includes(
      'If you are unsure if a memory will be useful in processing the user\'s query, ' +
        'then do not include it in your list. Be selective and discerning.',
    ),
    'missing the unsure rule',
  )
  assert.ok(
    system.includes(
      'If there are no memories in the list that would clearly be useful, ' +
        'feel free to return an empty list.',
    ),
    'missing the empty-list rule',
  )
  assert.ok(
    system.includes(
      'Be especially conservative with user-profile and project-overview memories ' +
        '([user], [project]).',
    ),
    'missing the user/project rule',
  )
  assert.ok(system.includes('up to 5'), 'missing the item cap')
  assert.ok(system.includes('Do not re-select memories you already returned'))

  // Both manifest lines and the query reach the user message.
  assert.ok(user.startsWith('Available memories:\n'))
  assert.ok(user.includes('- [feedback] prefer-cli.md (1970-01-01T00:00:01.000Z): CLI first'))
  assert.ok(user.includes('- [user] alpha.md (1970-01-01T00:00:02.000Z): Works on parser'))
  assert.ok(user.endsWith('Select memories relevant to:\nwhy did the tab width change'))

  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      selected_memories: { type: 'array', items: { type: 'string' } },
      selected_knowledge_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['selected_memories'],
    additionalProperties: false,
  })
})

test('buildSelectorPrompt hands out a fresh schema so mutations cannot leak', () => {
  const first = buildSelectorPrompt({ query: 'q', manifest: [] })
  first.schema.properties.selected_memories.items.type = 'number'
  first.schema.required.push('selected_knowledge_ids')

  const second = buildSelectorPrompt({ query: 'q', manifest: [] })
  assert.equal(second.schema.properties.selected_memories.items.type, 'string')
  assert.deepEqual(second.schema.required, ['selected_memories'])
})

test('buildSelectorPrompt works with no input at all', () => {
  const { system, user } = buildSelectorPrompt()
  assert.ok(system.startsWith('You are selecting memories'))
  assert.equal(user, 'Available memories:\n\n\nSelect memories relevant to:\n')
})

/* ----------------------------------------------------------------- parse */

test('parseSelectorResponse accepts the two-key response and defaults knowledge ids', () => {
  assert.deepEqual(
    parseSelectorResponse('{"selected_memories":["a.md","b.md"]}'),
    { selectedMemories: ['a.md', 'b.md'], selectedKnowledgeIds: [] },
  )
  assert.deepEqual(
    parseSelectorResponse(
      '{"selected_memories":[],"selected_knowledge_ids":["k-1"]}',
    ),
    { selectedMemories: [], selectedKnowledgeIds: ['k-1'] },
  )
  // Array copies, not aliases of the parsed input.
  const parsed = parseSelectorResponse('{"selected_memories":["a.md"]}')
  parsed.selectedMemories.push('mutated.md')
  assert.deepEqual(parseSelectorResponse('{"selected_memories":["a.md"]}').selectedMemories, [
    'a.md',
  ])
})

test('parseSelectorResponse rejects extra keys, wrong types and malformed JSON', () => {
  const rejected = [
    '{"selected_memories":["a.md"],"extra":"nope"}',
    '{"selected_memories":["a.md"],"selected_knowledge_ids":["k"],"note":"hi"}',
    '{"selected_memories":"a.md"}',
    '{"selected_memories":["a.md",1]}',
    '{"selected_memories":[null]}',
    '{"selected_memories":[],"selected_knowledge_ids":"k"}',
    '{"selected_memories":[],"selected_knowledge_ids":[true]}',
    '{"selected_memories":{}}',
    '{}',
    '[]',
    'null',
    '"selected_memories"',
    'not json',
    '{"selected_memories":["a.md"],}',
    '',
  ]
  for (const text of rejected) {
    assert.equal(parseSelectorResponse(text), undefined, `should reject: ${text}`)
  }
  assert.equal(parseSelectorResponse(undefined), undefined)
  assert.equal(parseSelectorResponse(null), undefined)
  assert.equal(parseSelectorResponse(42), undefined)
})

/* ---------------------------------------------------------------- filter */

test('filterRecallSelections maps filenames, keeps order and drops recalled paths', () => {
  const manifest = buildRecallManifest([
    { filePath: '/m/a.md', content: 'a', mtimeMs: 5 },
    { filePath: '/m/b.md', content: 'b', mtimeMs: 4 },
    { filePath: '/m/c.md', content: 'c', mtimeMs: 3 },
  ])

  const picked = filterRecallSelections({
    manifest,
    selectedFilenames: ['c.md', 'missing.md', 'a.md'],
    recalledPaths: new Set(['/m/unknown.md']),
  })
  assert.deepEqual(
    picked.map((entry) => entry.filename),
    ['c.md', 'a.md'],
  )

  const withoutA = filterRecallSelections({
    manifest,
    selectedFilenames: ['c.md', 'a.md'],
    recalledPaths: new Set(['/m/a.md']),
  })
  assert.deepEqual(
    withoutA.map((entry) => entry.filename),
    ['c.md'],
  )
})

test('filterRecallSelections caps at 5 memories', () => {
  const records = Array.from({ length: 8 }, (_ignored, index) => ({
    filePath: `/m/fact-${index}.md`,
    content: 'x',
    mtimeMs: 8 - index,
  }))
  const manifest = buildRecallManifest(records)
  const picked = filterRecallSelections({
    manifest,
    selectedFilenames: manifest.map((entry) => entry.filename),
    recalledPaths: new Set(),
  })

  assert.equal(picked.length, RECALL_MAX_ITEMS)
  assert.deepEqual(
    picked.map((entry) => entry.filename),
    ['fact-0.md', 'fact-1.md', 'fact-2.md', 'fact-3.md', 'fact-4.md'],
  )
})

test('filterRecallSelections collapses repeated filenames and accepts a path array', () => {
  const manifest = buildRecallManifest([
    { filePath: '/m/a.md', content: 'a', mtimeMs: 1 },
    { filePath: '/m/b.md', content: 'b', mtimeMs: 2 },
  ])
  const picked = filterRecallSelections({
    manifest,
    selectedFilenames: ['b.md', 'b.md', 'a.md', 'b.md'],
    recalledPaths: ['/m/never-seen.md'],
  })
  assert.deepEqual(
    picked.map((entry) => entry.filename),
    ['b.md', 'a.md'],
  )
})

test('filterRecallSelections returns [] for empty or malformed input', () => {
  assert.deepEqual(filterRecallSelections(), [])
  assert.deepEqual(filterRecallSelections({ manifest: [] }), [])
  assert.deepEqual(
    filterRecallSelections({ manifest: 'nope', selectedFilenames: ['a.md'], recalledPaths: null }),
    [],
  )
})

/* ---------------------------------------------------------------- render */

test('renderRecallBlock returns an empty string for no memories', () => {
  assert.equal(renderRecallBlock([]), '')
  assert.equal(renderRecallBlock(undefined), '')
  assert.equal(renderRecallBlock(null), '')
  assert.equal(renderRecallBlock([null, 'junk']), '')
})

test('renderRecallBlock prefixes the preamble once and formats a fresh fact plainly', () => {
  const nowMs = 1_700_000_000_000
  const text = renderRecallBlock(
    [
      memory('/m/a.md', 'alpha body', nowMs, nowMs - 60_000),
      memory('/m/b.md', 'beta body', nowMs, nowMs - 120_000),
    ],
    { nowMs },
  )

  assert.equal(text.split('Retrieved for possible relevance').length - 1, 1)
  assert.ok(text.startsWith('Retrieved for possible relevance'))
  assert.ok(text.includes('Memory: /m/a.md:\n\nalpha body'))
  assert.ok(text.includes('Memory: /m/b.md:\n\nbeta body'))
  assert.equal(text.includes('days old'), false)
  assert.equal(text.includes('re-verify'), false)
})

test('renderRecallBlock flags facts at least a day old, and stale ones at 48 hours', () => {
  const nowMs = 1_700_000_000_000
  const oneDay = renderRecallBlock([memory('/m/a.md', 'body', nowMs, nowMs - DAY_MS)], { nowMs })
  assert.ok(oneDay.includes('This memory is 1 days old.'))
  assert.ok(oneDay.includes('point-in-time observations'))
  assert.equal(
    oneDay.includes('This memory has not been updated in over 48 hours'),
    false,
    '24h is not stale yet',
  )

  const fortySevenHours = renderRecallBlock(
    [memory('/m/a.md', 'body', nowMs, nowMs - 47 * 60 * 60 * 1000)],
    { nowMs },
  )
  assert.ok(fortySevenHours.includes('This memory is 1 days old.'))
  assert.equal(fortySevenHours.includes('over 48 hours'), false)

  const twoDays = renderRecallBlock([memory('/m/a.md', 'body', nowMs, nowMs - 49 * 60 * 60 * 1000)], {
    nowMs,
  })
  assert.ok(twoDays.includes('This memory is 2 days old.'))
  assert.ok(twoDays.includes('This memory has not been updated in over 48 hours; re-verify it before relying on it.'))
})

test('renderRecallBlock clips a fact at 200 lines and appends the truncation notice', () => {
  const nowMs = 1_700_000_000_000
  const lines = Array.from({ length: RECALL_FACT_MAX_LINES + 100 }, (_ignored, index) => `fact line ${index + 1}`)
  const path = '/m/huge.md'
  const block = renderRecallBlock([memory(path, lines.join('\n'), nowMs)], { nowMs })

  const body = block.slice(block.indexOf(`Memory: ${path}:\n\n`) + `Memory: ${path}:\n\n`.length)
  const [kept, notice] = body.split('\n\n> This memory file was truncated')
  assert.deepEqual(kept.split('\n'), lines.slice(0, RECALL_FACT_MAX_LINES))
  assert.ok(notice.startsWith(' (first 200 lines). Use the Read tool to view the complete file at: ' + path))
  assert.equal(body.includes('byte limit'), false)
})

test('renderRecallBlock clips a fact at 4096 bytes without splitting UTF-8 characters', () => {
  const nowMs = 1_700_000_000_000
  const line = '中'.repeat(100) // 100 characters, 300 UTF-8 bytes
  const lines = Array.from({ length: 20 }, () => line)
  const path = '/m/cjk.md'
  const block = renderRecallBlock([memory(path, lines.join('\n'), nowMs)], { nowMs })

  // The block itself must survive a UTF-8 round trip: no split code points.
  assert.equal(Buffer.from(block, 'utf8').toString('utf8'), block)
  assert.equal(block.includes('\uFFFD'), false)

  const header = `Memory: ${path}:\n\n`
  const body = block.slice(block.indexOf(header) + header.length)
  const [kept, notice] = body.split('\n\n> This memory file was truncated')
  const keptLines = kept.split('\n')

  assert.equal(keptLines.length, 13, '13 whole 300-byte lines fit, the 14th does not')
  for (const keptLine of keptLines) assert.equal(keptLine, line)
  assert.ok(Buffer.byteLength(kept, 'utf8') <= RECALL_FACT_MAX_BYTES)
  assert.equal(Buffer.byteLength(kept, 'utf8'), 13 * 300 + 12)
  assert.ok(notice.startsWith(' (4096 byte limit). Use the Read tool to view the complete file at: ' + path))
})

test('renderRecallBlock stops at the character budget and reports the remainder', () => {
  const nowMs = 1_700_000_000_000
  const first = memory('/m/a.md', 'alpha', nowMs)
  const second = memory('/m/b.md', 'beta', nowMs)

  const full = renderRecallBlock([first, second], { nowMs })
  assert.ok(full.includes('beta'))
  const firstBlock = `Memory: /m/a.md:\n\nalpha`

  const budgeted = renderRecallBlock([first, second], { nowMs, budgetChars: firstBlock.length })
  assert.ok(budgeted.includes('alpha'))
  assert.equal(budgeted.includes('beta'), false)
  assert.ok(budgeted.endsWith('(+1 more memories not shown)'))

  const nothingFits = renderRecallBlock([first, second], { nowMs, budgetChars: 0 })
  assert.equal(nothingFits.includes('Memory:'), false)
  assert.ok(nothingFits.endsWith('(+2 more memories not shown)'))
  assert.ok(nothingFits.startsWith('Retrieved for possible relevance'))
})

test('renderRecallBlock keeps exact-size fact within the budget unchanged', () => {
  const nowMs = 1_700_000_000_000
  const one = memory('/m/a.md', 'alpha', nowMs)
  const blockSize = `Memory: /m/a.md:\n\nalpha`.length
  const text = renderRecallBlock([one], { nowMs, budgetChars: blockSize })
  assert.equal(text.includes('Memory: /m/a.md:\n\nalpha'), true)
  assert.equal(text.includes('more memories not shown'), false)
})
