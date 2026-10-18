# dsh-workspace-memory — frozen cross-half contract

This file is the **frozen interface** between the Host half (`lib/host.js`), the pure core
(`lib/memory-core.js`), and the Client half (`lib/client.js`). Change it only together with all
three files. Anything not written here is an implementation detail.

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

Memory belongs to the **workspace** of the session, identified by the immutable
`session.header.cwd` (ZCode's stable `workspaceRoot` rule; a shell `cd` never retargets it).
Fallback when the header has no `cwd`: `process.cwd()`.

```text
<workspaceRoot>/.dsh/memory/
  MEMORY.md              index; no frontmatter; one pointer line per memory
  <fact-name>.md         one durable fact per file, YAML frontmatter + Markdown body
```

* `MEMORY.md` pointer line: `- [Title](fact-name.md) — hook` (em dash U+2014, one line, no
  frontmatter). Written by the model per the injected rules, and maintained by Host extraction
  (`upsertPointer` / `removePointer`).
* `<fact-name>.md` frontmatter (written by the model or by Host extraction):

  ```markdown
  ---
  name: concise-memory-name
  description: one-line recall description
  metadata:
    node_type: memory
    type: user | feedback | project | reference
    originSessionId: sess_…
  ---
  <body; for feedback/project, follow with **Why:** and **How to apply:** lines>
  ```

  Host owns `metadata.node_type` and `metadata.originSessionId`: it fills them on create and
  preserves the existing `originSessionId` on update. Everything else is prompt-enforced
  (ZCode has no runtime schema validator; neither do we).
* `fact-name` is lowercase kebab-case, 1–48 chars, `/^[a-z0-9][a-z0-9-]*$/`, and MUST NOT be
  `memory` (case-insensitive) because `MEMORY.md` collides with `memory.md` on Windows.
* No other files are read or written under the memory root. `config.json` does **not** exist:
  all switches live in the Host `Config` (§3).

---

## 3. Host `Config` (the only user-editable switches)

```js
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  autoExtract: z.boolean().default(true).volatile(),
  maxIndexChars: z.number().default(25000).volatile(),
  debugLog: z.boolean().default(false).volatile(),
})
```

Semantics (read live via a `cfg(field, fallback)` helper; `.volatile()` fields are references
with `.get()`):

| Field | Meaning |
|---|---|
| `enabled` | Master switch. `false`: no section, no directory creation, no extraction, no catalog rows. |
| `autoExtract` | Background extraction after a successful turn. `false`: no extraction model request; the model may still write memory itself when the user asks. |
| `maxIndexChars` | Character cap for the injected `MEMORY.md` block (200-line cap is also always applied). |
| `debugLog` | Append Host diagnostics to `%TEMP%/workspace-memory-host.log` (best effort). |

Scope of effect: **profile-global**; content is per workspace. Eligible sessions are main
sessions only (`session.header.origin !== 'subagent'`).

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
* The cache is filled once per Agent in the awaited serial `agent/created` listener:
  read `<root>/MEMORY.md` through `ctx.fs`; missing / unreadable / empty → rules only.
* The section text is ZCode `buildMemoryContent` adapted for DSH (Write → `write`/`edit`,
  absolute memory root, `AGENTS.md` instead of `CLAUDE.md`, one added read-before-write
  sentence) and is **frozen** in `lib/memory-core.js` (`memoryRulesText`). When the index is
  non-empty it is appended under
  `Contents of <MEMORY_ROOT>/MEMORY.md (workspace memory, persists across sessions):`.
* The index rendering is `formatIndexContent`: strip BOM, CRLF→LF, strip leading YAML
  frontmatter, strip top-level HTML comment lines, trim, keep the first 200 lines, then cap at
  `maxIndexChars` characters, appending
  `> WARNING: MEMORY.md is too large. Only part of it was loaded. Keep index entries to one line; move detail into fact files.`
* Read-once semantics: `MEMORY.md` is not re-read for the lifetime of an Agent. Memories
  written mid-session (by the model or by extraction) become visible in the **next** session.

---

## 5. Host extraction (background, after a successful turn)

* Trigger: `session/event` where `event.type === 'turn/end'` and
  `event.data.reason.kind === 'completed'`, observed on `agent.ctx`.
* Gate: `enabled`, `autoExtract`, eligible session, and
  `ctx.sandboxPolicy.resolve({ session }).mode !== 'read-only'`.
* Skip rules (ZCode parity, `evaluateExtraction`):
  * the turn contains a write/edit whose arguments mention the memory root → `direct-memory-write`;
  * no independent user text block with ≥ 3 word units → `no-user-prose`. One word unit is a
    whitespace-separated token, or half of a CJK character rounded up (ZCode's whitespace-only
    rule never fires for Chinese prose); the port adds the CJK half because DSH is used in
    Chinese as much as in English.
* Scheduling: one running slot + one latest-pending slot per Agent, fire-and-forget; the
  plugin-level and per-Agent `AbortController` abort on plugin unload / `agent/disposed`.
* Request: `ctx.llm.stream({ provider, model, system: memoryRulesText(root), messages: [user] })`
  with `maxTokens: 1200`, `sessionId: agent.session.id`, `signal`. Route precedence:
  `session.requestContext()` → `session.requestHeader()?.config` → `agent.options` →
  `ctx.agentDefaultModel.currentSelection()`; no route → skip (never invent one).
* Input: the turn's user + assistant **text** blocks only (no reasoning, no tool arguments),
  tail-capped at 24,000 characters, plus the existing manifest (up to 50 entries: `name` +
  `description`).
* Output: plain JSON in the reply text (no structured-output seam), parsed by
  `parseExtractionResponse`:

  ```json
  {"memories":[{"name":"kebab-slug","title":"Title","type":"user|feedback|project|reference",
                "description":"one line","body":"markdown","why":"…","howToApply":"…"}],
   "forget":["existing-fact-name"]}
  ```

  `{"memories":[],"forget":[]}` means "nothing to save". Parse failures, invalid entries, or
  `finish.reason !== 'stop'` discard the whole result: no partial writes, no retry.
* Write: max 5 memories per run, through
  `ctx.fs.writeText(target, content, undefined, signal, ctx.sandboxPolicy.resolve({ session }))`.
  Index is updated after all fact files are written. `forget` uses `node:fs/promises.unlink`
  (the `ctx.fs` seam has no delete) and is a no-op for a missing file.
* Nothing is appended to the session log (DSH does not allow plugin-defined event types).
  `debugLog` is the only trace.

---

## 6. RPC contract (Client → Host)

### 6.1 Envelope

Request `POST /api/dsh-workspace-memory/call`, body:

```json
{ "rpcId": "<opaque string>", "type": "client-request",
  "method": "dsh-workspace-memory/call",
  "payload": { "endpoint": "catalog" | "read", "payload": { } } }
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
`data`, for forward compatibility. Error codes used here: `bad-request`, `not-ready`,
`unknown-endpoint`, `invalid-path`, `read-failed`, `error`.

### 6.2 `catalog`

Payload: `{}`.

```ts
interface Catalog {
  config: { enabled: boolean; autoExtract: boolean }
  workspaces: Array<{
    path: string            // absolute workspace root
    title: string           // basename for display
    memoryRoot: string      // <path>/.dsh/memory
    files: Array<{
      name: string          // file name: 'MEMORY.md' or '<fact>.md'
      kind: 'index' | 'fact'
      size: number
      updatedAt: number     // epoch ms, 0 when unknown
    }>
  }>
}
```

Sources: `ctx.workspaceRegistry.list()` ∪ every live session's `session.header.cwd`, deduped by
path, sorted by path. Workspaces without a memory directory are omitted (the page shows an
empty state instead of an error). Only `MEMORY.md` and lowercase `*.md` files are listed.

### 6.3 `read`

Payload: `{ "path": "<workspaceRoot>", "name": "<file name>" }`.

```ts
interface ReadValue { path: string /* absolute file path */; content: string; truncated: boolean }
```

Validation (both required): the workspace must be one returned by `catalog` (**or** an
absolute path that normalizes to one of them), and `name` must be `MEMORY.md` or a valid fact
file name. The Host resolves `<path>/.dsh/memory/<name>` and re-checks containment with
`ctx.fs.contains`. Content is capped at 256 KiB (tail kept, `truncated: true`).

No write endpoint exists: switches are Host `Config`, memory content is written by the model or
by extraction.

---

## 7. Client halves and seats

| Seat | Registration | Props |
|---|---|---|
| `sidebar.panellist` (list) | `{ name, id: 'workspace-memory', order: 30, locale: NS, label: () => t('panel') }` | owner `{ size, active }` |
| `main` (keyed) | `{ name: 'main', key: 'workspace-memory', locale: NS, inject: () => ({ requestCatalog, requestFile }) }` | `t`, `requestCatalog()`, `requestFile(path, name)` |

* Client injects only `slots` and `locale`; it resolves `connection` lazily with
  `ctx.get('connection')` and treats a missing RPC as `host-unavailable`.
* Markdown is **not** rendered (no importable renderer is allowed for a plain-JS plugin): the
  file body is shown in a monospace `<pre>`.
* Styles are one injected `<style>` with `.dwm-` prefixed classes; colors come only from
  `--dsw-alias-*` theme tokens (live contract: `cordis_inspect_query` client `Theme.listTokens`).
* The page must work with **no session selected** (data comes from the RPC, not from the
  right bar), and must show `enabled` / `autoExtract` state read-only, pointing at the plugin
  settings page for changes.
