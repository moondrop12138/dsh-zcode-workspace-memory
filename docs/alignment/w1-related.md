# W1 — possibly related existing memories (pre-write self-check)

状态：已实现（`lib/related.js` + `test/related.test.mjs`），待 Lead 在 `lib/host.js` 接线。
上游参照：ZCode `apps/zcode-cli/packages/core/src/memory/recall-selector.ts`（Apache-2.0），
以及其提取 agent 在写盘前自行 Read/Grep 记忆目录的行为。

## 要解决的问题

`buildExtractionPrompt`（`lib/memory-core.js:854`）只把既有文件的 `name` 和一行 `description`
列给提取模型。这足以发现**同名**冲突，但发现不了「这次要存的事实，另一条旧记忆已经换了个名字
写过」——上游靠 agent 自己 Read/Grep 补上这一环，我们这里没有工具循环，所以用一次确定性的词项
重合排序 + 摘录来替代：写盘前把「可能相关」的旧文件正文摆到提示词里，让模型就地更新而不是造近重复。

## 导出契约（`lib/related.js`）

| 名字 | 值 / 签名 | 含义 |
| --- | --- | --- |
| `RELATED_MEMORY_LIMIT` | `8` | 最多保留多少条 |
| `RELATED_MEMORY_EXCERPT_CHARS` | `400` | 单条摘录上限（字符） |
| `RELATED_MEMORY_TOTAL_CHARS` | `3200` | 整块预算（字符），含标题与说明 |
| `RELATED_MEMORY_HEADING` | `'## Possibly related existing memories'` | 标题行 |
| `rankRelatedMemories` | `(manifest, queryText, limit = RELATED_MEMORY_LIMIT)` | 排序并截断 |
| `renderRelatedMemories` | `(entries, options = {})` | 渲染提示词块 |

## 语义

### `rankRelatedMemories(manifest, queryText, limit)`

- `manifest` 取 `buildManifest` 的形状：`[{ name, description, excerpt }]`（`lib/memory-core.js:688`）。
- 词项来自 `queryTermsForRanking(queryText)`（`lib/memory-core.js:418`）——ASCII 词干化 + 停用词过滤，
  中文按单字与相邻 bigram。词项为空或 `manifest` 为空 → `[]`。
- 每个条目通过**影子指针**复用 `scoreIndexPointer`（`lib/memory-core.js:449`），不改动它本身：

  ```js
  { file: factFileName(name), title: name, hook: description }
  ```

  于是权重与 D3 注入排序完全一致：标题命中 ×2，hook ×1，文件名 ×1。
- 只保留 `score > 0`；按 `score` 降序、`name` 升序（代码点比较，刻意不用 `localeCompare`，
  避免宿主 locale 影响顺序）；截取前 `limit` 条。
- 返回 `[{ name, description, excerpt }]`，不带 `score`，不修改入参。
- `name` 为空/非字符串的条目被丢弃（无名记忆无法被「按名字复用」，这正是本块的目的）。
- `limit` 非有限数时回落到 `RELATED_MEMORY_LIMIT`；`0` 返回 `[]`。

### `renderRelatedMemories(entries, options)`

`entries` 为空（或全部条目无名）→ 返回 `''`。这是硬契约：调用方可以无条件拼接返回值，
没有相关内容时提示词字节级不变。

否则输出（行间无多余空格，结尾不带换行）：

```
## Possibly related existing memories
These existing memories overlap with this conversation. If one already covers a fact, update that file and reuse its name instead of creating a near-duplicate. Read it before overwriting.

- <name> — <description>
  <excerpt>

- <name without description>
  <excerpt>
```

- 条目格式：`- ` + `name`，有 `description` 时追加 ` — ` + `description`（U+2014 EM DASH，两侧空格）。
- 摘录先用 `conflictExcerpt(text, Number.MAX_SAFE_INTEGER)`（`lib/memory-core.js:1180`）压成单行，
  再按 `RELATED_MEMORY_EXCERPT_CHARS` 直接切分，超出补 `…`（U+2026）。400 + `…` = 401 字符。
  压成单行与冲突提示共用同一函数，但截断点不同：冲突提示走词边界，这里为可预算按字符切。
- 每条摘录缩进两空格；条目之间空一行。

### 预算

