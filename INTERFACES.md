# dsh-workspace-memory — frozen cross-half contract

This file is the **frozen interface** between the Host half (`lib/host.js`), the pure core
(`lib/memory-core.js`), and the Client half (`lib/client.js`). Change it only together with all
three files. Anything not written here is an implementation detail.

**Contract version: v2.3 (workspace-only memory + ZCode alignment, 2026-10-31).** Every memory
lives under `<workspaceRoot>/.dsh/memory/` and nothing is shared between workspaces. v2 briefly
added a second, user-global layer at `~/.dsh/memory/`; **v2.1 withdraws it at the user's request** —
see §2.5 and §8 Changelog. **v2.2 closes the five ZCode capability gaps** (related-memory
visibility, retrieval branches, Dream consolidation, extraction cursor, custom-agent roots) without
changing the existing data layout — see §2.6 and §6.12. **v2.3 adds the five-turn restricted tool
loop as the default extraction engine** (`extractionMode` / `agentMaxTurns`, §5.1) and keeps the
one-shot JSON request as the fallback and opt-out. Everything else from v2 (D2–D8 and the
C-series RPC endpoints) is unchanged and listed in **§8 Changelog**.

Porting source: ZCode `apps/zcode-cli/docs/design/v2/memory/README.md` (v4) and
`packages/core/src/{memory,context/sections/memory.ts}`. Deliberate deviations are listed in
`README.md` §"与 ZCode 的差异".

---

## 1. Identity

| Item | Value |
|---|---|
| npm package name | `dsh-workspace-memory` |
| Loader row id (profile patch) | `workspace-memory` |
| Host entry export | `name`, `Config`, `inject`, `apply(ctx, config)` |
| Client module id | `dsh-workspace-memory` (`window.__ModuleLoader__.load({ id, factory })`) |
| Locale namespace | `workspace-memory` (runtime UI), `locale/*.json` = plugin-manager metadata only |
| RPC route | `POST /api/dsh-workspace-memory/call` |

Ready state: the Client may call the RPC before the Host route is registered (plugin still
loading) — the Client MUST treat a transport failure as "host not ready yet" and offer retry.

---

## 2. On-disk data layout

Memory is **per workspace and independent** (v2.1): each workspace owns exactly one root,
`<workspaceRoot>/.dsh/memory/`, identified by the immutable `session.header.cwd` (ZCode's stable
`workspaceRoot` rule; a shell `cd` never retargets it). Fallback when the header has no `cwd`:
`process.cwd()`. All four memory types (§2.4) live there and are visible only from that
workspace; no code path reads or writes a home-directory memory root (§2.5).

```text
<workspaceRoot>/.dsh/memory/
  MEMORY.md              index; no frontmatter; one pointer line per memory
  MEMORY.md.prev         rollback copy of the index, kept by automated writes
  <fact-name>.md         one durable fact per file, YAML frontmatter + Markdown body
  proposals/             consolidation proposals (D8); never facts, never injected
  trash/                 forgotten facts kept for one generation (ring of 50)
  .consolidate-lock      Dream lock + last-consolidated marker (v2.2, §2.6)
  .git/                  optional, user-created: enables the git-commit mode (§3)
<workspaceRoot>/.dsh/memory-state/
  cursor.json            per-session extraction cursor (v2.2, §2.6); not memory content
<workspaceRoot>/.dsh/memory/agent-memory/<agent-key>/
  MEMORY.md + <fact-name>.md   private root for one non-standard agent preset (v2.2, §2.6)
```

* `MEMORY.md` pointer line: `- [Title](fact-name.md) — hook` (em dash U+2014, one line, no
  frontmatter). Written by the model per the injected rules, and maintained by Host extraction
  (`upsertPointer` / `removePointer`).
* Index writes are guarded (`evaluateIndexReplacement` in `lib/memory-core.js`): the current
  index MUST be readable, and the planned index may only lose as many pointer lines as the run
  explicitly forgets. An unreadable `MEMORY.md` aborts the run instead of being read as empty —
  reading it as empty is what used to rewrite the file with a single pointer and drop every
  other line, silently un-linking every other memory.
* Before an automated write replaces the index, the previous text is written to
  `MEMORY.md.prev` (one generation, overwritten each time).
* Diagnostics go to `%TEMP%/workspace-memory-host.log` (log, not debug):
  `read failed for <path> (<where: reason>)`, `index unreadable for <session> (<where: reason>); injecting rules only`,
  `extraction aborted for <session>: index unreadable (...)`, `index write refused for <session>: ...`,
  `index retry failed for <session> (attempt N, next in Xms): <where: reason>` (a failed init index read
  is retried with exponential backoff on later section reads; the last backoff step stops retrying),
  `section refresh failed for <session>: <reason>` (the background post-extraction refresh errored;
  the session keeps its last good section).
* `<fact-name>.md` frontmatter (written by the model or by Host extraction):

  ```markdown
  ---
  name: concise-memory-name
  description: one-line recall description
  metadata:
    node_type: memory
    type: user | feedback | project | reference
    originSessionId: sess_…
    createdAt: 2026-10-24T11:30:00.000Z
    updatedAt: 2026-10-24T11:30:00.000Z
    lastAccessedAt: 2026-10-24T11:35:00.000Z
  ---
  <body; for feedback/project, follow with **Why:** and **How to apply:** lines>
  ```

  Host owns `metadata.node_type`, `metadata.originSessionId`, and the three
  timestamp fields (D2): it fills `createdAt`/`updatedAt` on create, preserves
  the existing `createdAt` and refreshes `updatedAt` on update, and lazily
  rewrites `lastAccessedAt` — batched on a debounce window and under the
  workspace lock — when a model read tool touches the fact file. All three are ISO 8601
  UTC strings. Timestamp fields are **optional on read**: legacy files without
  them parse fine and are never migrated or rewritten just to add them.
  Everything else is prompt-enforced (ZCode has no runtime schema validator;
  neither do we).
* `fact-name` is lowercase kebab-case, 1–48 chars, `/^[a-z0-9][a-z0-9-]*$/`, and MUST NOT be
  `memory` (case-insensitive) because `MEMORY.md` collides with `memory.md` on Windows.
* No other files are read or written under a memory root. `config.json` does **not** exist:
  all switches live in the Host `Config` (§3).
