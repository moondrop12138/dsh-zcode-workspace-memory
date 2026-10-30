import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  DEFAULT_MAX_INDEX_CHARS,
  INDEX_FILE,
  INDEX_TRUNCATION_WARNING,
  MAX_INDEX_LINES,
  MEMORY_TYPES,
  TRASH_DIR,
  TRASH_KEEP,
  buildExtractionPrompt,
  buildConflictGuidance,
  buildManifest,
  buildTranscript,
  buildTranscriptSegments,
  conflictExcerpt,
  countWords,
  deriveTitle,
  evaluateExtraction,
  extractJsonObject,
  factBodyText,
  factFileName,
  findNearDuplicateMatches,
  formatIndexContent,
  indexPath,
  isIndexFile,
  isValidMemoryName,
  memoryRoot,
  memoryRulesText,
  parseExtractionResponse,
  parseFactFileName,
  parseFactFrontmatter,
  parseIndexPointers,
  pickRoute,
  removePointer,
  renderFactFile,
  renderMemorySection,
  renderPointer,
  safeMemoryPath,
  selectTrashEvictions,
  slugifyTitle,
  trashDirPath,
  upsertPointer,
} from '../lib/memory-core.js'

// Paths here are built by `node:path`, so the fixture root must be absolute for
// the host platform rather than a hardcoded Windows drive.
const WORKSPACE = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'
const ROOT = join(WORKSPACE, '.dsh', 'memory')
const OUTSIDE = process.platform === 'win32' ? 'C:\\windows\\evil.md' : '/etc/evil.md'

test('memoryRoot appends .dsh/memory and indexPath names the index', () => {
  assert.equal(memoryRoot(WORKSPACE), ROOT)
  assert.equal(indexPath(ROOT), join(ROOT, INDEX_FILE))
  assert.equal(isIndexFile('MEMORY.md'), true)
  assert.equal(isIndexFile('memory.md'), false)
})

test('trashDirPath is a trash subdirectory and evictions keep the newest 50', () => {
  assert.equal(trashDirPath(ROOT), join(ROOT, TRASH_DIR))
  assert.equal(TRASH_DIR, 'trash')
  assert.equal(TRASH_KEEP, 50)

  const entries = Array.from({ length: 52 }, (_, index) => ({ name: `fact-${index}.md`, mtimeMs: index }))
  assert.deepEqual(selectTrashEvictions(entries), ['fact-0.md', 'fact-1.md'])

  // Equal mtimes fall back to name order so the outcome is deterministic.
  const tied = [
    { name: 'b.md', mtimeMs: 10 },
    { name: 'a.md', mtimeMs: 10 },
    { name: 'c.md', mtimeMs: 20 },
  ]
  assert.deepEqual(selectTrashEvictions(tied, 2), ['a.md'])

  assert.deepEqual(selectTrashEvictions(entries.slice(0, 50)), [])
  assert.deepEqual(selectTrashEvictions([]), [])
  assert.deepEqual(selectTrashEvictions(undefined), [])
  // Unreadable mtimes are skipped rather than evicting unknown files.
  assert.deepEqual(selectTrashEvictions([{ name: 'a.md', mtimeMs: Number.NaN }], 0), [])
})

test('fact names are lowercase kebab and never collide with the index', () => {
  assert.equal(isValidMemoryName('prefers-tabs'), true)
  assert.equal(isValidMemoryName('a'), true)
  assert.equal(isValidMemoryName('Prefers-Tabs'), false)
  assert.equal(isValidMemoryName('has space'), false)
  assert.equal(isValidMemoryName('trailing-'), false)
  assert.equal(isValidMemoryName(''), false)
  assert.equal(isValidMemoryName('memory'), false, 'memory.md would collide with MEMORY.md on Windows')
  assert.equal(isValidMemoryName('MEMORY'), false)
  assert.equal(isValidMemoryName('x'.repeat(49)), false)
  assert.equal(isValidMemoryName('x'.repeat(48)), true)
  assert.equal(isValidMemoryName(undefined), false)
  assert.equal(factFileName('prefers-tabs'), 'prefers-tabs.md')
  assert.equal(parseFactFileName('prefers-tabs.md'), 'prefers-tabs')
  assert.equal(parseFactFileName('MEMORY.md'), undefined)
  assert.equal(parseFactFileName('memory.md'), undefined)
  assert.equal(parseFactFileName('x.txt'), undefined)
})

