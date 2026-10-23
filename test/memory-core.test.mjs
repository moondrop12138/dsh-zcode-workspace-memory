import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MAX_INDEX_CHARS,
  INDEX_FILE,
  INDEX_TRUNCATION_WARNING,
  MAX_INDEX_LINES,
  MEMORY_TYPES,
  buildExtractionPrompt,
  buildManifest,
  buildTranscript,
  countWords,
  deriveTitle,
  evaluateExtraction,
  extractJsonObject,
  factFileName,
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
  slugifyTitle,
  upsertPointer,
} from '../lib/memory-core.js'

const ROOT = 'C:\\work\\demo\\.dsh\\memory'

test('memoryRoot appends .dsh/memory and indexPath names the index', () => {
  assert.equal(memoryRoot('C:\\work\\demo'), 'C:\\work\\demo\\.dsh\\memory')
  assert.equal(indexPath(ROOT), `${ROOT}\\${INDEX_FILE}`)
  assert.equal(isIndexFile('MEMORY.md'), true)
  assert.equal(isIndexFile('memory.md'), false)
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
  assert.equal(safeMemoryPath(ROOT, 'MEMORY.md'), `${ROOT}\\MEMORY.md`)
  assert.equal(safeMemoryPath(ROOT, 'prefers-tabs.md'), `${ROOT}\\prefers-tabs.md`)
  assert.equal(safeMemoryPath(ROOT, '../secret.md'), undefined)
  assert.equal(safeMemoryPath(ROOT, 'sub/prefers-tabs.md'), undefined)
  assert.equal(safeMemoryPath(ROOT, 'C:\\windows\\evil.md'), undefined)
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
  assert.deepEqual(front, {
    name: 'prefers-tabs',
    description: 'User prefers tabs over spaces',
    type: 'user',
    originSessionId: 'session-abc',
  })
  assert.equal(parseFactFrontmatter('no frontmatter'), undefined)
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
    { name: 'prefers-tabs', description: 'tabs' },
    { name: 'broken', description: '' },
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
  assert.equal(parseExtractionResponse(JSON.stringify({ memories: badType })), undefined,
    'one invalid memory abandons the whole reply')

  const noBody = parseExtractionResponse(JSON.stringify({
    memories: [{ name: 'a-b', type: 'user', description: 'd', body: '   ' }],
  }))
  assert.equal(noBody, undefined)

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
  assert.equal(evaluateIndexReplacement(before, before + '- [C](c.md) - three' + String.fromCharCode(10), []).ok, true)
  assert.equal(evaluateIndexReplacement(before, '- [A](a.md) - one' + String.fromCharCode(10), ['b.md']).ok, true)
})

test('evaluateIndexReplacement allows the very first index of a workspace', () => {
  assert.equal(evaluateIndexReplacement('', '- [A](a.md) - one' + String.fromCharCode(10), []).ok, true)
})