* `proposals/` holds human-review artifacts (`consolidation-<ISO>.md`), never facts: manifest
  scanning (`readManifest`), catalog/catalog-file listing, the index repair pass and snapshot
  export all skip it (`isNonFactEntry`). `trash/` is skipped by the same guard.

### 2.5 Global layer withdrawal (frozen v2.1 decision)

* v2 (D1, 2026-10-24) split memory into a workspace layer and a user-global layer
  `~/.dsh/memory/`, routing `user`/`feedback` facts to the global one. **v2.1 withdraws that
  layer at the user's request:** memory is per-workspace and independent, so a fact belonging to
  one project never leaks into another. `globalRootOf`, `Config.globalMemoryRoot`, type routing,
  and every per-layer loop are gone; `os.homedir()` is never consulted for a memory root.
* All four memory types are written, read, repaired, exported, and imported through the single
  workspace root. `fact-name` is unique per workspace; index, pointer guard, trash, lock, budget,
  activity ring, manifest, and proposals are all scoped to that one root.
* Legacy data: facts v2 had already written to a home-directory layer are **not** read anymore —
  the plugin simply never looks there. To keep them, copy the files into
  `<workspaceRoot>/.dsh/memory/` by hand; nothing runs in the background and no file is moved.
* A v2 export snapshot still imports: `import` validates and applies only the `workspace` layer
  of the manifest and ignores a `global` entry (§6.6).

---

## 3. Host `Config` (the only user-editable switches)

```js
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  autoExtract: z.boolean().default(true).volatile(),
  maxIndexChars: z.number().default(25000).volatile(),
  extractMinIntervalMs: z.number().default(0).volatile(),
  extractDailyLimit: z.number().default(0).volatile(),
  extractProvider: z.string().default('').volatile(),
  extractModel: z.string().default('').volatile(),
  extractionMode: z.string().default('agent').volatile(),
  agentMaxTurns: z.number().default(5).volatile(),
  debugLog: z.boolean().default(false).volatile(),
  gitCommitEnabled: z.boolean().default(true).volatile(),
})
```

Semantics (read live via a `cfg(field, fallback)` helper; `.volatile()` fields are references
with `.get()`):

| Field | Meaning |
|---|---|
| `enabled` | Master switch. `false`: no section, no directory creation, no extraction, no catalog rows. |
| `autoExtract` | Background extraction after a successful turn. `false`: no extraction model request; the model may still write memory itself when the user asks. |
| `maxIndexChars` | Character cap for the injected `MEMORY.md` block (200-line cap is also always applied). |
| `extractMinIntervalMs` | Minimum gap between two extractions of one workspace, milliseconds. `0` (default): no gap. |
| `extractDailyLimit` | Maximum extractions per workspace per local day. `0` (default): unlimited; counting still feeds the panel badge. |
| `extractProvider` | Provider for the background extraction request. `''` (default): use the session route. |
| `extractModel` | Model for the background extraction request. `''` (default): use the session route. |
| `extractionMode` | Extraction engine (v2.3): `'agent'` (default) runs the five-turn restricted tool loop; anything else (notably `'json'`) keeps the one-shot JSON request. |
| `agentMaxTurns` | Assistant-turn budget for the tool loop (v2.3, default `5`, clamped to 1–10); ignored in `'json'` mode. |
| `debugLog` | Append Host diagnostics to `%TEMP%/workspace-memory-host.log` (best effort). |
| `gitCommitEnabled` | Commit the workspace memory root when it is **already** a git repository, after every successful write (`export`/`import` included). Only effective when `<workspaceRoot>/.dsh/memory/.git` exists; the Host never runs `git init`, never blocks the turn (children spawn with `stdio: 'ignore'`), and a git failure is only logged. |

Extraction route resolution: when `extractProvider`/`extractModel` are set they override the
session route field by field (`extractRoute()` → `pickRoute()` → configured value wins); both
empty keeps the session route exactly as before, and both set makes extraction independent of
whatever model the session is using (e.g. a cheaper model for extraction).

Scope of effect: **profile-global** (the switches); memory content is per workspace. Eligible sessions are main
sessions; subagent sessions (`session.header.origin === 'subagent'`) get the section
read-only — the index is injected, but they never write: no extraction, no index repair,
no directory creation.

---

## 4. Host → model: the injected section

Registered once at plugin apply, on the root context:

```js
ctx.systemPrompt.section({
  name: 'workspace-memory:instructions',
  order: 450,
  text: (context) => memorySectionText(context.agent),   // synchronous
})
```

* Provider is **synchronous** and returns `''` for ineligible agents / a cache miss. A miss
  self-heals on the next assembly (every step assembles the prompt again).
* The cache is filled in the awaited serial `agent/created` listener:
  read the workspace `MEMORY.md` through `ctx.fs`; missing / unreadable / empty → rules only.
* The section text is ZCode `buildMemoryContent` adapted for DSH (Write → `write`/`edit`,
  absolute memory root, `AGENTS.md` instead of `CLAUDE.md`, one added read-before-write
  sentence) and is **frozen** in `lib/memory-core.js` (`memoryRulesText`). When an index is
  non-empty it is appended under
  `Contents of <MEMORY_ROOT>/MEMORY.md (workspace memory, persists across sessions):`.
* **One layer only (v2.1):** the section is rendered from the workspace `MEMORY.md` alone —
  there is no second, global block and no cross-workspace content. The rules text points at the
  absolute workspace memory root; a missing or unreadable index degrades to rules only.
* The index rendering is `formatIndexContent`: strip BOM, CRLF→LF, strip leading YAML
  frontmatter, strip top-level HTML comment lines, trim, keep the first 200 lines, then cap at
  `maxIndexChars` characters, appending
  `> WARNING: MEMORY.md is too large. Only part of it was loaded. Keep index entries to one line; move detail into fact files.`
* **Relevance ranking before truncation (roadmap D3):** the first user message of a session
  that carries a keyword signal becomes the session's ranking query (`noteSessionQuery` in
  `lib/host.js`); it is passed to `buildMemorySection` as `query` and applied to the workspace
  index block. Pointer lines are reordered by lightweight keyword overlap —
  `queryTermsForRanking` (ASCII words minus stop words + a trailing-`s` stem, CJK characters
  and adjacent bigrams), `scoreIndexPointer` (title hit ×2, hook ×1, file name ×1) — through
  `reorderIndexForQuery`, which is **stable**: ties and zero-score pointers keep the original
  file order. The reordering runs **before** the 200-line and `maxIndexChars` truncations, so
  an old but relevant preference survives a cap that file order would have cut. The ordering
  only shapes the injected copy: `MEMORY.md` on disk is never rewritten, and a session with
  no keyword-bearing message injects the index byte-for-byte as before.
