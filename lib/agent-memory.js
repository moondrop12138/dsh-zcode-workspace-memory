/**
 * Agent-scoped memory: the "custom-agent memory layering" that the first port
 * deliberately left out (see `NOTICE.md`).
 *
 * Original work for DSH — there is no ZCode counterpart to copy. ZCode keeps
 * agent memory inside its own out-of-repository CLI store; DSH's `workspace-write`
 * sandbox cannot write there, so this module resolves a *directory per agent key*
 * under the same `.dsh` tree the model can already reach with the native
 * `write` / `edit` tools:
 *
 *   local / project → `<workspaceRoot>/.dsh/agent-memory/<agentKey>/`
 *   user            → `<homeDir>/.dsh/agent-memory/<agentKey>/`
 *
 * The on-disk format is the workspace-memory format unchanged (one fact per
 * file, `name` / `description` / `metadata.type` frontmatter, `MEMORY.md` index
 * with `- [Title](file.md) — hook` pointers), so nothing new has to be parsed:
 * the host reuses `lib/memory-core.js` for every read and write. Only the wording
 * of {@link agentMemoryRulesText} is inherited from `memoryRulesText()`
 * (Apache-2.0, see `NOTICE.md`), shortened to one short paragraph.
 *
 * Pure functions only: no I/O, no Cordis context, no npm dependencies.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { INDEX_FILE, MEMORY_DIR_SEGMENTS, MEMORY_TYPES } from './memory-core.js'

/**
 * Where agent-scoped memory may live. `local` and `project` resolve to the same
 * workspace directory on purpose: DSH has no project registry, so "this project"
 * *is* "this workspace". `user` is the only scope that leaves the workspace.
 */
export const AGENT_MEMORY_SCOPES = Object.freeze(['local', 'project', 'user'])

/**
 * The preset whose sessions use plain workspace memory only. Any other preset
 * gets its own agent memory directory; a subagent without a custom preset gets
 * the shared `subagent` directory.
 */
export const DEFAULT_AGENT_PRESET = 'standard'

/** Directory name appended after `.dsh` for agent-scoped memory. */
export const AGENT_MEMORY_DIR = 'agent-memory'

/** Index file inside one agent memory directory (same name as workspace memory). */
export const AGENT_MEMORY_INDEX = INDEX_FILE

/** Agent key returned for subagent sessions that carry no custom preset. */
const SUBAGENT_AGENT_KEY = 'subagent'

/** Hard cap on a sanitized agent key, in characters (directory-name safety). */
const AGENT_KEY_MAX_LENGTH = 48

/** Prefix and hex length of the fallback key used when sanitizing yields nothing. */
const AGENT_KEY_FALLBACK_PREFIX = 'agent-'
const AGENT_KEY_HASH_LENGTH = 8

/** Characters a key may keep; everything else becomes a dash. */
const ILLEGAL_KEY_CHARACTERS = /[^a-z0-9._-]+/g
/** Runs of dashes (including runs produced by the replacement above). */
const DASH_RUN = /-{2,}/g
/** Leading and trailing dashes. */
const EDGE_DASHES = /^-+|-+$/g

/* ------------------------------------------------------------------- keys */

/**
 * Normalize one agent key into a safe single directory name.
 *
 * Lower-cases, replaces every character outside `[a-z0-9._-]` with `-`, folds
 * dash runs, trims edge dashes, then caps the result at 48 characters. An input
 * that sanitizes to nothing (empty, whitespace, emoji, CJK, punctuation only)
 * falls back to `agent-` plus 8 hex characters of the SHA-256 of the original
 * text, so two different unusable presets never share a directory.
 *
 * Non-string input is treated as the empty string, so `null`, `undefined` and
 * `''` all map to the same deterministic fallback key.
 * @param {unknown} value raw agent key (a preset id, or `subagent`)
 * @returns {string} 1..48 characters of `[a-z0-9._-]`, never starting or ending with `-`
 */
export function sanitizeAgentKey(value) {
  const text = typeof value === 'string' ? value : ''
  const normalized = text
    .toLowerCase()
    .replace(ILLEGAL_KEY_CHARACTERS, '-')
    .replace(DASH_RUN, '-')
    .replace(EDGE_DASHES, '')
  if (normalized.length === 0) {
    const digest = createHash('sha256').update(text, 'utf8').digest('hex')
    return `${AGENT_KEY_FALLBACK_PREFIX}${digest.slice(0, AGENT_KEY_HASH_LENGTH)}`
  }
  if (normalized.length <= AGENT_KEY_MAX_LENGTH) return normalized
  // Truncation can expose a dash that was interior before, so trim again.
  return normalized.slice(0, AGENT_KEY_MAX_LENGTH).replace(EDGE_DASHES, '')
}

/**
 * The agent key of one session, or `undefined` when the session uses plain
 * workspace memory.
 *
 * Precedence: a custom `header.agentPreset` wins over everything, because a
 * subagent running a named preset is that preset's agent, not a generic child.
 * The default preset is not a key: `standard` sessions share workspace memory
 * and therefore resolve to `undefined` unless they are subagents, which resolve
 * to `subagent` (they see the same files read-only).
 *
 * The preset is returned trimmed but otherwise verbatim — path building calls
 * {@link sanitizeAgentKey} on it. Any malformed input (non-object, throwing
 * getters, non-string preset) yields `undefined`; this function never throws.
 * @param {unknown} session session object, possibly `{ header: { agentPreset, origin } }`
 * @returns {string | undefined} preset id, `subagent`, or `undefined`
 */
