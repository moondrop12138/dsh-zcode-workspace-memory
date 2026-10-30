import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  AGENT_MEMORY_DIR,
  AGENT_MEMORY_INDEX,
  AGENT_MEMORY_SCOPES,
  DEFAULT_AGENT_PRESET,
  agentMemoryRulesText,
  renderAgentMemoryBlock,
  resolveAgentKey,
  resolveAgentMemoryRoots,
  sanitizeAgentKey,
} from '../lib/agent-memory.js'
import { MEMORY_TYPES, memoryRulesText } from '../lib/memory-core.js'

// Absolute fixture roots so `node:path` builds the expected shape on any host.
const WORKSPACE = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'
const HOME = process.platform === 'win32' ? 'C:\\Users\\demo' : '/home/demo'
const FALLBACK_KEY = /^agent-[0-9a-f]{8}$/
const KEY_PATTERN = /^[a-z0-9._-]+$/

/* ------------------------------------------------------------- constants */

test('contract constants are frozen and point at the agent-memory directory', () => {
  assert.deepEqual([...AGENT_MEMORY_SCOPES], ['local', 'project', 'user'])
  assert.equal(DEFAULT_AGENT_PRESET, 'standard')
  assert.equal(AGENT_MEMORY_DIR, 'agent-memory')
  assert.equal(AGENT_MEMORY_INDEX, 'MEMORY.md')
  assert.equal(Object.isFrozen(AGENT_MEMORY_SCOPES), true)
})

/* --------------------------------------------------------- resolveAgentKey */

test('a custom preset outranks the subagent origin', () => {
  assert.equal(resolveAgentKey({ header: { agentPreset: 'minimal', origin: 'subagent' } }), 'minimal')
  assert.equal(resolveAgentKey({ header: { agentPreset: 'cordis', origin: 'subagent' } }), 'cordis')
})

test('the default preset is not an agent key', () => {
  assert.equal(resolveAgentKey({ header: { agentPreset: 'standard' } }), undefined)
  assert.equal(resolveAgentKey({ header: { agentPreset: 'standard', origin: 'user' } }), undefined)
  // Case-insensitive: a hand-edited `Standard` is still the default, so a
  // subagent running it falls back to the shared subagent key.
  assert.equal(resolveAgentKey({ header: { agentPreset: 'Standard' } }), undefined)
  assert.equal(resolveAgentKey({ header: { agentPreset: 'Standard', origin: 'subagent' } }), 'subagent')
})

test('non-subagent sessions without a custom preset have no agent key', () => {
  assert.equal(resolveAgentKey({ header: {} }), undefined)
  assert.equal(resolveAgentKey({ header: { origin: 'user' } }), undefined)
  assert.equal(resolveAgentKey({ header: { origin: 'main' } }), undefined)
})

test('subagent sessions resolve to the shared subagent key', () => {
  assert.equal(resolveAgentKey({ header: { origin: 'subagent' } }), 'subagent')
  assert.equal(resolveAgentKey({ header: { agentPreset: '', origin: 'subagent' } }), 'subagent')
  assert.equal(resolveAgentKey({ header: { agentPreset: '   ', origin: 'subagent' } }), 'subagent')
})

test('the preset is trimmed but keeps its case', () => {
  assert.equal(resolveAgentKey({ header: { agentPreset: '  Minimal  ' } }), 'Minimal')
})

test('malformed sessions return undefined instead of throwing', () => {
  const inputs = [
    undefined,
    null,
    0,
    '',
    'standard',
    [],
    {},
    { header: null },
    { header: 'standard' },
    { header: 42 },
    { header: { agentPreset: 42 } },
    { header: { agentPreset: null } },
    { header: { agentPreset: {} } },
    { header: { agentPreset: ['minimal'] } },
  ]
  for (const input of inputs) {
    assert.equal(resolveAgentKey(input), undefined, `input ${JSON.stringify(input)}`)
  }
  // A throwing getter must be swallowed too: the session object comes from the
  // host and one bad header must not take the whole section down.
  const hostile = {
    get header() {
      throw new Error('boom')
    },
  }
  assert.equal(resolveAgentKey(hostile), undefined)
  const hostilePreset = {
    header: {
      get agentPreset() {
        throw new Error('boom')
      },
    },
  }
  assert.equal(resolveAgentKey(hostilePreset), undefined)
})

/* -------------------------------------------------------- sanitizeAgentKey */

test('sanitizeAgentKey lower-cases and keeps the allowed punctuation', () => {
  assert.equal(sanitizeAgentKey('Minimal'), 'minimal')
  assert.equal(sanitizeAgentKey('SUBAGENT'), 'subagent')
  assert.equal(sanitizeAgentKey('v2.1_beta-rc'), 'v2.1_beta-rc')
})

