# W2 — 语义召回原语（semantic recall primitives）

状态：已实现（`lib/recall.js` + `test/recall.test.mjs`，26 例全绿），检索分支保持关闭，
待 Lead 在 `lib/host.js` 接线。
上游参照（ZCode，Apache-2.0，可直接照搬）：
`retrieval-branch.ts`、`recall-types.ts`、`recall-manifest.ts`、`recall-selector.ts`、
`recall-content.ts`、`recall-index.ts`。

## 要解决的问题

现役注入走 default-index 分支：`MEMORY.md` 索引指针按关键词重排后整块注入
（`lib/host.js:1178` 的 `renderMemorySection`）。上游还有第二条分支——每轮对话前让辅助模型
从全量记忆清单里挑选少数几条，再把这些文件的正文按预算注入。这条分支在上游默认关闭
（`PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false`），但代码路径完整。

本切片把这条分支中**不依赖宿主**的部分冻成纯函数：清单扫描 → 选择提示词 → 响应解析 →
选择过滤 → 召回块渲染。没有 I/O、没有模型调用、没有 Cordis 上下文、没有跨轮状态：调用方
传入文件记录、正文与时钟，输出是字符串或纯数据。这样开关翻转前就能把行为钉死在测试里。

## 导出契约（`lib/recall.js`）

| 名字 | 值 / 签名 | 含义 |
| --- | --- | --- |
| `SEMANTIC_RECALL_ENABLED` | `false` | 分支开关，与上游常量同值 |
| `RETRIEVAL_BRANCHES` | `['default-index', 'semantic-recall']` | 分支名集合 |
| `ACTIVE_RETRIEVAL_BRANCH` | `'default-index'` | 模块加载时由开关解析出的分支 |
| `RECALL_MAX_ITEMS` | `5` | 单轮选择上限 |
| `RECALL_BUDGET_CHARS` | `61440` | 单会话召回字符预算 |
| `RECALL_FACT_MAX_LINES` | `200` | 单文件行上限 |
| `RECALL_FACT_MAX_BYTES` | `4096` | 单文件字节上限 |
| `RECALL_STALE_AFTER_MS` | `172800000`（48h） | 陈旧判定阈值 |
| `RECALL_PREVIEW_LINES` | `30` | 清单预览行数 |
| `RECALL_MANIFEST_LIMIT` | `200` | 清单条目上限 |
| `retrievalBranch` | `(semanticRecallEnabled = SEMANTIC_RECALL_ENABLED) => 'default-index' \| 'semantic-recall'` | 分支判定 |
| `buildRecallManifest` | `(records) => entries` | 清单构建 |
| `formatRecallManifest` | `(manifest) => string` | 清单渲染 |
| `buildSelectorPrompt` | `({ query, manifest } = {}) => { system, user, schema }` | 选择提示词（纯数据） |
| `parseSelectorResponse` | `(text) => { selectedMemories, selectedKnowledgeIds } \| undefined` | 响应解析 |
| `filterRecallSelections` | `({ manifest, selectedFilenames, recalledPaths }) => entries` | 选择过滤 |
| `renderRecallBlock` | `(memories, { nowMs, budgetChars } = {}) => string` | 召回块渲染 |

## 语义

### `retrievalBranch`

照搬 `resolveProjectMemoryRetrievalBranch`：入参为 `true` 才返回 `'semantic-recall'`，
其余（含缺省、`undefined`、非布尔）返回 `'default-index'`。无参调用读到的是模块常量，因此
当前恒为 `'default-index'`。

### `buildRecallManifest(records)`

`records` 为 `[{ filePath, content, mtimeMs }]`（宿主自己读目录，模块不做 I/O）。

- 过滤：`filePath` 必须以 `.md` 结尾；`basename(filePath)` 恰为 `MEMORY.md` 的条目丢弃
  （索引文件已由 default-index 分支注入，召回它只会重复）。非对象、空 `filePath`、
  非字符串 `filePath` 全部静默跳过——与上游 `Promise.allSettled` 的「单文件失败不影响清单」一致。