test('safeMemoryPath accepts only the index or a valid fact file', () => {
  assert.equal(safeMemoryPath(ROOT, 'MEMORY.md'), join(ROOT, 'MEMORY.md'))
  assert.equal(safeMemoryPath(ROOT, 'prefers-tabs.md'), join(ROOT, 'prefers-tabs.md'))
  assert.equal(safeMemoryPath(ROOT, '../secret.md'), undefined)
  assert.equal(safeMemoryPath(ROOT, 'sub/prefers-tabs.md'), undefined)
  assert.equal(safeMemoryPath(ROOT, OUTSIDE), undefined)
  assert.equal(safeMemoryPath(ROOT, 'prefers-tabs'), undefined)
  assert.equal(safeMemoryPath('', 'MEMORY.md'), undefined)
})

test('slugifyTitle derives slugs and deriveTitle renders a title', () => {
  assert.equal(slugifyTitle('Prefers tabs over spaces'), 'prefers-tabs-over-spaces')
  assert.equal(slugifyTitle('  API: v2 only!  '), 'api-v2-only')
  assert.equal(slugifyTitle('memory'), undefined)
  assert.equal(slugifyTitle('!!!'), undefined)
  assert.equal(slugifyTitle(undefined), undefined)
  assert.equal(deriveTitle('prefers-tabs'), 'Prefers Tabs')
  assert.equal(deriveTitle('a'), 'A')
})

test('formatIndexContent strips frontmatter, comments and bounds the block', () => {
  const raw = [
    '---',
    'title: index',
    '---',
    '<!-- generated, do not edit -->',
    '- [Tabs](prefers-tabs.md) — uses tabs',
    '',
    '<!--',
    'multi line',
    '-->',
    '- [Bun](likes-bun.md) — runtime of choice',
    '',
  ].join('\n')
  const formatted = formatIndexContent(raw)
  assert.equal(formatted.truncated, false)
  assert.equal(formatted.text, '- [Tabs](prefers-tabs.md) — uses tabs\n\n- [Bun](likes-bun.md) — runtime of choice')

  assert.deepEqual(formatIndexContent(''), { text: '', truncated: false, lineCount: 0 })
  assert.deepEqual(formatIndexContent('  \n '), { text: '', truncated: false, lineCount: 0 })
  assert.deepEqual(formatIndexContent(undefined), { text: '', truncated: false, lineCount: 0 })
})

test('formatIndexContent truncates by lines, then by characters, with the frozen warning', () => {
  const many = Array.from({ length: MAX_INDEX_LINES + 5 }, (_v, i) => `- [F${i}](f${i}.md) — h`)
  const byLines = formatIndexContent(many.join('\n'))
  assert.equal(byLines.truncated, true)
  assert.equal(byLines.text.split('\n').length, MAX_INDEX_LINES + 2, '200 lines plus blank line and warning')
  assert.ok(byLines.text.endsWith(INDEX_TRUNCATION_WARNING))

  const wide = '- [A](a.md) — ' + 'x'.repeat(500)
  const byChars = formatIndexContent(wide, { maxChars: 100 })
  assert.equal(byChars.truncated, true)
  assert.ok(byChars.text.split('\n\n')[0].length <= 100)
  assert.ok(byChars.text.endsWith(INDEX_TRUNCATION_WARNING))

  const defaultChars = formatIndexContent('- [A](a.md) — ' + 'x'.repeat(DEFAULT_MAX_INDEX_CHARS + 10))
  assert.equal(defaultChars.truncated, true)
})

test('renderMemorySection always carries the rules and appends a non-empty index', () => {
  const rulesOnly = renderMemorySection({ root: ROOT })
  assert.equal(rulesOnly.indexLineCount, 0)
  assert.equal(rulesOnly.text, memoryRulesText(ROOT))
  assert.ok(rulesOnly.text.startsWith('# Memory'))
  assert.ok(rulesOnly.text.includes(ROOT))
  assert.ok(rulesOnly.text.includes('`write` and `edit`'))

  const withIndex = renderMemorySection({
    root: ROOT,
    rawIndex: '- [Tabs](prefers-tabs.md) — uses tabs',
  })
  assert.ok(withIndex.text.startsWith(memoryRulesText(ROOT)))
  assert.ok(withIndex.text.includes(`Contents of \`${ROOT}/${INDEX_FILE}\``))
  assert.ok(withIndex.text.endsWith('- [Tabs](prefers-tabs.md) — uses tabs'))
})