export function resolveAgentKey(session) {
  try {
    if (!session || typeof session !== 'object') return undefined
    const header = session.header
    if (!header || typeof header !== 'object') return undefined
    const preset = typeof header.agentPreset === 'string' ? header.agentPreset.trim() : ''
    // Compare case-insensitively so `Standard` from a hand-edited profile still
    // means the default, but return the id as written.
    if (preset !== '' && preset.toLowerCase() !== DEFAULT_AGENT_PRESET) return preset
    if (header.origin === SUBAGENT_AGENT_KEY) return SUBAGENT_AGENT_KEY
    return undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ roots */

/**
 * Every directory agent-scoped memory may live in, keyed by scope.
 *
 * `local` and `project` are the same path by design (see
 * {@link AGENT_MEMORY_SCOPES}). A scope whose base directory is missing is
 * `undefined` instead of throwing: `homeDir` is optional on some hosts.
 * @param {{ workspaceRoot?: unknown, homeDir?: unknown, agentKey?: unknown }} input
 * @returns {{ local: string | undefined, project: string | undefined, user: string | undefined } | undefined}
 *   `undefined` when `agentKey` is empty, whitespace, or not a string
 */
export function resolveAgentMemoryRoots(input) {
  const options = input && typeof input === 'object' ? input : {}
  const rawKey = typeof options.agentKey === 'string' ? options.agentKey.trim() : ''
  if (rawKey === '') return undefined
  const key = sanitizeAgentKey(rawKey)
  const workspaceRoot =
    typeof options.workspaceRoot === 'string' && options.workspaceRoot !== '' ? options.workspaceRoot : ''
  const homeDir = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : ''
  // `.dsh` is shared with workspace memory on purpose: one dot-directory, one
  // sandbox root, and `agent-memory/` never collides with `memory/`.
  const workspaceRootPath =
    workspaceRoot === '' ? undefined : join(workspaceRoot, MEMORY_DIR_SEGMENTS[0], AGENT_MEMORY_DIR, key)
  return {
    local: workspaceRootPath,
    project: workspaceRootPath,
    user: homeDir === '' ? undefined : join(homeDir, MEMORY_DIR_SEGMENTS[0], AGENT_MEMORY_DIR, key),
  }
}

/* ------------------------------------------------------------------- text */

/**
 * The short rules paragraph injected with an agent memory index.
 *
 * Deliberately *not* `memoryRulesText()`: that text is the full workspace-memory
 * contract and would duplicate it once per agent. This one only says what is
 * different (this directory belongs to one agent), points at the same
 * frontmatter format and pointer line, and states the storage bar. When `root`
 * is not a usable path the paragraph stays valid but omits the location.
 * @param {unknown} root absolute agent memory directory
 * @returns {string} multi-paragraph Markdown, no trailing newline
 */
export function agentMemoryRulesText(root) {
  const path = typeof root === 'string' ? root.trim() : ''
  const lines = [
    'This is agent-scoped memory: it belongs to this agent only, and other agents and presets never read it.',
  ]
  if (path === '') {
    lines.push(
      'It has its own directory — write to it directly with the `write` and `edit` tools; the directory already exists.',
    )
  } else {
    lines.push(
      `It lives at \`${path}/\` — write to it directly with the \`write\` and \`edit\` tools; the directory already exists.`,
    )
  }
  lines.push(
    '',
    `Write one fact per file, in the same frontmatter format as workspace memory (\`name\`, \`description\`, \`metadata.type\` = ${MEMORY_TYPES.join(' | ')}).`,
    '',
    `After writing a file, add a one-line pointer in \`${AGENT_MEMORY_INDEX}\` in the same directory (\`- [Title](file.md) — hook\`).`,
    '',
    'Store only what is reusable across sessions — how this agent should work, standing preferences, stable constraints. Never store secrets, one-off task state, or anything the repository already records.',
  )
  return lines.join('\n')
}

/**
 * Render the injected agent memory section.
 *
 * Empty input is the common case (a custom agent with no memories yet) and must
 * not produce an empty heading, so either `agentKey` or `indexText` being blank
 * returns `''` and the host skips the section entirely.
 * @param {{ agentKey?: unknown, indexText?: unknown, rulesText?: unknown }} input
 * @returns {string} `## Agent memory (<key>)`, the rules, then the index; or `''`
 */
export function renderAgentMemoryBlock(input) {
  const options = input && typeof input === 'object' ? input : {}
  const agentKey = typeof options.agentKey === 'string' ? options.agentKey.trim() : ''
  const indexText = typeof options.indexText === 'string' ? options.indexText.trim() : ''
  if (agentKey === '' || indexText === '') return ''
  const rulesText = typeof options.rulesText === 'string' ? options.rulesText.trim() : ''
  const parts = [`## Agent memory (${agentKey})`]
  if (rulesText !== '') parts.push(rulesText)
  parts.push(`Contents of \`${AGENT_MEMORY_INDEX}\` (agent memory, persists across sessions):`, indexText)
  return parts.join('\n\n')
}