- frontmatter：复用 `parseFactFrontmatter`（`lib/memory-core.js:604`），不引入 YAML。
  `type` 只接受 `MEMORY_TYPES`（`lib/memory-core.js:28`）里的四个值，其他值降级为
  `undefined`；`description` 缺失为 `''`（上游是省略该键）。
- `preview`：正文前 `RECALL_PREVIEW_LINES` 行，按 `\n` 切分原样保留结尾换行；
  `content` 先做 BOM 剥离与 CRLF→LF（与上游 `readManifestEntry` 的读取口径一致）。
  缺 `content` 当空串，缺/非有限 `mtimeMs` 归零，避免下游 `toISOString()` 抛错。
- 排序：`mtimeMs` 降序，同 mtime 按 `filename` 代码点升序（刻意不用 `localeCompare`，
  宿主 locale 不参与顺序）。随后截取 `RECALL_MANIFEST_LIMIT` 条。
- 返回 `[{ filePath, filename, description, type, mtimeMs, preview }]`：`filename` 是
  `basename`（见「上游差异」），`type` 可能为 `undefined`，其余字段始终存在。

### `formatRecallManifest(manifest)`

逐行 `- [type] filename (ISO 时间): description`，`: description` 只在 description
非空时追加，`[type] ` 只在 type 属于 `MEMORY_TYPES` 时追加（非法值安静降级成「无 type」）。
时间戳为 `new Date(mtimeMs).toISOString()`。空清单 / 非数组 → `''`。

### `buildSelectorPrompt({ query, manifest })`

返回纯数据，不发请求：

- `system`：上游 `MEMORY_SELECTOR_SYSTEM_PROMPT` 全文，含「不确定就不要选」「可以返回空列表」
  「对 `[user]` / `[project]` 格外保守」三条规则，以及「最多 5 条」「不要重复选上一轮已选」。
- `user`：`Available memories:\n<formatRecallManifest>\n\nSelect memories relevant to:\n<query>`。
  上游把清单与查询拆成两条 user 消息，这里拼成一条，保持「一个提示词 = 一个字符串」。
- `schema`：上游 `responseJsonSchema` 的深拷贝：`selected_memories` / `selected_knowledge_ids`
  两个字符串数组，`required: ['selected_memories']`，`additionalProperties: false`。
  每次调用返回新对象，调用方改写不会污染后续提示词。

### `parseSelectorResponse(text)`

`JSON.parse`（失败 → `undefined`），必须是普通对象，键只能是
`selected_memories` / `selected_knowledge_ids`：

- 出现任何多余键 → `undefined`（上游同一规则，防止模型把解释塞进返回体）。
- `selected_memories` 必须是字符串数组；缺失或类型不对 → `undefined`
  （它就是 schema 的 `required` 项）。
- `selected_knowledge_ids` 可缺省，缺省为 `[]`；出现但不是字符串数组 → `undefined`。
- 返回 `{ selectedMemories, selectedKnowledgeIds }`，两个数组都是新副本。

### `filterRecallSelections({ manifest, selectedFilenames, recalledPaths })`

`selectedFilenames` 按 `filename` 映射回清单条目，保持模型给出的顺序：

- 未出现在清单里的文件名、非字符串项丢弃。
- `recalledPaths` 里的文件丢弃（会话内已召回，不重复注入）；接受 `Set` 或字符串数组。
- 同名重复选项折叠为一条（按 `filePath` 去重，指向上游「模型不会重复」的假设）。
- 截断到 `RECALL_MAX_ITEMS`。空/畸形入参 → `[]`；不修改任何入参。

### `renderRecallBlock(memories, { nowMs, budgetChars })`

`memories` 为 `[{ filePath, filename, content, mtimeMs }]`；`filename` 不参与渲染（只用
`filePath` 与 `content`）。空数组或全为无效项 → `''`，调用方可无条件拼接。