test('pointer helpers round-trip through parse, render, upsert and remove', () => {
  const index = [
    '- [Tabs](prefers-tabs.md) — uses tabs',
    '- [Bun](likes-bun.md) — runtime of choice',
  ].join('\n')
  const pointers = parseIndexPointers(index)
  assert.deepEqual(pointers.map((entry) => entry.file), ['prefers-tabs.md', 'likes-bun.md'])
  assert.equal(pointers[0].title, 'Tabs')
  assert.equal(pointers[0].hook, 'uses tabs')

  assert.equal(renderPointer({ title: 'Tabs', file: 'prefers-tabs.md', hook: 'uses tabs' }),
    '- [Tabs](prefers-tabs.md) — uses tabs')
  assert.equal(renderPointer({ file: 'prefers-tabs.md' }), '- [Prefers Tabs](prefers-tabs.md)')

  const updated = upsertPointer(index, { title: 'Tabs v2', file: 'prefers-tabs.md', hook: 'still tabs' })
  assert.equal(updated, [
    '- [Tabs v2](prefers-tabs.md) — still tabs',
    '- [Bun](likes-bun.md) — runtime of choice',
    '',
  ].join('\n'))

  const appended = upsertPointer(index, { title: 'Zed', file: 'uses-zed.md', hook: 'editor' })
  assert.ok(appended.endsWith('- [Zed](uses-zed.md) — editor\n'))

  const removed = removePointer(appended, 'likes-bun.md')
  assert.ok(!removed.includes('likes-bun.md'))
  assert.ok(removed.includes('prefers-tabs.md'))
  assert.equal(removePointer('', 'x.md'), '')
  assert.equal(removePointer('- [X](x.md) — y\n', 'x.md'), '')
})