- 字符数按 UTF-16 码元计（`String#length`）。
- 预算覆盖**标题 + 说明 + 条目 + 省略提示**。按分数顺序保留**前缀**，从尾部截掉条目。
- 被截掉时追加一行 `(+N more related memories not shown)`，N 为未显示条数。
- 至少保留 1 条：单条自身就超预算时仍然输出它（此时整块会超过 `totalChars`，这是唯一的例外）。
- 实测：8 条各 400 字摘录、默认 3200 预算 → 保留 6 条，整块 2801 字符（第 7 条 + 省略提示会到 3235，
  超预算因此回退）；`totalChars: 300` → 保留 1 条、686 字符、提示 `(+7 more related memories not shown)`。
- `options.limit` 小于条目数时同样走省略提示（与预算截断同一句话，调用方不需要区分两种截断）。

## 上游差异

| ZCode | 本实现 | 原因 |
| --- | --- | --- |
| `recall-selector.ts` 用辅助模型选记忆文件，返回文件名列表 | 纯函数、零依赖、零 I/O 的关键词排序 | 本插件的提取是一次 JSON 补全，没有工具循环；再发一次模型请求会翻倍成本，且结果不可复现 |
| 选择在**每轮对话前**（recall），基于 read-file-state 去重 | 在**写盘前**（extraction）基于本次转录排序 | 目标是防止近重复写入，不是注入更多上下文 |
| `formatMemoryManifest` + 严格 JSON schema 约束模型输出 | 直接渲染成提示词 Markdown 块 | 输出是给人/模型读的上下文，不是结构化返回 |
| 记忆按 `filePath` 去重、`recalledPaths` 记忆已读 | 无状态；每次提取重新排序 | 提取器本身无跨轮状态 |

## 集成方式（Lead 负责，本切片未改 `lib/host.js`）

两处接线点，都是纯追加，`''` 时字节级不变：

1. 首次提取提示词：`lib/host.js:1796-1797`

   ```js
   const manifest = await readManifest(plugin, fs, record)
   const related = renderRelatedMemories(rankRelatedMemories(manifest, transcript.text))
   const prompt = buildExtractionPrompt({ messageCount: snapshot.messageCount, manifest, relatedGuidance: related })
   ```

2. 冲突重问：`lib/host.js:1840-1844` 同一份 `related` 已含在首轮提示里，重问时如需保持上下文一致可再传一次。

`buildExtractionPrompt` 需要新增可选的 `relatedGuidance`，放在 `existing` 之后、`conflictGuidance` 之前
（`lib/memory-core.js:885` 的数组拼接处），这样「既有文件清单 → 可能相关正文 → 冲突重问 → 对话」的
阅读顺序与信息粒度递增一致。注意：`existing` 为空时该分支整体跳过，此时 `related` 必然也是 `''`
（manifest 空 → 排序空），不会出现只有相关块没有清单的提示词。

## 测试覆盖（`test/related.test.mjs`，16 例，全绿）

空 manifest / 非数组 · 无词项 · 无重合 → `[]`；按分数降序、同分按 name 升序（含代码点用例）；
默认 8 条与显式 `limit` 截断、`limit: 0`；返回纯三字段且不改入参、缺 `excerpt` 时补 `''`；
真实 `buildManifest`（`renderFactFile` 造文件）端到端；空 entries 渲染为 `''`（含无名条目）；
冻结的块形状（逐字节比对标题、说明、破折号、缩进、空行）；多行摘录压成单行；摘录截到 400 + `…`；
默认预算截断并出现 `(+N more ...)`；`totalChars: 300` 时至少保留 1 条；`options.limit` 覆盖；
rank → render 联调时非相关条目不出现。

运行：`node --test test/related.test.mjs`。

## 已知取舍

- 关键词重合会误报：`name` 本身参与打分（文件名 ×1），一个名为 `bilibili-plugin-runtime-state` 的记忆
  对任何含 `bilibili` 的转录都会命中。这是有意的召回优先——多给一条正文的代价远小于漏掉近重复写入。
- 摘录是文件正文的前 400 字符，不是与查询最相关的片段；过短的预算下可能看不到关键那句。
  若后续要改，最省事的做法是把正文按句子切分再挑命中词项最多的句子，但会引入新的预算模型，本切片未做。
- 本块只影响提示词，不参与任何写盘判定；模型忽略它也不会导致数据损坏，只会退化成当前行为。
