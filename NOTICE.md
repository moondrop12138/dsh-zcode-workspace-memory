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

### What was deliberately not ported

ZCode's Dream / semantic-recall pipeline, the custom-agent memory layering, the global
kill-switch hierarchy, and the headless (`-p`) gating.

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