test('fact files render and parse back with origin preservation', () => {
  const content = renderFactFile({
    name: 'prefers-tabs',
    description: 'User prefers tabs over spaces',
    type: 'user',
    body: 'Always indent with tabs in this repository.',
    originSessionId: 'session-abc',
  })
  assert.ok(content.startsWith('---\nname: prefers-tabs\n'))
  assert.ok(content.includes('  node_type: memory'))
  assert.ok(content.includes('  type: user'))
  assert.ok(content.includes('  originSessionId: session-abc'))
  assert.ok(content.endsWith('Always indent with tabs in this repository.\n'))

  const front = parseFactFrontmatter(content)
  // D2: the host maintains createdAt/updatedAt, so a render now carries them.
  assert.deepEqual(
    { ...front, createdAt: 'ts', updatedAt: 'ts' },
    {
      name: 'prefers-tabs',
      description: 'User prefers tabs over spaces',
      type: 'user',
      originSessionId: 'session-abc',
      createdAt: 'ts',
      updatedAt: 'ts',
    },
  )
  assert.match(front.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(front.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(parseFactFrontmatter('no frontmatter'), undefined)
})

test('values containing # are quoted so YAML cannot truncate them as a comment', () => {
  const content = renderFactFile({
    name: 'hash-tag',
    description: 'keep this # tag intact',
    type: 'project',
    body: 'Body text.',
  })
  assert.ok(content.includes('description: "keep this # tag intact"'))
  assert.equal(parseFactFrontmatter(content).description, 'keep this # tag intact')

  // A lone `#` must not reopen the comment inside the quoted value either.
  const tricky = renderFactFile({
    name: 'hash-only',
    description: 'before # after',
    type: 'feedback',
    body: 'Body text.',
  })
  assert.ok(tricky.includes('description: "before # after"'))
  assert.equal(parseFactFrontmatter(tricky).description, 'before # after')

  // Plain values stay unquoted.
  assert.ok(renderFactFile({
    name: 'plain',
    description: 'no hash here',
    type: 'user',
    body: 'Body text.',
  }).includes('description: no hash here'))
})

test('feedback facts gain Why/How to apply only when missing', () => {
  const withFields = renderFactFile({
    name: 'reviews-before-merge',
    description: 'Run tests before merging',
    type: 'feedback',
    body: 'Always run the full suite before merging.',
    why: 'A regression shipped last quarter.',
    howToApply: 'Run node --test before every merge.',
  })
  assert.ok(withFields.includes('**Why:** A regression shipped last quarter.'))
  assert.ok(withFields.includes('**How to apply:** Run node --test before every merge.'))

  const inline = renderFactFile({
    name: 'reviews-before-merge',
    description: 'Run tests before merging',
    type: 'feedback',
    body: 'Always run the full suite.\n\n**Why:** already written.',
    why: 'ignored',
  })
  assert.equal(inline.match(/\*\*Why:\*\*/g)?.length, 1)
})

test('renderFactFile rejects invalid facts', () => {
  const base = { name: 'ok-name', description: 'd', type: 'user', body: 'b' }
  assert.equal(renderFactFile(null), '')
  assert.equal(renderFactFile({ ...base, name: 'Bad Name' }), '')
  assert.equal(renderFactFile({ ...base, type: 'unknown' }), '')
  assert.equal(renderFactFile({ ...base, description: '  ' }), '')
  assert.equal(renderFactFile({ ...base, body: '' }), '')
  assert.equal(MEMORY_TYPES.length, 4)
})

test('buildManifest skips the index and unparseable files', () => {
  const files = [
    { fileName: 'MEMORY.md', content: '- [A](a.md) — b' },
    {
      fileName: 'prefers-tabs.md',
      content: renderFactFile({ name: 'prefers-tabs', description: 'tabs', type: 'user', body: 'b' }),
    },
    { fileName: 'notes.txt', content: 'nope' },
    { fileName: 'broken.md', content: 'no frontmatter' },
  ]
  assert.deepEqual(buildManifest(files), [
    { name: 'prefers-tabs', description: 'tabs', excerpt: 'b' },
    { name: 'broken', description: '', excerpt: 'no frontmatter' },
  ])
  assert.equal(buildManifest(files, 1).length, 1)
})

test('extraction eligibility mirrors ZCode skip rules (with a CJK adjustment)', () => {
  assert.equal(countWords('one two three'), 3)
  assert.equal(countWords('  one   two  '), 2)
  assert.equal(countWords(undefined), 0)

  // ZCode's whitespace-only rule never fires for Chinese prose; CJK characters
  // count as half a word each so a real sentence qualifies.
  assert.equal(countWords('这个插件对所有工作区都生效吗'), 7)
  assert.equal(countWords('好的'), 1)
  assert.equal(countWords('继续吧'), 2)
  assert.equal(countWords('ok 继续吧'), 3)

  assert.deepEqual(evaluateExtraction({ userBlocks: ['remember this thing'] }), { run: true })
  assert.deepEqual(evaluateExtraction({ userBlocks: ['ok', 'remember this thing'] }), { run: true })
  assert.deepEqual(evaluateExtraction({ userBlocks: ['把这个插件的行为说清楚'] }), { run: true })
  assert.deepEqual(evaluateExtraction({ userBlocks: ['好的'] }), {
    run: false,
    reason: 'no-user-prose',
  })
  assert.deepEqual(evaluateExtraction({ userBlocks: ['yes please'] }), {
    run: false,
    reason: 'no-user-prose',
  })
  assert.deepEqual(evaluateExtraction({ userBlocks: ['a b c'], directWrite: true }), {
    run: false,
    reason: 'direct-memory-write',
  })
  assert.deepEqual(evaluateExtraction({}), { run: false, reason: 'no-user-prose' })
})

test('buildTranscript keeps the newest content under the cap', () => {
  const short = buildTranscript([
    { role: 'user', text: 'hello there' },
    { role: 'assistant', text: 'hi' },
  ])
  assert.equal(short.truncated, false)
  assert.equal(short.text, 'User: hello there\n\nAssistant: hi')

  const long = buildTranscript(
    Array.from({ length: 40 }, (_v, i) => ({ role: 'user', text: `line ${i} ${'x'.repeat(100)}` })),
    500,
  )
  assert.equal(long.truncated, true)
  assert.ok(long.text.length <= 500)
  assert.ok(long.text.includes('line 39'))
})

test('buildTranscriptSegments splits an oversized turn and keeps the newest content', () => {
  // A turn that fits stays exactly one segment, identical to buildTranscript.
  const short = buildTranscriptSegments([
    { role: 'user', text: 'hello there' },
    { role: 'assistant', text: 'hi' },
  ])
  assert.deepEqual(short, ['User: hello there\n\nAssistant: hi'])
  assert.deepEqual(buildTranscriptSegments([]), [])

  // 20 × ~115 chars ≈ 2.3k with a 1k cap: three segments fit the whole turn,
  // one message per position, nothing lost.
  const messages = Array.from({ length: 20 }, (_v, i) => ({ role: 'user', text: `line ${i} ${'x'.repeat(100)}` }))
  const segments = buildTranscriptSegments(messages, 1000, 3)
  assert.equal(segments.length, 3)
  assert.ok(segments[0].includes('line 0'))
  assert.ok(segments.at(-1).includes('line 19'))
  for (const segment of segments) assert.ok(segment.length <= 1000)
  const joined = segments.join('\n\n')
  for (let i = 0; i < 20; i += 1) assert.equal(joined.split(`line ${i} `).length - 1, 1)

  // 40 messages exceed three windows: the oldest go, the newest survive.
  const overflow = buildTranscriptSegments(
    Array.from({ length: 40 }, (_v, i) => ({ role: 'user', text: `line ${i} ${'x'.repeat(100)}` })),
    1000,
    3,
  )
  assert.equal(overflow.length, 3)
  assert.ok(!overflow[0].includes('line 0 '))
  assert.ok(overflow.at(-1).includes('line 39'))

  // One message longer than the cap cannot be split: it keeps its newest tail.
  const single = buildTranscriptSegments([{ role: 'user', text: 'z'.repeat(5000) }], 1000, 3)
  assert.equal(single.length, 1)
  assert.ok(single[0].length <= 1000)
})

test('buildExtractionPrompt carries the count, manifest and no-op contract', () => {
  const prompt = buildExtractionPrompt({
    messageCount: 12,
    manifest: [{ name: 'prefers-tabs', description: 'tabs' }],
  })
  assert.ok(prompt.includes('most recent ~12 messages'))
  assert.ok(prompt.includes('## Existing memory files'))
  assert.ok(prompt.includes('- prefers-tabs: tabs'))
  assert.ok(prompt.includes('{"memories":[],"forget":[]}'))
  assert.ok(prompt.endsWith('## Conversation'))

  const withoutManifest = buildExtractionPrompt({ messageCount: 3 })
  assert.ok(!withoutManifest.includes('## Existing memory files'))
})

test('extractJsonObject tolerates fences, prose and braces inside strings', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJsonObject('sure:\n```json\n{"a":2}\n```\ndone'), { a: 2 })
  assert.deepEqual(extractJsonObject('prefix {"a":"b}c"} suffix'), { a: 'b}c' })
  assert.equal(extractJsonObject('no json here'), undefined)
  assert.equal(extractJsonObject('{broken'), undefined)
  assert.equal(extractJsonObject(undefined), undefined)
})