* Write-invalidate-reread semantics (roadmap C6): after a Host extraction changed the
  workspace memory, the host re-reads and re-renders the section in the background
  (`refreshAgentSection`), so the **next turn of the same session** already sees the new
  pointers. A failed refresh keeps the last good text and never touches the retry backoff;
  a successful refresh also clears an obsolete B3 retry state for that Agent.

---

Sessions running the `minimal` preset are excluded from the read side: the host
never initializes them, so `MEMORY.md` is not resolved or read and `text(...)`
returns an empty string (the write side is excluded in section 5).

## 5. Host extraction (background, after a successful turn)

* Trigger: `session/event` where `event.type === 'turn/end'` and
  `event.data.reason.kind === 'completed'`, observed on `agent.ctx`.
* Gate: `enabled`, `autoExtract`, eligible session, and
  `ctx.sandboxPolicy.resolve({ session }).mode !== 'read-only'`.
* Excluded: `session.header.agentPreset === 'minimal'` — a minimal run never
  reads the index and never writes facts, the index, or `MEMORY.md.prev`.
* Skip rules (ZCode parity, `evaluateExtraction`):
  * the turn contains a write/edit whose arguments mention the workspace memory root →
    `direct-memory-write`;
  * no independent user text block with ≥ 3 word units → `no-user-prose`. One word unit is a
    whitespace-separated token, or half of a CJK character rounded up (ZCode's whitespace-only
    rule never fires for Chinese prose); the port adds the CJK half because DSH is used in
    Chinese as much as in English.
* Scheduling: one running slot + one latest-pending slot per Agent, fire-and-forget; the
  plugin-level and per-Agent `AbortController` abort on plugin unload / `agent/disposed`.
* Request: `ctx.llm.stream({ provider, model, system: memoryRulesText(root), messages: [user] })`
  with `maxTokens: 1200`, `sessionId: agent.session.id`, `signal`. Route precedence:
  `session.requestContext()` → `session.requestHeader()?.config` → `agent.options` →
  `ctx.agentDefaultModel.currentSelection()`; no route → skip (never invent one). Roadmap D5:
  non-empty `extractProvider`/`extractModel` Config values override the resolved route field by
  field; both set makes extraction independent of the session model (a cheap extraction model).
* Input: the turn's user + assistant **text** blocks only (no reasoning, no tool arguments),
  tail-capped at 24,000 characters, plus the existing manifest. The manifest (v2.1) is
  **single-root**: up to 50 entries, each `{ name, description, excerpt }` where `excerpt` is
  the fact body collapsed to one line and capped at 600 chars (used only by the conflict re-ask
  below). The prompt describes the four memory types and tells the model that every type lives
  in the same per-workspace directory, so dedupe and `forget` choices are made against that one
  manifest — there is no layer to pick.
* Conflict re-ask (roadmap D4, exactly one extra call): when a parsed reply names files that
  near-match existing manifest entries — shared prefix either direction with both names ≥ 3
  chars, or bounded Levenshtein distance ≤ 2 (`findNearDuplicateMatches`) — the Host re-asks
  once with a `## Conflicting existing files` block appended to the prompt. The block lists each
  matched existing file, the reply's names that hit it, and its body excerpt
  (`buildConflictGuidance` / `conflictExcerpt`), and asks the model to update that file in place
  instead of creating a near-duplicate. A conflict-free reply costs exactly one call; an
  unusable re-ask reply (no parseable JSON) falls back to the first plan. The extra call shares
  the same run budget and turn guard as the first, and both calls sit inside the workspace write
  lock only at apply time.
* Segmented extraction (roadmap D6): a turn whose rendered transcript exceeds 24,000 characters
  is split by `buildTranscriptSegments(messages, MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_SEGMENTS)`
  (`MAX_TRANSCRIPT_SEGMENTS = 3`) into at most three contiguous message groups, each ≤ 24,000
  chars. Groups are extracted one call at a time and merged by `name` via `mergeExtractionPlans`
  (later segment wins, first-seen order kept; `forget` is a set union). The merged plan then goes
  through the **single** D4 conflict re-ask and the **single** locked write pass. A segmented turn
  still consumes exactly one budget unit (`extractMinIntervalMs` / `extractDailyLimit` /
  `catalog.todayCount`), because the budget is reserved once per turn before `extractOnce`.
  When even `3 × 24,000` chars cannot hold the turn, whole oldest messages are dropped — the same
  truncation direction as `buildTranscript`. A short turn is one segment and one call, unchanged.
* Output: plain JSON in the reply text (no structured-output seam), parsed by
  `parseExtractionResponse`:

  ```json
  {"memories":[{"name":"kebab-slug","title":"Title","type":"user|feedback|project|reference",
                "description":"one line","body":"markdown","why":"…","howToApply":"…"}],
   "forget":["existing-fact-name"]}
  ```

  `{"memories":[],"forget":[]}` means "nothing to save". A parse failure or
  `finish.reason !== 'stop'` discards the whole result: no partial writes, no retry. An entry
  whose title cannot be slugged (e.g. pure CJK) gets the fallback name `fact-<hash8>` (SHA-256 of
  its content, 8 hex chars); an entry failing validation (invalid type, missing description/body)
  is dropped individually while the rest of the batch proceeds.
* Write (v2.1): max 5 memories per run, **all into the workspace root** — every `type` lands in
  `<workspaceRoot>/.dsh/memory/` through
  `ctx.fs.writeText(target, content, undefined, signal, policy)`; there is no type-based routing.
  The workspace index is updated with the run's pointers, guarded by
  `evaluateIndexReplacement`. A failed or refused write aborts the remaining stages of the run
  (facts → index → forgets) and never leaves a half-written index.
  `forget` copies the fact file into `<workspaceRoot>/.dsh/memory/trash/` via
  `ctx.fs.writeText` and then unlinks the original with `node:fs/promises.unlink` (the `ctx.fs`
  seam has no delete); the trash keeps the newest 50 files by mtime. A missing file or a failed
  trash copy leaves the original untouched.
* Nothing is appended to the session log (DSH does not allow plugin-defined event types).
  `debugLog` is the only trace.