- 首条前固定加
  `Retrieved for possible relevance — use only if it actually applies to what the user asked.`
  只出现一次（上游把它拼在第一颗记忆的 header 前）。
- 每条 = header + `\n\n` + 正文，条目之间 `\n\n`。
- 正文截断：先把 `\n` 切行、去掉结尾空行，超过 `RECALL_FACT_MAX_LINES` 行则保留前 200 行；
  再按 `limitCompleteLinesByBytes` 逐行累计 `Buffer.byteLength`，超过 `RECALL_FACT_MAX_BYTES`
  就在**完整行**边界停下——多字节字符永远不会被切成两半。两者任一触发即追加
  `> This memory file was truncated (<原因>). Use the Read tool to view the complete file at: <filePath>`，
  原因在字节超限时为 `4096 byte limit`，否则为 `first 200 lines`（同时超限时报字节，与上游一致），
  正文与提示之间空一行。
- header 三行按需出现，用 `\n\n` 连接：
  1. `age >= 1 天`：`This memory is <N> days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.`
  2. `age >= RECALL_STALE_AFTER_MS`：`This memory has not been updated in over 48 hours; re-verify it before relying on it.`
  3. `Memory: <filePath>:`
  未来 mtime（`age < 0`）按 0 处理。
- 预算：`budgetChars` 默认 `RECALL_BUDGET_CHARS`；按顺序累计每条（含条目间 `\n\n` 分隔符）
  的 UTF-16 长度，加上下一条会超过预算就停止追加，并补一行
  `(+N more memories not shown)`，N 为剩余条数。开头那句 preamble 不计入预算（它必须始终出现）；
  一条都放不下时输出 = preamble + `(+N more memories not shown)`。

## 上游差异

| ZCode | 本实现 | 原因 |
| --- | --- | --- |
| `scanMemoryManifest` 用 `FileSystemPort` 递归目录、读 30 行预览、逐个 stat | `buildRecallManifest(records)` 接收宿主已读好的记录 | 纯函数可测；I/O 与错误吞并由宿主负责 |
| `filename` 是相对 `rootDir` 的路径 | `basename(filePath)` | 本插件记忆目录是扁平的（`.dsh/memory/*.md`），没有子目录；`MEMORY.md` 已被排除，不会出现同名冲突 |
| 用 `yaml` 包解析 frontmatter | 复用 `parseFactFrontmatter` | 零运行时依赖是硬约束；该函数本插件写盘的格式全覆盖 |
| 排序只按 mtime 降序（同 mtime 顺序随目录遍历） | mtime 降序 + filename 升序 | 输出可复现，测试可断言 |
| 选择过滤额外读 `readFileState` 跳过已读文件，然后 `slice(0, 5)` | 只按 `recalledPaths` 去重，另折叠同名重复项 | 读文件状态属于 D1 read-once 的接线范围；重名选项在模型输出里没有意义 |
| `daysOld <= 1` 时不加年龄提示（1 天整读作「新鲜」） | `daysOld >= 1` 时加提示，1 天整输出 `This memory is 1 days old.` | 本切片契约写的是「age >= 1 天」；若要严格对齐上游，把 `lib/recall.js:399` 的比较改成 `> 1` 即可 |
| 提示词拆成 system + 清单消息 + 查询消息 | `buildSelectorPrompt` 返回 `{ system, user, schema }` 单用户串 | 契约要求纯数据；宿主仍可自行拆成多消息 |
| `parseSelectorResponse` 非导出（内部用） | 导出 | 契约要求直接测试解析边界 |
| 会话状态（`recalledPaths`、`recalledContentCharacters`、sticky selector 消息）由 `recall-index.ts` 维护 | 不持有状态；`recalledPaths` / 预算由调用方传入与维护 | 本插件把状态放在宿主，模块保持无状态 |

## 集成方式（Lead 负责，本切片未改 `lib/host.js`）

分支关闭时任何调用都应短路——`retrievalBranch() !== 'semantic-recall'` 时只走既有
`renderMemorySection`（`lib/host.js:1178`），行为字节级不变。打开时一轮召回是：