test('parseExtractionResponse validates strictly and caps the batch', () => {
  const valid = parseExtractionResponse(JSON.stringify({
    memories: [
      { name: 'prefers-tabs', title: 'Tabs', type: 'user', description: 'tabs', body: 'Uses tabs.' },
      {
        name: 'run-tests-first',
        title: 'Run tests',
        type: 'feedback',
        description: 'tests first',
        body: 'Run the suite.',
        why: 'regressions',
        howToApply: 'node --test',
      },
    ],
    forget: ['old-fact', 'Bad Name', 'old-fact'],
  }))
  assert.equal(valid.memories.length, 2)
  assert.deepEqual(valid.forget, ['old-fact'])
  assert.equal(valid.memories[1].howToApply, 'node --test')

  assert.deepEqual(parseExtractionResponse('{"memories":[],"forget":[]}'), { memories: [], forget: [] })
  assert.deepEqual(parseExtractionResponse('{"memories":[]}'), { memories: [], forget: [] })

  const six = Array.from({ length: 6 }, (_v, i) => ({
    name: `fact-${i}`,
    type: 'project',
    description: `d${i}`,
    body: 'b',
  }))
  assert.equal(parseExtractionResponse(JSON.stringify({ memories: six })).memories.length, 5)

  const badType = [{ name: 'a-b', type: 'nope', description: 'd', body: 'b' }]
  assert.deepEqual(parseExtractionResponse(JSON.stringify({ memories: badType })).memories, [],
    'an entry with an invalid type is dropped, not the whole reply')

  const noBody = parseExtractionResponse(JSON.stringify({
    memories: [{ name: 'a-b', type: 'user', description: 'd', body: '   ' }],
  }))
  assert.equal(noBody.memories.length, 0, 'an entry without body is dropped individually')

  const coerced = parseExtractionResponse(JSON.stringify({
    memories: [{ name: 'Bad Name', title: 'Good Title', type: 'user', description: 'd', body: 'b' }],
  }))
  assert.equal(coerced.memories[0].name, 'bad-name', 'an unusable name is slug-coerced')
  assert.equal(coerced.memories[0].title, 'Good Title')

  const titleOnly = parseExtractionResponse(JSON.stringify({
    memories: [{ title: 'Runs On Bun', type: 'project', description: 'd', body: 'b' }],
  }))
  assert.equal(titleOnly.memories[0].name, 'runs-on-bun', 'slug falls back to the title')

  assert.equal(parseExtractionResponse('not json'), undefined)
  assert.equal(parseExtractionResponse('[]'), undefined)
  assert.equal(parseExtractionResponse('{"memories":"nope"}'), undefined)
})