* **Consolidation proposals (D8):** after the applied write, a workspace whose fact count exceeds
  `PROPOSAL_FACT_THRESHOLD` (60) gets one
  `<workspaceRoot>/.dsh/memory/proposals/consolidation-<ISO>.md`
  written through `ctx.fs` — three fixed sections (near-duplicate names via the existing
  edit-distance/prefix rule, description-overlap contradiction candidates, facts whose
  `lastAccessedAt` is older than `PROPOSAL_STALE_DAYS` = 90) plus a fenced `json` marker with
  the full machine-readable item list. At most 50 items per section are rendered (the marker
  keeps them all). Nothing is applied: the file is advisory, `proposals/` is skipped by every
  fact scan (`isNonFactEntry`), and accepting it is an explicit `proposals-accept` call (§6.8).
* A successful apply also runs the optional git hook on the touched root (§3): spawn
  `git add -A` then `git commit`, `stdio: 'ignore'`, never awaited by the turn.

### 5.1 Extraction engine: five-turn restricted tool loop (v2.3)

`extractionMode = 'agent'` (the default) replaces the single JSON request with a plugin-driven
tool loop modeled on ZCode's Memory Agent. The loop runs inside the Host; the plugin never
registers tools on `ctx.tools`, so the main session's tool list is untouched.

* Tools (six, in-process, memory directory only): `memory_read` `{name}`,
  `memory_list` `{}`, `memory_grep` `{pattern, limit?}` (at most `MEMORY_AGENT_GREP_LIMIT` = 50
  hits, literal fallback when the pattern is not a valid RegExp), `memory_write`
  `{name, title, type, description, body}`, `memory_edit` `{name, body, description?}`,
  `memory_delete` `{name}` (moves to trash, never a hard delete).
* Request: `ctx.llm.stream({ …, tools: buildMemoryAgentTools() })` — `ToolSchema` objects go out
  with every turn; the reply stream is collected by `collectStreamTurn` (text deltas, tool-call
  deltas, `block-end` tool-call blocks, `finish` of kind `stop` or `tool-calls`).
* Message shape: each assistant turn is one message whose content is the optional text block
  followed by the tool-call blocks; each tool round-trip is one `user` message whose content is
  the `tool-result` blocks with `source: { kind: 'tool', callId }`.
* Budget: at most `agentMaxTurns` assistant turns (`MEMORY_AGENT_MAX_TURNS = 5` by default,
  clamped 1–10). A turn with no tool call ends the loop with its text. Text that parses as the
  one-shot JSON plan is used directly (the model may answer without tools); otherwise the
  journal's writes and deletes become the plan via `journalToPlan`.
* Fallback: a provider error, an exhausted loop with no journal writes and no text, or an
  unparseable non-empty reply reruns the same segment once with the one-shot prompt (no `tools`).
  The agent path skips the D4 conflict re-ask; a JSON text plan inside agent mode still goes
  through it.
* Writes: the loop never touches disk. `journalToPlan` feeds the same `planExtractionWrites` →
  `applyExtraction` path, so `MEMORY.md` repair, `evaluateIndexReplacement`, the 5-per-run cap,
  trash semantics and the workspace lock are identical in both modes.
* Trace: `recordActivity` entries and the `debugLog` line carry `engine: 'agent'` plus `turns`
  and `toolCalls`; `extractionMode: 'json'` records `engine: 'json'`.

---

## 6. RPC contract (Client → Host)

### 6.1 Envelope

Request `POST /api/dsh-workspace-memory/call`, body:

```json
{ "rpcId": "<opaque string>", "type": "client-request",
  "method": "dsh-workspace-memory/call",
  "payload": { "endpoint": "catalog" | "read" | "activities" | "session-state" | "export" | "import" | "proposals" | "proposals-accept" | "fact-read" | "fact-save" | "fact-delete" | "trash-list" | "trash-restore" | "dream-run" | "dream-status" | "retrieval", "payload": { } } }
```

Response (HTTP 200):

```json
{ "type": "server-response", "rpcId": "<echo>",
  "result": { "ok": true, "value": { } } }
```

Failure result:

```json
{ "type": "server-response", "rpcId": "<echo>",
  "result": { "ok": false, "error": { "code": "…", "message": "…", "details": { } } } }
```

The framework rewrites this envelope (`dsh-client-connection` `parseConnectionResponse`):
success arrives at the Client as `{ ok: true, value }` (a `data` field is dropped), failure as
`{ ok: false, error: { code, message, details: object } }`. Clients accept `value` first, then
`data`, for forward compatibility. Error codes used here: `bad-request`, `not-ready`, `disabled`,
`unavailable`, `unknown-endpoint`, `unknown-path`, `invalid-path`, `read-failed`,
`invalid-manifest`, `invalid-snapshot`, `nothing-to-import`, `write-refused`,
`already-accepted`, `invalid-name`, `invalid-fact`, `not-found`, `already-exists`,
`trash-failed`, `index-unreadable`, `index-full`, `write-failed`, `error`.

### 6.2 `catalog`

Payload: `{}`. An optional `"sessionId"` string may be added; it is only a hint and must
resolve to a live session already tracked by the Host to widen visibility.

```ts
interface Catalog {
  config: { enabled: boolean; autoExtract: boolean }
  workspaces: Array<{
    path: string            // absolute workspace root
    title: string           // basename for display
    memoryRoot: string      // <path>/.dsh/memory (workspace memory root)
    layer?: 'workspace'
                            // v2.1: always 'workspace' when present; the field stays
                            // optional so older/newer clients keep parsing the payload
    files: Array<{
      name: string          // file name: 'MEMORY.md' or '<fact>.md'
      kind: 'index' | 'fact'
      type?: 'user' | 'feedback' | 'project' | 'reference'
                            // facts only; parsed from frontmatter, absent when
                            // missing/invalid (C4, backward-compatible addition)
      size: number
      updatedAt: number     // epoch ms, 0 when unknown
      createdAt: number     // v2/D2: facts only, epoch ms parsed from frontmatter
                            // metadata.createdAt, 0 when unknown
      lastAccessedAt: number
                            // v2/D2: facts only, epoch ms parsed from frontmatter
                            // metadata.lastAccessedAt, 0 when unknown
    }>
    todayCount: number      // extractions of this workspace today (in-memory, resets on restart)
    lastAt: number          // epoch ms of the last extraction, 0 when unknown
  }>
}
```

