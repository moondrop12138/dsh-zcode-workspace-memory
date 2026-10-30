/**
 * Tests for the ported memory agent loop: the tool schemas the model sees, the
 * journal overlay that stands in for the memory directory, and the bounded
 * turn loop that feeds tool results back.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MEMORY_AGENT_GREP_LIMIT,
  MEMORY_AGENT_MAX_TURNS,
  MEMORY_AGENT_NOOP_TEXT,
  MEMORY_AGENT_TOOL_NAMES,
  buildMemoryAgentTools,
  clampTurns,
  createMemoryJournal,
  isMemoryTool,
  journalToPlan,
  runMemoryAgent,
  runMemoryTool,
  stripFactFrontmatter,
} from '../lib/memory-agent.js'

const FACT_TABS = `---
name: tabs-not-spaces
description: This project indents with tabs
metadata:
  node_type: memory
  type: project
  createdAt: 2026-01-01T00:00:00.000Z
  updatedAt: 2026-01-01T00:00:00.000Z
---

Indent with tabs, never spaces.
`

function makeJournal(records = [], extra = {}) {
  return createMemoryJournal({
    records,
    read: async (fileName) => records.find((record) => `${record.name}.md` === fileName)?.content,
    list: async () => records.map((record) => `${record.name}.md`),
    ...extra,
  })
}

test('buildMemoryAgentTools exposes the six restricted tools', () => {
  const tools = buildMemoryAgentTools()
  assert.equal(tools.length, MEMORY_AGENT_TOOL_NAMES.length)
  assert.deepEqual(tools.map((tool) => tool.name), MEMORY_AGENT_TOOL_NAMES)
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
  }
})

test('buildMemoryAgentTools returns a fresh array each call', () => {
  const first = buildMemoryAgentTools()
  first.push({ name: 'memory_extra' })
  assert.equal(buildMemoryAgentTools().length, MEMORY_AGENT_TOOL_NAMES.length)
})

test('memory_write schema pins the type enum to the memory types', () => {
  const write = buildMemoryAgentTools().find((tool) => tool.name === 'memory_write')
  assert.deepEqual(write.parameters.properties.type.enum, ['user', 'feedback', 'project', 'reference'])
  assert.deepEqual(write.parameters.required, ['name', 'type', 'description', 'body'])
})

test('isMemoryTool only accepts the restricted names', () => {
  assert.equal(isMemoryTool('memory_write'), true)
  assert.equal(isMemoryTool('Write'), false)
  assert.equal(isMemoryTool(undefined), false)
  assert.equal(isMemoryTool('memory_rm_rf'), false)
})

test('journal reads preloaded records and reports missing files', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  assert.equal(await journal.read('tabs-not-spaces'), FACT_TABS)
  assert.equal(await journal.read('not-there'), undefined)
})

test('journal lists facts from records, injected index names and pending writes', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }], {
    list: async () => ['tabs-not-spaces.md', 'MEMORY.md', 'README.md'],
  })
  assert.deepEqual(await journal.list(), ['tabs-not-spaces'])
  await journal.write({ name: 'deploy-pipeline', type: 'project', description: 'how deploys run', body: 'Deploys run from main.' })
  assert.deepEqual(await journal.list(), ['deploy-pipeline', 'tabs-not-spaces'])
})

test('journal write renders frontmatter and keeps the fact readable', async () => {
  const journal = makeJournal()
  const result = await journal.write({
    name: 'deploy-pipeline',
    title: 'Deploy pipeline',
    type: 'project',
    description: 'how deploys run',
    body: 'Deploys run from main.',
  })
  assert.equal(result.ok, true)
  const content = await journal.read('deploy-pipeline')
  assert.match(content, /^---\nname: deploy-pipeline\n/)
  assert.match(content, /type: project/)
  assert.match(content, /Deploys run from main\./)
})

test('journal write rejects invalid names, types and thin bodies', async () => {
  const journal = makeJournal()
  assert.equal((await journal.write({ name: 'Bad Name', type: 'project', description: 'x', body: 'y' })).ok, false)
  assert.equal((await journal.write({ name: 'ok-name', type: 'nope', description: 'x', body: 'y' })).ok, false)
  assert.equal((await journal.write({ name: 'ok-name', type: 'project', description: '', body: 'y' })).ok, false)
  assert.equal((await journal.write({ name: 'ok-name', type: 'project', description: 'x', body: '   ' })).ok, false)
})

test('journal edit keeps createdAt and type, and replaces the body', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  const result = await journal.edit('tabs-not-spaces', 'Indent with tabs everywhere.')
  assert.equal(result.ok, true)
  const content = await journal.read('tabs-not-spaces')
  assert.match(content, /createdAt: 2026-01-01T00:00:00\.000Z/)
  assert.match(content, /type: project/)
  assert.match(content, /Indent with tabs everywhere\./)
  assert.doesNotMatch(content, /Indent with tabs, never spaces\./)
})

test('journal edit reports a missing memory', async () => {
  const journal = makeJournal()
  const result = await journal.edit('not-there', 'body')
  assert.equal(result.ok, false)
  assert.match(result.error, /no memory named/)
})

test('journal remove deletes pending writes and existing facts', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  await journal.write({ name: 'deploy-pipeline', type: 'project', description: 'how deploys run', body: 'Deploys run from main.' })
  assert.equal((await journal.remove('deploy-pipeline')).ok, true)
  assert.equal((await journal.remove('tabs-not-spaces')).ok, true)
  assert.deepEqual(await journal.list(), [])
  assert.deepEqual(journal.deletes().sort(), ['deploy-pipeline', 'tabs-not-spaces'])
})

test('journal remove reports an unknown memory', async () => {
  const journal = makeJournal()
  const result = await journal.remove('not-there')
  assert.equal(result.ok, false)
  assert.match(result.error, /no memory named/)
})

test('journal records one op per call in order', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  await journal.write({ name: 'deploy-pipeline', type: 'project', description: 'how deploys run', body: 'Deploys run from main.' })
  await journal.edit('tabs-not-spaces', 'Indent with tabs everywhere.')
  await journal.remove('deploy-pipeline')
  assert.deepEqual(journal.ops(), [
    { op: 'write', name: 'deploy-pipeline' },
    { op: 'edit', name: 'tabs-not-spaces' },
    { op: 'delete', name: 'deploy-pipeline' },
  ])
})

test('memory_read returns the index without treating it as a fact', async () => {
  const journal = createMemoryJournal({
    read: async (fileName) => (fileName === 'MEMORY.md' ? '- [Tabs](tabs-not-spaces.md) — tabs' : undefined),
    list: async () => ['tabs-not-spaces.md'],
  })
  const result = await runMemoryTool(journal, 'memory_read', JSON.stringify({ name: 'MEMORY.md' }))
  assert.equal(result.ok, true)
  assert.match(result.text, /tabs-not-spaces\.md/)
})

test('memory_read reports a missing memory as a tool error', async () => {
  const result = await runMemoryTool(makeJournal(), 'memory_read', JSON.stringify({ name: 'not-there' }))
  assert.equal(result.ok, false)
  assert.match(result.text, /no memory named/)
})

test('memory_list summarizes each fact with its description', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  const result = await runMemoryTool(journal, 'memory_list', '{}')
  assert.equal(result.ok, true)
  assert.match(result.text, /tabs-not-spaces: This project indents with tabs/)
})

test('memory_list on an empty directory says so', async () => {
  const result = await runMemoryTool(makeJournal(), 'memory_list', '{}')
  assert.equal(result.ok, true)
  assert.match(result.text, /no fact files/)
})

test('memory_grep returns name:line rows for a regex', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  const result = await runMemoryTool(journal, 'memory_grep', JSON.stringify({ pattern: 'indent' }))
  assert.equal(result.ok, true)
  assert.match(result.text, /tabs-not-spaces:\d+: /)
  assert.match(result.text, /Indent/)
})

test('memory_grep falls back to a literal search for an invalid regex', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  const result = await runMemoryTool(journal, 'memory_grep', JSON.stringify({ pattern: '(' }))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'no matches')
})

test('memory_grep caps how many rows one result carries', async () => {
  const body = Array.from({ length: MEMORY_AGENT_GREP_LIMIT + 10 }, (_, index) => `needle ${index}`).join('\n')
  const journal = makeJournal([
    { name: 'long-fact', content: `---\nname: long-fact\ndescription: many needles\nmetadata:\n  type: project\n---\n\n${body}\n` },
  ])
  const result = await runMemoryTool(journal, 'memory_grep', JSON.stringify({ pattern: 'needle' }))
  assert.equal(result.ok, true)
  assert.equal(result.text.split('\n').length, MEMORY_AGENT_GREP_LIMIT)
})

test('memory_grep needs a non-empty pattern', async () => {
  const result = await runMemoryTool(makeJournal(), 'memory_grep', JSON.stringify({ pattern: '' }))
  assert.equal(result.ok, false)
})

test('memory_write tool reports validation failures as tool errors', async () => {
  const result = await runMemoryTool(makeJournal(), 'memory_write', JSON.stringify({
    name: 'deploy-pipeline',
    type: 'nope',
    description: 'd',
    body: 'b',
  }))
  assert.equal(result.ok, false)
  assert.match(result.text, /invalid type/)
})

test('unknown tool names and malformed arguments are values, not throws', async () => {
  const journal = makeJournal()
  assert.equal((await runMemoryTool(journal, 'Write', '{}')).ok, false)
  const malformed = await runMemoryTool(journal, 'memory_read', '{not json')
  assert.equal(malformed.ok, false)
  assert.match(malformed.text, /invalid JSON arguments/)
  const notObject = await runMemoryTool(journal, 'memory_read', '[]')
  assert.equal(notObject.ok, false)
})

test('runMemoryAgent stops on a reply without tool calls', async () => {
  const journal = makeJournal()
  const replies = [{ ok: true, text: MEMORY_AGENT_NOOP_TEXT, toolCalls: [] }]
  let calls = 0
  const result = await runMemoryAgent({
    journal,
    prompt: 'extract',
    callTurn: async () => {
      const reply = replies[calls]
      calls += 1
      return reply
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.turns, 1)
  assert.equal(result.toolCalls, 0)
  assert.equal(result.text, MEMORY_AGENT_NOOP_TEXT)
  assert.equal(calls, 1)
})

test('runMemoryAgent executes tool calls and feeds the results back', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  const seen = []
  let turn = 0
  const result = await runMemoryAgent({
    journal,
    prompt: 'extract',
    callTurn: async ({ messages }) => {
      turn += 1
      seen.push(JSON.parse(JSON.stringify(messages)))
      if (turn === 1) {
        return {
          ok: true,
          text: 'checking existing memories',
          toolCalls: [
            { id: 'call-1', name: 'memory_list', arguments: '{}' },
            { id: 'call-2', name: 'memory_read', arguments: JSON.stringify({ name: 'tabs-not-spaces' }) },
          ],
        }
      }
      return { ok: true, text: 'Nothing to add.', toolCalls: [] }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.turns, 2)
  assert.equal(result.toolCalls, 2)
  const second = seen[1]
  assert.equal(second.length, 3)
  assert.equal(second[2].role, 'user')
  assert.equal(second[2].content.length, 2)
  assert.equal(second[2].content[0].type, 'tool-result')
  assert.match(second[2].content[0].text ?? second[2].content[0].content[0].text, /tabs-not-spaces/)
  assert.equal(second[2].source.kind, 'tool')
})

test('runMemoryAgent records writes made through tools', async () => {
  const journal = makeJournal()
  let turn = 0
  await runMemoryAgent({
    journal,
    prompt: 'extract',
    callTurn: async () => {
      turn += 1
      if (turn === 1) {
        return {
          ok: true,
          text: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'memory_write',
              arguments: JSON.stringify({
                name: 'deploy-pipeline',
                type: 'project',
                description: 'how deploys run',
                body: 'Deploys run from main.',
              }),
            },
          ],
        }
      }
      return { ok: true, text: 'Saved.', toolCalls: [] }
    },
  })
  const plan = journalToPlan(journal)
  assert.equal(plan.memories.length, 1)
  assert.equal(plan.memories[0].name, 'deploy-pipeline')
  assert.equal(plan.memories[0].type, 'project')
  assert.equal(plan.memories[0].description, 'how deploys run')
  assert.equal(plan.memories[0].body, 'Deploys run from main.')
})

test('runMemoryAgent stops at the turn budget and reports exhaustion', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  let calls = 0
  const result = await runMemoryAgent({
    journal,
    prompt: 'extract',
    maxTurns: 2,
    callTurn: async () => {
      calls += 1
      return { ok: true, text: '', toolCalls: [{ id: `call-${calls}`, name: 'memory_list', arguments: '{}' }] }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.turns, 2)
  assert.equal(result.exhausted, true)
  assert.equal(calls, 2)
})

test('runMemoryAgent surfaces a failed model turn without throwing', async () => {
  const result = await runMemoryAgent({
    journal: makeJournal(),
    prompt: 'extract',
    callTurn: async () => ({ ok: false, reason: 'error', detail: 'provider exploded' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'error')
  assert.match(result.detail, /provider exploded/)
})

test('clampTurns bounds the configured budget', () => {
  assert.equal(clampTurns(undefined), MEMORY_AGENT_MAX_TURNS)
  assert.equal(clampTurns(0), 1)
  assert.equal(clampTurns(-5), 1)
  assert.equal(clampTurns(99), 10)
  assert.equal(clampTurns(3.7), 3)
  assert.equal(clampTurns('3'), MEMORY_AGENT_MAX_TURNS)
})

test('journalToPlan forgets facts the agent deleted', async () => {
  const journal = makeJournal([{ name: 'tabs-not-spaces', content: FACT_TABS }])
  await journal.remove('tabs-not-spaces')
  const plan = journalToPlan(journal)
  assert.deepEqual(plan.memories, [])
  assert.deepEqual(plan.forget, ['tabs-not-spaces'])
})

test('journalToPlan keeps the last write for a rewritten memory', async () => {
  const journal = makeJournal()
  await journal.write({ name: 'deploy-pipeline', type: 'project', description: 'first', body: 'first body' })
  await journal.write({ name: 'deploy-pipeline', type: 'project', description: 'second', body: 'second body' })
  const plan = journalToPlan(journal)
  assert.equal(plan.memories.length, 1)
  assert.equal(plan.memories[0].description, 'second')
  assert.equal(plan.memories[0].body, 'second body')
})

test('stripFactFrontmatter returns the body of a fact file', () => {
  assert.equal(stripFactFrontmatter(FACT_TABS).trim(), 'Indent with tabs, never spaces.')
  assert.equal(stripFactFrontmatter('no frontmatter'), 'no frontmatter')
  assert.equal(stripFactFrontmatter(''), '')
})