test('a pure CJK title without a name falls back to fact-<hash8> and valid neighbors survive', () => {
  const cjk = { title: '用户偏好标签页', type: 'user', description: '更喜欢标签页', body: '用户偏好使用标签页而不是空格。' }
  const mixed = parseExtractionResponse(JSON.stringify({
    memories: [
      cjk,
      { name: 'Bad Name', type: 'nope', description: 'd', body: 'b' },
      { title: 'Runs On Bun', type: 'project', description: 'd', body: 'b' },
    ],
    forget: [],
  }))
  assert.ok(mixed, 'one bad entry no longer abandons the whole reply')
  assert.equal(mixed.memories.length, 2, 'the sluggable neighbor survives the bad one')

  const fallback = mixed.memories[0]
  assert.match(fallback.name, /^fact-[0-9a-f]{8}$/, 'the CJK entry gets the content-hash fallback name')
  assert.equal(fallback.title, '用户偏好标签页', 'the original title is preserved on the pointer')
  assert.equal(isValidMemoryName(fallback.name), true, 'the fallback name is a valid fact name')
  assert.equal(mixed.memories[1].name, 'runs-on-bun')

  // Determinism: the same content always maps to the same name; different
  // content under the same title maps to a different one.
  assert.equal(
    parseExtractionResponse(JSON.stringify({ memories: [cjk] })).memories[0].name,
    fallback.name,
  )
  const other = parseExtractionResponse(JSON.stringify({
    memories: [{ ...cjk, body: '不同的正文内容。' }],
  }))
  assert.notEqual(other.memories[0].name, fallback.name)

  // A valid raw.name always wins over the fallback.
  const named = parseExtractionResponse(JSON.stringify({
    memories: [{ name: 'prefers-tabs', title: '用户偏好标签页', type: 'user', description: 'd', body: 'b' }],
  }))
  assert.equal(named.memories[0].name, 'prefers-tabs')
})

test('pickRoute follows configured → latest → agent → default precedence', () => {
  assert.deepEqual(
    pickRoute({
      requestContext: { provider: 'p-latest', model: 'm-latest' },
      requestHeader: { config: { provider: 'p-header', model: 'm-header' } },
      agentOptions: { provider: 'p-agent', model: 'm-agent' },
      defaultSelection: { provider: 'p-default', model: 'm-default' },
    }),
    { provider: 'p-latest', model: 'm-latest' },
  )
  assert.deepEqual(
    pickRoute({
      requestHeader: { config: { provider: 'p-header', model: 'm-header' } },
      defaultSelection: { provider: 'p-default', model: 'm-default' },
    }),
    { provider: 'p-header', model: 'm-header' },
  )
  assert.deepEqual(
    pickRoute({ agentOptions: { provider: 'p-agent', model: 'm-agent' }, defaultSelection: { provider: 'p', model: 'm' } }),
    { provider: 'p-agent', model: 'm-agent' },
  )
  assert.deepEqual(pickRoute({ defaultSelection: { provider: 'p', model: 'm' } }), { provider: 'p', model: 'm' })
  assert.equal(pickRoute({}), undefined)
  assert.equal(pickRoute({ requestContext: { provider: 'p', model: '' } }), undefined)
  assert.equal(pickRoute(undefined), undefined)
})