Sources (v2.1): the workspace whitelist — `ctx.workspaceRegistry.list()` — plus the requesting
session's own workspace when the payload carries a `sessionId` that resolves to a live tracked
session, deduped by path, sorted by path. Only workspaces are listed: there is no global row.
Session cwds are not enumerated: a request without a resolvable `sessionId` cannot list
workspaces beyond the whitelist. Workspaces without a memory directory are omitted (the page
shows an empty state instead of an error). Only `MEMORY.md` and lowercase `*.md` files are listed. Fact entries additionally
carry `type`, parsed from the file's frontmatter `metadata.type` and validated against the four
memory types; the field is absent (not null) when the frontmatter is missing or the value is
invalid. Facts also carry the three host-maintained timestamps as epoch ms (`createdAt`,
`updatedAt`, `lastAccessedAt`; D2, backward-compatible addition): each is parsed from the
frontmatter and is `0` when the file lacks the field (legacy data) or the value does not parse.
Annotating is budget-bounded (`CATALOG_TYPE_TIMEOUT_MS`, 5 s per catalog call) so a
slow disk cannot stall the page; files whose read did not finish in time simply omit `type`
(and report `0` timestamps).

### 6.3 `read`

Payload: `{ "path": "<workspaceRoot>", "name": "<file name>" }`.

```ts
interface ReadValue { path: string /* absolute file path */; content: string; truncated: boolean }
```

Validation (both required): the workspace must be one returned by `catalog` (**or** an
absolute path that normalizes to one of them), and `name` must be `MEMORY.md` or a valid fact
file name. The Host resolves `<path>/.dsh/memory/<name>` and re-checks containment with
`ctx.fs.contains`. Content is capped at 256 KiB (tail kept, `truncated: true`).

Switches are Host `Config` (§3); memory content is written by the model, by extraction, or by
the three write endpoints in §6.5–§6.7 — no endpoint edits a fact body.

### 6.5 `export`

Payload: `{ "path": "<workspaceRoot>", "targetDir": "<absolute directory>" }`.
Creates `<targetDir>/workspace-memory-export-<ISO stamp>/` — the stamp has `:` and `.` replaced
with `-` so it is a legal Windows name — and copies the workspace memory root into a
`workspace/` subdirectory, plus a manifest at the snapshot root:

```ts
interface ExportManifest {
  format: 'dsh-workspace-memory-export'
  version: 1
  createdAt: string                 // ISO timestamp
  layers: Array<{
    layer: 'workspace'              // v2.1: always exactly one 'workspace' entry
    root: string                    // absolute memory root that was copied
    files: Array<{ name: string; kind: 'index' | 'fact'; bytes: number; sha256: string }>
  }>
}
```

Zero dependencies: this only reads the roots through `ctx.fs` and writes plain files
(no archive library, no tar/zip). `proposals/` and `trash/` are excluded — they are bookkeeping,
not memory. Succeeds with `{ dir, manifestPath, createdAt, fileCount, layers }`.

### 6.6 `import`

Payload: `{ "path": "<workspaceRoot>", "dir": "<snapshot dir>", "layers"?: ['workspace'] }`.
`layers` is still accepted for shape compatibility but only `'workspace'` selects anything; a
v2 snapshot's `global` entry is ignored and never written into a workspace.

Two-phase, never partially applied:

1. **Validate first** — the manifest must parse, carry `format`/`version` of this plugin, and
   every listed file must exist under `<dir>/workspace/<name>`, be `MEMORY.md` or a valid fact
   name, and match its recorded `bytes` **and** `sha256`. Any mismatch aborts with
   `invalid-manifest` / `invalid-snapshot` / `nothing-to-import` **before the first write**, so
   the memory root is untouched.
2. **Write second** — under the same per-root mutex as extraction (`runWithWorkspaceLocks`),
   through the same guarded path: identical content is skipped (re-import is a no-op),
   `MEMORY.md` gets a `MEMORY.md.prev` backup, and a conflicting fact is moved to `trash/`
   before the new body lands (nothing is deleted outright).

A successful import runs the git-commit hook (§3) for the root it touched.

### 6.7 `proposals`

Payload: `{ "path": "<workspaceRoot>" }` (v2.1: the workspace memory root only — there is no
second layer to scan).

```ts
interface Proposals {
  proposals: Array<{
    layer: 'workspace'
    root: string            // workspace memory root the proposal belongs to
    name: string            // file name, consolidation-<ISO>.md
    createdAt: string
    factCount: number       // fact count when the proposal was produced
    threshold: number       // 60
    counts: { nearDuplicates: number; contradictions: number; stale: number }
    acceptedAt: string      // '' until accepted
    items: Array<{ kind: 'near-duplicate' | 'contradiction' | 'stale'; keep?: string; drop?: string[]; a?: string; b?: string; reason?: string; name?: string }>
  }>
  layers: Array<{ layer: 'workspace'; root: string }>
  threshold: number
}
```

Only `consolidation-*.md` files under a root's `proposals/` directory are listed, newest first;
the directory itself is never treated as memory. Proposals are produced by the extraction
pipeline when the workspace holds **more than** 60 facts (`PROPOSAL_FACT_THRESHOLD`), see §5 — they
are advisory files and are never applied automatically.

### 6.8 `proposals-accept`

Payload: `{ "path": "<workspaceRoot>", "name": "consolidation-<ISO>.md", "keep"?: string[] }`.

Applies **only** the near-duplicate delete items of one proposal: with an explicit `keep` list,
every drop target except the listed names is removed; otherwise each cluster keeps its `keep`
entry. The write goes through the guarded path — index pointers removed (`removePointer`),
`MEMORY.md.prev` backup, dropped files moved to `trash/`, the proposal's marker stamped with
`acceptedAt` + `acceptedItems`, and the git hook runs (§3). `evaluateIndexReplacement` must
still approve the new index, otherwise the call fails with `write-refused` and nothing is
written. Re-accepting an already-accepted proposal returns `already-accepted`; contradiction
and stale sections are advisory only and never auto-applied.

### 6.4 `activities`

Payload: `{}` (an optional `"sessionId"` hint is accepted, same semantics as `catalog`).

```ts
interface Activities {
  activities: Array<{
    at: number              // epoch ms when the extraction was applied
    workspace: string       // absolute workspace root
    wrote: string[]         // fact file names written this run
    forgot: string[]        // fact file names moved to trash this run
    diffSummary: string     // short '+N -M' style summary, '(no index change)' when absent
    indexBefore: string     // MEMORY.md text before the run ('' when not captured)
    indexAfter: string      // MEMORY.md text after the run ('' when not captured)
  }>
}
```

