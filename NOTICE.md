# Notices

## This repository

The first-party code in this repository is licensed under the MIT License — see [LICENSE](LICENSE).

## ZCode — Apache License 2.0

This plugin ports the **project / workspace memory** feature of
[ZCode](https://github.com/zai-org/ZCode), Copyright 2026 Z.AI Co., Ltd, which is licensed
under the Apache License, Version 2.0. A copy of that license is included here as
[LICENSE-Apache-2.0.txt](LICENSE-Apache-2.0.txt); the upstream
[LICENSE](https://github.com/zai-org/ZCode/blob/main/LICENSE) and
[NOTICE.md](https://github.com/zai-org/ZCode/blob/main/NOTICE.md) govern ZCode itself.

### What was adapted (significant changes, Apache-2.0 §4(b))

- **The `# Memory` rules text.** `memoryRulesText()` in `lib/memory-core.js` is adapted from
  `buildMemoryContent()` in ZCode's `apps/zcode-cli/packages/core/src/context/sections/memory.ts`.
  Several sentences are kept close to the original. Changes made for DSH: DSH's tool names
  (`write` / `edit` instead of the `Write` tool), DSH's `AGENTS.md` convention instead of
  `CLAUDE.md`, and an added note about `glob` / `grep` searching the memory directory.
- **The extraction prompt.** `buildExtractionPrompt()` in `lib/memory-core.js` is adapted from
  the memory-extraction path under `apps/zcode-cli/packages/core/src/memory/`, reduced to a
  single request that must answer with one JSON object.
- **The on-disk memory format.** The `MEMORY.md` index plus one fact per file, with
  `name` / `description` / `metadata.{node_type,type,originSessionId}` frontmatter and
  `- [Title](file.md) — hook` pointer lines, follows ZCode's Memory design v4
  (`apps/zcode-cli/docs/design/v2/memory/README.md`).

### What was ported in 0.3.0 (Apache-2.0 §4(b) — modified)

- **`lib/recall.js`** — adapted from `apps/zcode-cli/packages/core/src/memory/project-memory-retrieval-branch.ts`
  and `memory/recall/{manifest,selector,content,types,index}.ts`. Changes: ZCode's `FileSystemPort`
  replaced with the plugin's `ctx.fs` helpers, YAML frontmatter parsing replaced with
  `parseFactFrontmatter()`, and the selector call goes through the plugin's `callModel()` instead of
  `generateText()`. The selector JSON schema, the five-item cap, the per-fact line/byte caps, the
  61,440-character budget and the 48h stale annotation are kept.
- **`lib/dream.js`** — adapted from `memory/dream.ts`: `.consolidate-lock` handling (1h freshness +
  live PID), the timing gate (24h minimum interval, 10-minute scan throttle, ≥5 sessions), and the
  four-phase consolidation prompt. Changes: `CLAUDE.md` → `AGENTS.md`,
  `collectDreamTouchedPaths()` dropped (it parses bash commands this plugin never sees), and one
  JSON plan is applied through the plugin's guarded write path instead of a 50-turn agent, because
  DSH cannot hand a plugin write tools.
- **`lib/related.js`, `lib/cursor.js`, `lib/agent-memory.js`** — new modules for related-memory
  excerpts, the extraction cursor and per-preset memory roots. Upstream has no standalone module for
  these; only the behaviour was matched.

### What was ported in 0.4.0 (Apache-2.0 §4(b) — modified)

- **`lib/memory-agent.js`** — adapted from `packages/core/src/memory/memory-agent-loop.ts` and the
  agent instructions in `memory/extraction.ts`: the restricted memory-tool set, the five-turn
  budget, the "inspect before writing" instruction and the `Nothing to save.` convention. Changes:
  ZCode spawns a real subagent with Read/Grep/Glob/read-only Bash and filesystem writes; DSH has no
  plugin-side tool registration, so the loop is in-process — tool schemas travel as
  `llm.stream({ tools })`, the Host executes each call against a journal, and tool results are
  replayed as `tool-result` blocks. The journal is then applied through the same guarded write path
  as the one-shot engine. The one-shot JSON request stays available (`extractionMode: 'json'`) and
  is the fallback when the loop cannot finish.

### What remains deliberately not ported

The global kill-switch hierarchy and the headless (`-p`) gating. See `README.md` §"与 ZCode 的差异".

### What was rewritten rather than copied

- **Storage** — workspace-local `<cwd>/.dsh/memory/` instead of ZCode's out-of-repository CLI
  store. DSH's `workspace-write` sandbox refuses writes outside the session workspace and
  plugins cannot register a writable root, so keeping the store in the workspace is what lets
  the model maintain it with its native tools without bypassing the sandbox.
- **Injection** — one per-agent system-prompt section (rules plus index) instead of ZCode's
  system section plus a first user message.
- **Extraction** — a one-shot JSON request written by the host under the session's sandbox
  policy, instead of ZCode's five-turn restricted memory agent. DSH does not let a plugin
  register new tools or append event types, which is what ZCode's agent leans on.

The DSH integration halves (`lib/host.js`, `lib/client.js`), the tests and the scripts are
original work written for DSH; `icon.svg` is original.