import { evaluateIndexReplacement } from '../lib/memory-core.js'

test('evaluateIndexReplacement refuses an index that silently loses pointers', () => {
  const before = '- [A](a.md) - one' + String.fromCharCode(10) + '- [B](b.md) - two' + String.fromCharCode(10)
  const after = '- [A](a.md) - one' + String.fromCharCode(10)
  const verdict = evaluateIndexReplacement(before, after, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.beforeCount, 2)
  assert.equal(verdict.afterCount, 1)
  assert.match(verdict.reason, /refusing to write/)
})

test('evaluateIndexReplacement allows growth and explicit forgets', () => {
  const before = '- [A](a.md) - one' + String.fromCharCode(10) + '- [B](b.md) - two' + String.fromCharCode(10)
  assert.equal(evaluateIndexReplacement(before, before + '- [C](c.md) - three' + String.fromCharCode(10), [], ['c.md']).ok, true)
  assert.equal(evaluateIndexReplacement(before, '- [A](a.md) - one' + String.fromCharCode(10), ['b.md']).ok, true)
})

test('evaluateIndexReplacement allows the very first index of a workspace', () => {
  assert.equal(evaluateIndexReplacement('', '- [A](a.md) - one' + String.fromCharCode(10), []).ok, true)
})

test('evaluateIndexReplacement refuses a same-count index with unrelated content', () => {
  const before = '- [A](a.md) - one' + String.fromCharCode(10) + '- [B](b.md) - two' + String.fromCharCode(10)
  const after = '- [A](a.md) - one' + String.fromCharCode(10) + '- [C](c.md) - three' + String.fromCharCode(10)
  const verdict = evaluateIndexReplacement(before, after, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.beforeCount, 2)
  assert.equal(verdict.afterCount, 2)
  assert.match(verdict.reason, /refusing to write/)
})

test('evaluateIndexReplacement refuses growth that no write in the plan covers', () => {
  const before = '- [A](a.md) - one' + String.fromCharCode(10)
  const verdict = evaluateIndexReplacement(before, before + '- [C](c.md) - three' + String.fromCharCode(10), [])
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /introduces a pointer for c\.md/)
})

test('evaluateIndexReplacement allows an upsert of title or hook for written files', () => {
  const before = '- [A](a.md) - one' + String.fromCharCode(10) + '- [B](b.md) - two' + String.fromCharCode(10)
  const after = '- [A](a.md) - renamed one' + String.fromCharCode(10) + '- [B](b.md) - fresh hook' + String.fromCharCode(10)
  assert.equal(evaluateIndexReplacement(before, after, [], ['a.md', 'b.md']).ok, true)
})

test('evaluateIndexReplacement refuses rewrites of pointers it does not write', () => {
  const before = '- [A](a.md) - one' + String.fromCharCode(10)
  const after = '- [A](a.md) - renamed one' + String.fromCharCode(10)
  const verdict = evaluateIndexReplacement(before, after, [], [])
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /rewrites the pointer for a\.md/)
})

/* ------------------------------------------------------ D4 conflict guidance */

test('factBodyText strips frontmatter and keeps plain bodies', () => {
  const fact = renderFactFile({ name: 'seed', description: 'd', type: 'user', body: 'Keep tabs on.\n\nSecond para.' })
  assert.equal(factBodyText(fact), 'Keep tabs on.\n\nSecond para.')
  assert.equal(factBodyText('no frontmatter here'), 'no frontmatter here')
  assert.equal(factBodyText(''), '')
  assert.equal(factBodyText(undefined), '')
  // CRLF and BOM variants normalize into the same body.
  assert.equal(factBodyText('\uFEFF---\r\nname: x\r\n---\r\n\r\nbody line\r\n'), 'body line')
})