Backward-compatible addition: entries are recorded in-memory only (lost on restart) into a
per-**memory-root** ring buffer keeping the most recent ~50 applied extractions
(`ACTIVITY_KEEP`) — the key is the workspace memory root path, so independent workspaces have
independent rings. Visibility uses the same workspace set as `catalog` (whitelist plus the
resolvable session's workspace), results are sorted newest first, and the Client filters by the
workspace it shows. A workspace without recorded
activity simply yields an empty list.

### 6.9 `session-state`

Payload: `{ "sessionId"?, "skipTurnExtraction"?: boolean }` (v2; roadmap C2). Reading and writing
are the same endpoint: when `skipTurnExtraction` is present it is applied to the resolved session
before the value is returned.

```ts
interface SessionState {
  sessionId: string | null      // null when the hint did not resolve to a live tracked session
  skipTurnExtraction: boolean   // session-scoped, in-memory only, never persisted
}
```

The session id is the same *hint* as everywhere else (`sourceSessionId`): it must resolve to a
session the Host is currently tracking, so a forged id yields `{ sessionId: null,
skipTurnExtraction: false }` and writes nothing. The flag lives on the per-session record, is
reset when the session ends, and is checked in `turn/end` **before** any budget accounting — a
skipped turn issues no model request at all. It is deliberately not a `Config` field: it is
session state, not a persistent user preference, so the frozen `Config` surface (§3) is unchanged.

### 6.10 `fact-read` / `fact-save` / `fact-delete` (v0.2.0, roadmap C3)

Panel write surface. Every endpoint resolves `path` through the same workspace set as `catalog`
(plugin whitelist plus the resolvable session's own workspace) — an arbitrary filesystem path is
`unknown-path`, never a write target — and every write runs inside
`runWithWorkspaceLocks(plugin, [key], "<label>", …)` with `evaluateIndexReplacement` approving the
new `MEMORY.md` before anything lands. The fact file and its pointer therefore move in **one**
critical section, and the host's existing trash helper, `MEMORY.md.prev` rollback copy, optional
git hook and section refresh are reused as-is.

`fact-read` — payload `{ "path": "<workspaceRoot>", "name": "<fact name or file name>" }`:

```ts
interface FactRead {
  name: string            // bare kebab name ('prefers-tabs')
  fileName: string        // '<name>.md'
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string     // frontmatter description ('' when absent)
  body: string            // body after the frontmatter, trimmed
  originSessionId: string // '' when the fact predates sessions or was written by hand
  createdAt: string       // ISO-8601, '' when absent
  updatedAt: string       // ISO-8601, '' when absent
}
```

`fact-save` — payload `{ "path", "name", "type", "description", "body" }` creates or replaces one
fact. Validation: the name must be `isValidMemoryName` (kebab-case, 1–48 chars, not `memory`) or
`invalid-name`; `type` must be one of the four `MEMORY_TYPES`; a blank description, a blank body or
an over-length field is `invalid-fact`. On update the existing `createdAt` and `originSessionId` are
preserved and `updatedAt` is re-stamped; a create mints both timestamps. The file write and the
`upsertPointer` (title from the name, hook from the description) happen together, so a refused index
(`write-refused`, `index-full`) leaves neither a new file nor a new pointer behind. Refuses with
`index-unreadable` when `MEMORY.md` cannot be read rather than rebuilding it blind.

```ts
interface FactSave {
  name: string
  fileName: string
  created: boolean        // true when the fact did not exist before this call
  createdAt: string
  updatedAt: string
  indexChanged: boolean   // false when the pointer line was already byte-identical
}
```

`fact-delete` — payload `{ "path", "name" }` removes the pointer and moves the file into
`<memory-root>/trash/` (the same helper extraction `forget` uses), then `trimTrash` applies the
50-file retention. Order matters: the pointer goes first, so a failed trash move can only leave an
unlinked fact file (which index repair re-links) — never a pointer to a missing file. `not-found`
when the fact is gone; `trash-failed` when the move fails after the pointer was dropped.

```ts
interface FactDelete {
  name: string
  fileName: string
  trashed: true
  indexChanged: boolean
  removedPointers: number  // duplicate pointer lines are all counted
}
```

### 6.11 `trash-list` / `trash-restore` (v0.2.0, roadmap C3)

`trash-list` — payload `{ "path" }` lists the restorable files of `<memory-root>/trash/`, newest
first by modification time, capped at `TRASH_LIST_MAX`. Files with names that are not valid fact
files are skipped, so the panel never offers a restore that the host would refuse.

```ts
interface TrashList {
  root: string            // workspace memory root the listing came from
  keep: number            // TRASH_KEEP: how many files retention keeps (50)
  entries: Array<{ name: string; fileName: string; size: number; modifiedAt: number }>
}
```

`trash-restore` — payload `{ "path", "name" }` moves one trashed fact back into the memory root and
re-adds its pointer (`upsertPointer`, hook from the trashed file's description) under the same lock
and guard. `not-found` when no trashed file carries that name; `already-exists` when a live fact with
that name is present — the live file is **never** overwritten. `write-refused` / `index-full` behave
exactly as in `fact-save`, and `MEMORY.md` is rewritten through the shared `replaceIndexText` path.

```ts
interface TrashRestore {
  name: string
  fileName: string
  restored: true
  indexChanged: boolean
}
```

---

### 6.12 `dream-run` / `dream-status` / `retrieval` (v2.2, ZCode alignment)

All three are additive and read-or-manual: nothing here changes extraction or injection.

* `dream-status` — payload `{ "sessionId", "workspace"? }`. Resolves a live session record, or (when
  only `workspace` is given) a synthetic record for a workspace in the catalog whitelist; answers
  `failure('unknown-workspace', …)` otherwise. Returns
  `{ autoEnabled: false, running, lastConsolidatedAt, lastRunAt, lastResult }` plus the timing gate
  (`nextDecision`, `nextReason`) and `lockPath`.
* `dream-run` — payload `{ "sessionId", "workspace"?, "force"? }`. Runs at most one consolidation
  pass (one plugin-wide slot). The pass is gated by `evaluateDreamTiming` (24h minimum interval,
  10-minute scan throttle, ≥5 sessions) unless `force: true`; it takes `.consolidate-lock`
  (1h freshness + live PID) and refuses with `reason: 'locked' | 'busy' | 'gated' | 'not-writable' |
  'read-only-session'`. A successful pass leaves the lock file in place as the last-consolidated
  marker; a failed pass restores its previous mtime. Any writes go through the same guarded path as
  extraction (§5), so `MEMORY.md.prev`, the index guard and the trash ring all apply.
* `retrieval` — payload `{}`. Reports `{ branch, active, recallBudgetChars }`. `branch` is
  `'default-index'` while the shipped constant `SEMANTIC_RECALL_ENABLED = false` (ZCode's
  `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED`) leaves the semantic branch off; it is **not** a Config
  switch, matching upstream. The semantic branch, when flipped in code, selects at most 5 facts with
  a 256-token selector request, caps a fact at 200 lines / 4096 bytes, keeps a 61,440-character
  session budget and annotates facts older than 48h.

## 7. Client halves and seats

| Seat | Registration | Props |
|---|---|---|
| `sidebar.panellist` (list) | `{ name, id: 'workspace-memory', order: 30, locale: NS, label: () => t('panel') }` | owner `{ size, active }` |
| `main` (keyed) | `{ name: 'main', key: 'workspace-memory', locale: NS, inject: () => ({ requestCatalog, requestFile, requestActivities, requestToggleSkip }) }` | `t`, `requestCatalog()`, `requestFile(path, name)`, `requestActivities()`, `requestToggleSkip(skip)` |

* Client injects only `slots` and `locale`; it resolves `connection` lazily with
  `ctx.get('connection')` and treats a missing RPC as `host-unavailable`.
* Markdown is **not** rendered (no importable renderer is allowed for a plain-JS plugin): the
  file body is shown in a monospace `<pre>`.
* Styles are one injected `<style>` with `.dwm-` prefixed classes; colors come only from
  `--dsw-alias-*` theme tokens (live contract: `cordis_inspect_query` client `Theme.listTokens`).
* The page must work with **no session selected** (data comes from the RPC, not from the
  right bar), and must show `enabled` / `autoExtract` state read-only, pointing at the plugin
  settings page for changes.
* The file list is filtered client-side (C4): a type chip row (`all` + the four memory types)
  and a keyword input match fact names and fact types; index files match by name only. Below
  `VIRTUAL_LIST_MIN` (60) entries it renders a plain list, above that a fixed-row windowed
  list (`windowFiles`) with spacer pads and an `onScroll` handler — zero dependencies.
* The panel renders catalog rows as workspaces, one row per workspace memory root (v2.1: no
  global row). `layer` stays an optional `'workspace'` field, so a client that predates v2
  keeps working and all other shapes are unchanged.

### 7.1 Panel editing and the trash view (v0.2.0, roadmap C3)

The panel is **no longer read-only**. It owns no filesystem access of its own: every mutation is one
call to §6.10/§6.11, and the page re-reads `catalog` after each success, so what the panel shows is
what the guarded write landed.

| Surface | Behaviour | Endpoint |
|---|---|---|
| List header | `New fact` button opens the editor with an empty draft (`creating: true`, type `user`). | — |
| Fact body | `Edit` / `Delete` actions appear only for `kind: 'fact'` rows; `MEMORY.md` has no actions. | — |
| Editor | One hook-free form in the main body: name (editable on create, **read-only on update**), type `<select>` over the four types, description `<input>`, body `<textarea>`, `Save` / `Cancel`, inline error line (`role="alert"`). The name field is the only immutable one on update — renaming is delete + create. | `fact-read`, `fact-save` |
| Delete | Two-step inline confirm (`删除后可在回收站恢复`), never `window.confirm`. | `fact-delete` |
| Trash view | Section listing `name` / size / relative time newest first, each row with `Restore`. | `trash-list`, `trash-restore` |

Client-side validation mirrors the host (`validateFactDraft`) so an obviously bad draft never leaves
the page, but the host re-validates everything: the client is not a security boundary. Every
user/memory string reaches the DOM as a React child — no `dangerouslySetInnerHTML`, no `innerHTML` —
so a fact body cannot inject markup, and the same `.dwm-*` classes plus `--dsw-alias-*` tokens style
the editor, the confirm row and the trash rows. `trash-restore` errors are shown inline in the trash
view (`already-exists` names the collision instead of silently doing nothing).

---

## 8. Changelog

Every item below is an **additive, backward-compatible** change (new optional fields, new
endpoints, new volatile `Config` keys). A v1 client keeps working against a v0.2.1 Host, and old
memory files parse. The one deliberate removal is the v2 global layer, withdrawn in v2.1.

### 2.6 ZCode-alignment state (v2.2)

* `memory-state/cursor.json` — `{ version: 1, sessions: { "<sessionId>": { boundaryId, at, attempts } } }`.
  `boundaryId` is `<sessionId>:<seq>` of the last message an extraction covered; `success` and `no-op`
  advance it, `error`/`abort` keep it and bump `attempts`, so an uncovered turn is replayed on the
  next extraction. The window keeps at least the segmentation capacity (3 × 24,000 characters).
  A corrupt file degrades to an empty cursor instead of failing the plugin.
* `agent-memory/<agent-key>/` — private memory root for a session whose `header.agentPreset` is a
  non-empty value other than `standard` (wrapped in `failures`, plus `subagent` sessions keyed by
  origin). `standard` presets and main sessions keep the workspace root. The
  `agent-memory/` subtree is created lazily by the first automated write; the injected section keeps
  the same rules/index shape with the agent root path.
* Related-memory excerpts are computed per extraction run from the 24,000-character transcript tail
  against the existing manifest (max 8 entries, 400 characters each, 3,200 characters total). They
  are appended to the extraction prompt only; they never change the injected section.

### v2.3.0 — five-turn restricted tool loop, 2026-10-31

| Change | Item | Where |
|---|---|---|
| Default extraction engine is a plugin-driven five-turn tool loop (`lib/memory-agent.js`): six `memory_*` tools carried on `llm.stream({ tools })`, host executes them and replays `tool-result` blocks | W6 | §5.1 |
| `Config.extractionMode` (`'agent'` default) and `Config.agentMaxTurns` (5, clamped 1–10); `'json'` restores the one-shot request | W6 | §3, §5.1 |
| Fallback to the one-shot prompt when the loop errors, exhausts its budget without writes, or replies unparseably; JSON text inside agent mode is still parsed | W6 | §5.1 |
| Writes keep going through `planExtractionWrites` / `applyExtraction` — the model proposes, the Host writes; `recordActivity` carries `engine` / `turns` / `toolCalls` | W6 | §5.1 |
| Agent mode skips the D4 conflict re-ask (the loop can read the manifest itself); JSON-text plans still run it | W6 | §5.1 |

### v2.2.0 — ZCode capability alignment (W1–W5), 2026-10-30

| Change | Item | Where |
|---|---|---|
| Extraction prompt gains a "possibly related existing memories" block (8 entries, 400 chars each, 3,200 total) derived from the transcript tail | W1 | §2.6, §5 |
| Retrieval branches implemented (`default-index` / `semantic-recall`, selector + 5 items + 61,440-char budget + stale annotation); the switch is the code constant `SEMANTIC_RECALL_ENABLED = false`, as upstream | W2 | §6.12 |
| Dream consolidation ported: timing gate (24h / 10min / ≥5 sessions), `.consolidate-lock`, four-phase prompt, guarded apply; manual `dream-run` only, no scheduler | W3 | §2.6, §6.12 |
| Per-session extraction cursor persisted in `memory-state/cursor.json`; failure keeps the boundary so messages are replayed | W4 | §2.6 |
| Non-standard agent presets get their own memory root under `agent-memory/<key>/` | W5 | §2.6 |
| New endpoints `dream-run`, `dream-status`, `retrieval` | W1–W3 | §6.12 |



| Change | Landed | Specified in |
|---|---|---|
| Global layer `~/.dsh/memory/` removed at the user's request; memory is per-workspace and independent | v2.1 | §2, §2.5 |
| `Config.globalMemoryRoot`, `globalRootOf()`, type-based routing, and per-layer loops deleted; `os.homedir()` never consulted | v2.1 | §2.5, §3 |
| Injection renders the workspace index only (no merged global block) | v2.1 | §4 |
| `catalog` / `read` / `export` / `import` / `proposals` / `activities` accept and return workspace roots only; `layer` is at most `'workspace'` | v2.1 | §6 |
| A v2 export snapshot still imports: its `global` entry is ignored, `workspace` is applied | v2.1 | §6.6 |

### v2.0.0 — dual layer (D1), 2026-10-24 — *superseded by v2.1*

| Change | Landed | Specified in |
|---|---|---|
| Second memory layer `~/.dsh/memory/` (user-global); `type` routes user/feedback global, project/reference workspace | D1 | §2, §2.5 |
| Injection merges both layers, **global first**, each capped independently | D1 | §4 |
| `catalog` rows gain optional `layer` (`'workspace'` or `'global'`); absent in old payloads | D1 | §6.2 |
| `export` / `import` / `activities` accept the global layer root as `path` | D1 | §6.4–6.6 |
| v1 data is **read in place**, never auto-moved | D1 | §2.5 |

### Added after D1 (all under v2), 2026-10-24 → 2026-10-25

| Change | Landed | Specified in |
|---|---|---|
| `createdAt` / `updatedAt` frontmatter (host-minted, `createdAt` preserved on update) | D2 | §2 |
| `lastAccessedAt` frontmatter, lazily rewritten on a read hit, debounced batch flush | D2 | §2 |
| `catalog` fact entries gain `createdAt` / `updatedAt` / `lastAccessedAt` (backward-compatible) | D2 | §6.2 |
| Injection order becomes relevance-ranked per session's first keyword-bearing user message; **display only**, never rewrites `MEMORY.md` | D3 | §4 |
| Conflict re-ask: near-duplicate `name` (prefix, both ≥ 3 chars, or edit distance ≤ 2) appends the existing body excerpt (≤ 600 chars) and asks **once** more | D4 | §5 |
| `Config.extractProvider` / `Config.extractModel` (volatile, default `''` = session route) | D5 | §3 |
| Long turns extract in ≤ 3 segments (≤ 24 000 chars each) merged by `name`, then one conflict re-ask and **one** guarded write; still counts as one extraction | D6 | §5 |
| `export`: zero-dependency directory snapshot + `manifest.json` (`format`, `version`, `createdAt`, per-file `bytes` + `sha256`); `trash/` and `proposals/` excluded | D7 | §6.5 |
| `import`: validate **everything** before writing a single byte; error codes `invalid-manifest` / `invalid-snapshot` / `nothing-to-import`; then guarded write under the per-root lock | D7 | §6.6 |
| `Config.gitCommitEnabled` (volatile, default `true`): detached `git add -A` + `git commit` only when `<workspaceRoot>/.dsh/memory/.git` already exists; never `git init`, never blocks the turn | D7 | §3 |
| `proposals`: `proposals/consolidation-<ISO>.md`, three fixed sections, `json` marker with counts, `PROPOSAL_FACT_THRESHOLD = 60`, `PROPOSAL_STALE_DAYS = 90` | D8 | §5, §6.7 |
| `proposals-accept`: applies **only** near-duplicate deletes through the guarded write; `already-accepted` on replay | D8 | §6.8 |
| `proposals/` is not a fact: excluded from the manifest, catalog, index repair, and snapshots | D8 | §2, §6.2 |
| `activities` endpoint (in-memory ring, `ACTIVITY_KEEP ≈ 50`, keyed by workspace memory root) | C1 | §6.4 |
| `session-state` endpoint + `skipTurnExtraction` per-session flag | C2 | §6.9 |
| `catalog` fact entries gain `type` (read from frontmatter under a 5 s budget; index rows stay untyped) | C4 | §6.2 |
| `catalog` gains per-workspace `{ todayCount, lastAt }` extraction counters | B2 | §6.2 |
| Subagent sessions register **read-only** (section only; no directory, no repair write, no extraction) | C7 | §4 |
| Extraction write triggers a background section refresh (same-session visibility) | C6 | §4 |
| RPC visibility narrowed to registry whitelist ∪ the resolving source session's workspace | B1 | §6.2, §6.4 |
| `fact-read` / `fact-save` / `fact-delete` + `trash-list` / `trash-restore`: panel create/edit/delete and restorable trash, all writes under the per-root lock and the index guard | C3 | §6.10, §6.11, §7.1 |

### Not in v2 (deferred, deliberately)

* **C5 Markdown rendering** — the file body is rendered as monospace `<pre>` (§7); a white-list
  renderer is required before this can change.