test('sanitizeAgentKey turns illegal characters into single dashes', () => {
  assert.equal(sanitizeAgentKey('My Agent'), 'my-agent')
  assert.equal(sanitizeAgentKey('a/b\\c'), 'a-b-c')
  assert.equal(sanitizeAgentKey('a---b'), 'a-b')
  assert.equal(sanitizeAgentKey('a - b'), 'a-b')
  assert.equal(sanitizeAgentKey('--x--'), 'x')
  assert.equal(sanitizeAgentKey('!!!hello???world!!!'), 'hello-world')
})

test('sanitizeAgentKey falls back to a hashed key when nothing survives', () => {
  const empty = sanitizeAgentKey('')
  assert.match(empty, FALLBACK_KEY)
  // Deterministic, and different unusable presets never share a directory.
  assert.equal(sanitizeAgentKey(''), empty)
  assert.match(sanitizeAgentKey('中文'), FALLBACK_KEY)
  assert.match(sanitizeAgentKey('✨✨'), FALLBACK_KEY)
  assert.notEqual(sanitizeAgentKey('中文'), sanitizeAgentKey('✨✨'))
  // Non-strings are treated as empty input, never as a throw.
  assert.equal(sanitizeAgentKey(undefined), empty)
  assert.equal(sanitizeAgentKey(null), empty)
  assert.equal(sanitizeAgentKey(42), empty)
})

test('sanitizeAgentKey caps the key at 48 characters', () => {
  const long = 'x'.repeat(120)
  const key = sanitizeAgentKey(long)
  assert.equal(key.length, 48)
  assert.equal(key, 'x'.repeat(48))

  // Truncation must not leave an edge dash behind.
  const dashed = sanitizeAgentKey(`${'a'.repeat(47)}-tail`)
  assert.equal(dashed.length, 47)
  assert.equal(dashed.endsWith('-'), false)

  // Every sanitized key is usable as one directory segment.
  for (const input of ['Minimal', 'My Agent', '', '中文', long, 'a/b']) {
    const out = sanitizeAgentKey(input)
    assert.ok(out.length > 0 && out.length <= 48, `length of ${JSON.stringify(out)}`)
    assert.match(out, KEY_PATTERN)
    assert.equal(out.startsWith('-'), false)
    assert.equal(out.endsWith('-'), false)
  }
})

/* ---------------------------------------------------- resolveAgentMemoryRoots */

test('local and project both point into the workspace', () => {
  const roots = resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: 'minimal' })
  const expected = join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal')
  assert.equal(roots.local, expected)
  assert.equal(roots.project, expected)
})

test('user points into homeDir, not the workspace', () => {
  const roots = resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: 'minimal' })
  assert.equal(roots.user, join(HOME, '.dsh', AGENT_MEMORY_DIR, 'minimal'))
  assert.equal(roots.user.startsWith(WORKSPACE), false)
  assert.equal(roots.local.startsWith(HOME), false)
})

test('the agent key is sanitized before it becomes a directory name', () => {
  const roots = resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: 'My Agent' })
  assert.equal(roots.local, join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'my-agent'))
  assert.equal(roots.user, join(HOME, '.dsh', AGENT_MEMORY_DIR, 'my-agent'))
  // A whitespace-only key still counts as empty, not as a hashed directory.
  assert.equal(resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: '   ' }), undefined)
})

test('an empty or missing agent key yields undefined', () => {
  assert.equal(resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: '' }), undefined)
  assert.equal(resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME }), undefined)
  assert.equal(resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: 7 }), undefined)
  assert.equal(resolveAgentMemoryRoots({}), undefined)
  assert.equal(resolveAgentMemoryRoots(undefined), undefined)
  assert.equal(resolveAgentMemoryRoots(null), undefined)
})

test('a missing base directory makes only that scope undefined', () => {
  const noHome = resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, agentKey: 'minimal' })
  assert.equal(noHome.local, join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal'))
  assert.equal(noHome.user, undefined)

  const noWorkspace = resolveAgentMemoryRoots({ homeDir: HOME, agentKey: 'minimal' })
  assert.equal(noWorkspace.local, undefined)
  assert.equal(noWorkspace.project, undefined)
  assert.equal(noWorkspace.user, join(HOME, '.dsh', AGENT_MEMORY_DIR, 'minimal'))
})

test('resolveAgentMemoryRoots does not mutate its input', () => {
  const input = { workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: 'Minimal' }
  resolveAgentMemoryRoots(input)
  assert.deepEqual(input, { workspaceRoot: WORKSPACE, homeDir: HOME, agentKey: 'Minimal' })
})

/* --------------------------------------------------- agentMemoryRulesText */