test('findNearDuplicateMatches matches prefixes and edit distance ≤ 2', () => {
  const manifest = [{ name: 'prefers-tabs' }, { name: 'run-tests-first' }, { name: 'ab' }]
  const matches = findNearDuplicateMatches(
    ['prefer-tabs', 'run-tests-fist', 'unrelated-name', 'prefers-tabs'],
    manifest,
  )
  // shared prefix either direction (≥ 3 chars each) or edit distance ≤ 2;
  // the exact name itself is an upsert, not a conflict.
  assert.deepEqual([...matches.keys()], ['prefers-tabs', 'run-tests-first'])
  assert.deepEqual(matches.get('prefers-tabs'), ['prefer-tabs'])
  assert.deepEqual(matches.get('run-tests-first'), ['run-tests-fist'])

  // 'x' → 'ab' is exactly distance 2 (substitute + insert), so it matches.
  assert.deepEqual([...findNearDuplicateMatches(['x'], manifest).keys()], ['ab'])
  assert.equal(findNearDuplicateMatches([], manifest).size, 0)
  assert.equal(findNearDuplicateMatches(['anything'], []).size, 0)
  // 'ab' vs 'abc': prefix needs both sides ≥ 3, but edit distance 1 still hits.
  assert.deepEqual([...findNearDuplicateMatches(['abc'], manifest).keys()], ['ab'])
  // distance ≥ 3 misses.
  assert.equal(findNearDuplicateMatches(['zzzzzz'], manifest).size, 0)
  assert.equal(findNearDuplicateMatches(['abcdefgh'], manifest).size, 0)
})

test('conflictExcerpt truncates on a word boundary inside the cap', () => {
  assert.equal(conflictExcerpt('short body'), 'short body')
  assert.equal(conflictExcerpt(''), '')
  assert.equal(conflictExcerpt(undefined), '')
  const long = Array.from({ length: 80 }, (_v, i) => `word${i}`).join(' ')
  const excerpt = conflictExcerpt(long, 50)
  assert.ok(excerpt.length <= 51)
  assert.ok(excerpt.endsWith('…'))
  assert.ok(excerpt.startsWith('word0'))
  // collapses newlines and repeated spaces
  assert.equal(conflictExcerpt('a\n\n  b\tc'), 'a b c')
})

test('buildConflictGuidance renders excerpts with layer and candidate names', () => {
  const matches = new Map([['prefers-tabs', ['prefer-tabs']]])
  const details = new Map([['prefers-tabs', { excerpt: 'Uses tabs everywhere.', layer: 'workspace' }]])
  const guidance = buildConflictGuidance(matches, details)
  assert.ok(guidance.includes('## Conflicting existing files'))
  assert.ok(guidance.includes('- prefers-tabs (your reply used: prefer-tabs): Uses tabs everywhere.'))
  assert.ok(guidance.includes('update that existing file in place'))

  assert.equal(buildConflictGuidance(new Map(), details), '')
  assert.equal(buildConflictGuidance(undefined, details), '')
  // missing detail degrades to an empty excerpt, not a crash
  const bare = buildConflictGuidance(new Map([['orphan', ['orphan-x']]]), new Map())
  assert.ok(bare.includes('- orphan (your reply used: orphan-x): '))
})

test('buildExtractionPrompt appends conflictGuidance before the conversation', () => {
  const base = buildExtractionPrompt({
    messageCount: 4,
    manifest: [{ name: 'prefers-tabs', description: 'tabs', excerpt: 'b' }],
  })
  assert.ok(!base.includes('## Conflicting existing files'))
  assert.ok(base.includes('- prefers-tabs: tabs'))
  assert.ok(base.endsWith('## Conversation'))

  const guided = buildExtractionPrompt({
    messageCount: 4,
    manifest: [{ name: 'prefers-tabs', description: 'tabs', excerpt: 'b' }],
    conflictGuidance: '\n## Conflicting existing files\n\n- prefers-tabs (your reply used: prefer-tabs): Uses tabs.',
  })
  assert.ok(guided.includes('## Conflicting existing files'))
  assert.ok(guided.indexOf('## Conflicting existing files') < guided.indexOf('## Conversation'))
  assert.ok(guided.endsWith('## Conversation'))
})