```js
const manifest = buildRecallManifest(await readMemoryRecords(root))        // 宿主读目录
const { system, user, schema } = buildSelectorPrompt({ query, manifest })
const reply = await auxiliaryModel.generateText({ system, user, schema })   // 上游：辅助模型、ephemeral 缓存
const parsed = parseSelectorResponse(reply)
const picked = filterRecallSelections({ manifest, selectedFilenames: parsed.selectedMemories, recalledPaths })
// 宿主读 picked 的正文，组装 [{ filePath, filename, content, mtimeMs }]
const block = renderRecallBlock(memories, { nowMs: Date.now(), budgetChars: RECALL_BUDGET_CHARS - usedChars })
// 追加到本轮用户消息；把 picked 的 filePath 写进 recalledPaths，把 block 长度累加进 usedChars
```

需要注意的宿主侧职责：`recalledPaths` 的会话级集合、`RECALL_BUDGET_CHARS` 的累计扣减、
选择模型与主模型的路由区分、以及 selector 失败时静默回退（解析 `undefined` → 本轮不召回）。

## 测试覆盖（`test/recall.test.mjs`，26 例）

- 分支：默认 `default-index`、`ACTIVE_RETRIEVAL_BRANCH`、显式开关翻转、常量数值。
- 清单：只留 `.md`、排除 `MEMORY.md`（含子目录）、丢弃畸形记录；frontmatter 的
  type/description（含非法 type、无 frontmatter）；mtime 降序 + filename 升序；
  30 行预览；CRLF 归一；200 条上限且淘汰最旧；非数组入参。
- 渲染清单：完整行、无 type、无 description、非法 type、空清单；时间戳 ISO 形态。
- 提示词：三条保守规则原文、`up to 5`、不重复选、清单行与查询都在 `user` 里、schema 逐字段
  比对、schema 深拷贝不串味、无参调用不抛。
- 解析：两键合法、`selected_knowledge_ids` 缺省为 `[]`、返回副本；多余键 / 类型错误 /
  非对象 / 坏 JSON / 空串 / 非字符串入参全部 `undefined`。
- 过滤：保序、未知名丢弃、`recalledPaths`（Set 与数组两种）去重、5 条上限、同名折叠、畸形入参。
- 渲染：空输入 `''`；preamble 只出现一次；新鲜文件纯 header；1 天 / 47 小时 / 49 小时的
  年龄与 48h 陈旧提示组合；200 行截断（`first 200 lines` 原因）；4096 字节截断（13 条
  300 字节中文行保留、UTF-8 往返无损、无 U+FFFD、`4096 byte limit` 原因）；预算截断加
  `(+N more memories not shown)`；预算 0 时整块只剩 preamble + 省略提示；恰好等于预算时不截断。

运行：`node --test test/recall.test.mjs`。

## 待确认 / 已知取舍

- **1 天边界**：契约写「age >= 1 天」，上游写 `daysOld <= 1` 时不加提示。本实现按契约，
  1 天整会输出 `This memory is 1 days old.`（读起来略生硬）。若 Lead 判定应对齐上游，
  改 `lib/recall.js:399` 一处比较即可，测试里对应断言也要跟着调。
- **`selected_memories` 缺失 = 违规**：与上游和 schema 的 `required` 一致，不会降级成 `[]`；
  只有 `selected_knowledge_ids` 缺省为 `[]`。如果 Lead 认为「空选择」也应容错，加一行即可。
- **预算只计记忆块**：preamble 与省略提示不计，与 W1 的「预算含标题」不同，这是有意的——
  preamble 是固定语义，不能被预算吃掉。
- **预览是固定前 30 行**，不是与查询最相关的片段；选择质量依赖 `description` 写得好，
  这正是本插件既有 frontmatter 协议要求 description 单行的原因。
- 本模块不写盘、不改 `MEMORY.md`，开关关闭时对现役行为零影响。