test('agentMemoryRulesText names the root and stays short', () => {
  const root = join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal')
  const text = agentMemoryRulesText(root)
  assert.equal(text.includes(root), true)
  assert.equal(text.includes('agent-scoped'), true)
  assert.equal(text.includes('reusable across sessions'), true)
  assert.equal(text.includes(AGENT_MEMORY_INDEX), true)
  // Same frontmatter vocabulary as workspace memory, listed from MEMORY_TYPES.
  for (const type of MEMORY_TYPES) assert.equal(text.includes(type), true)
})

test('agentMemoryRulesText is a short paragraph, not a copy of memoryRulesText', () => {
  const root = join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal')
  const short = agentMemoryRulesText(root)
  const full = memoryRulesText(root)
  assert.notEqual(short, full)
  assert.ok(short.length < full.length / 2, `short=${short.length} full=${full.length}`)
  // The parts that make memoryRulesText the full contract are absent here.
  assert.equal(short.includes('```markdown'), false)
  assert.equal(short.includes('never shared with another one'), false)
  assert.equal(short.includes('AGENTS.md'), false)
})

test('agentMemoryRulesText survives a missing root without inventing a path', () => {
  for (const input of [undefined, null, '', 42, {}]) {
    const text = agentMemoryRulesText(input)
    assert.ok(text.length > 0)
    assert.equal(text.includes('undefined'), false)
    assert.equal(text.includes('null'), false)
    assert.equal(text.includes('`/`'), false)
  }
})

/* ------------------------------------------------- renderAgentMemoryBlock */

test('renderAgentMemoryBlock returns an empty string for blank input', () => {
  const rulesText = 'rules'
  assert.equal(renderAgentMemoryBlock({ agentKey: '', indexText: '- [A](a.md) — hook', rulesText }), '')
  assert.equal(renderAgentMemoryBlock({ agentKey: '   ', indexText: '- [A](a.md) — hook', rulesText }), '')
  assert.equal(renderAgentMemoryBlock({ agentKey: 'minimal', indexText: '', rulesText }), '')
  assert.equal(renderAgentMemoryBlock({ agentKey: 'minimal', indexText: '   ', rulesText }), '')
  assert.equal(renderAgentMemoryBlock({ agentKey: 'minimal', rulesText }), '')
  assert.equal(renderAgentMemoryBlock({ agentKey: 'minimal', indexText: 42 }), '')
  assert.equal(renderAgentMemoryBlock({}), '')
  assert.equal(renderAgentMemoryBlock(undefined), '')
})

test('renderAgentMemoryBlock renders the heading, rules and index', () => {
  const root = join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal')
  const rulesText = agentMemoryRulesText(root)
  const indexText = '- [Deploy ritual](deploy-ritual.md) — how releases go out'
  const block = renderAgentMemoryBlock({ agentKey: 'minimal', indexText, rulesText })
  assert.equal(block.startsWith('## Agent memory (minimal)'), true)
  assert.equal(block.includes(rulesText), true)
  assert.equal(block.includes(indexText), true)
  assert.equal(block.includes(root), true)
  assert.equal(block.endsWith(indexText), true)
  assert.equal(block.includes('## Agent memory (minimal)\n\n'), true)
})

test('renderAgentMemoryBlock works without a rules paragraph', () => {
  const indexText = '- [Deploy ritual](deploy-ritual.md) — how releases go out'
  const block = renderAgentMemoryBlock({ agentKey: 'subagent', indexText })
  assert.equal(block.startsWith('## Agent memory (subagent)'), true)
  assert.equal(block.includes(indexText), true)
  // Still a section, never a bare index dump.
  assert.equal(block.includes('Contents of'), true)
})

test('renderAgentMemoryBlock uses the agent key verbatim as the label', () => {
  const block = renderAgentMemoryBlock({ agentKey: 'Minimal', indexText: '- [A](a.md) — hook', rulesText: 'r' })
  assert.equal(block.startsWith('## Agent memory (Minimal)'), true)
})

/* ------------------------------------------------------- integration shape */

test('resolve → sanitize → roots → render compose into one section', () => {
  const session = { header: { agentPreset: 'Minimal', cwd: WORKSPACE } }
  const agentKey = resolveAgentKey(session)
  assert.equal(agentKey, 'Minimal')
  const roots = resolveAgentMemoryRoots({ workspaceRoot: WORKSPACE, homeDir: HOME, agentKey })
  assert.equal(roots.local, join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal'))
  const indexText = '- [Deploy ritual](deploy-ritual.md) — how releases go out'
  const block = renderAgentMemoryBlock({
    agentKey,
    indexText,
    rulesText: agentMemoryRulesText(roots.local),
  })
  assert.equal(block.startsWith('## Agent memory (Minimal)'), true)
  assert.equal(block.includes(join(WORKSPACE, '.dsh', AGENT_MEMORY_DIR, 'minimal')), true)
  assert.equal(block.includes(indexText), true)

  // The default preset produces no section at all.
  assert.equal(resolveAgentKey({ header: { agentPreset: 'standard', cwd: WORKSPACE } }), undefined)
})
