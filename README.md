# dsh-workspace-memory — 工作区记忆（移植 ZCode）

[![CI](https://github.com/moondrop12138/dsh-zcode-workspace-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/moondrop12138/dsh-zcode-workspace-memory/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.2.0-blue.svg)](#能力总览v020)

**当前版本：`0.2.0`**（契约 `INTERFACES.md` **v2.1**）。0.2.0 交付了 0.2.0 之前的体验项（活动流、
无痕开关、搜索筛选、相关度注入、时间戳、导出/导入、git 提交、整理提案）；v2.1 **撤回 v2 引入的
用户全局层**：记忆只按工作区存放、工作区之间互不影响，插件不再读写 `~/.dsh/memory/`。逐项状态见
[`PLAN.md`](PLAN.md)。

把 ZCode 的 **Project / Workspace Memory** 移植到 DeepSeek Harness：每个工作区一份持久 Markdown
记忆，主会话开始时自动进入模型上下文，每轮成功对话后由后台提取补充；另有一个页面可以浏览、新建、编辑、删除与恢复记忆。

- 上游依据：ZCode `apps/zcode-cli/docs/design/v2/memory/README.md`（Memory 设计 v4）+
  `packages/core/src/memory/*`、`packages/core/src/context/sections/memory.ts`。
- 本插件是 **Host + Client** 两半，纯 JS、无构建步骤；`dsh plugin add` 一条命令装好，
  也可用 `plugin_manager install_bundle` 从本地目录装。

## 它做什么

1. **持久记忆目录**：每个工作区一份 `<workspaceRoot>/.dsh/memory/`，内含 `MEMORY.md` 索引与
   「一事实一文件」的 `<fact-name>.md`（YAML frontmatter + Markdown 正文）。记忆**不出工作区**：
   没有用户全局层，也没有跨项目可见的记忆。
2. **会话开始注入**：主会话创建/恢复时，把 ZCode 同源的 `# Memory` 使用规则 + 当前
   `MEMORY.md` 索引注入 system prompt（写入后失效重读：提取落盘后后台刷新缓存，同会话下一轮即可见）。
3. **模型自己写**：你对助手说「记住…」，它按规则用现有 `write` / `edit` 工具把事实写进记忆目录，
   并同步 `MEMORY.md` 指针行（`- [Title](fact.md) — hook`）。
4. **后台自动提取**：每轮**成功**对话后（回复已经产出、不阻塞），后台发一个一次性模型请求，
   从本轮对话里挑出值得长期记住的事实，写成事实文件并维护索引。
5. **浏览与编辑**：左栏「工作区记忆」图标 → 整页列出所有有记忆的工作区与文件，查看原文（等宽原文，
   不渲染 Markdown）。文件列表支持按类型（user/feedback/project/reference）与关键词筛选，长列表
   走零依赖的窗口化虚拟滚动。列表头可以**新建事实**，选中一条事实后可**编辑 / 删除**（删除进回收站），
   面板里的**回收站**视图能一键恢复。所有写操作都走宿主同一条加锁 + 索引守卫的写盘链，可见范围收窄到
   「插件工作区白名单 + 当前会话自己的工作区」——伪造 `sessionId` 不能扩大可见范围，会话工作目录不会被枚举。

## 能力总览（v0.2.0）

| 能力 | 行为 | 详见 |
|---|---|---|
| **单层存储（每工作区）** | 唯一记忆根 `<workspaceRoot>/.dsh/memory/`；`user`/`feedback`/`project`/`reference` 四类事实都落这里，只在该工作区可见（v2.1 撤回了全局层） | §数据布局、§生效范围 |
| **回收站** | `forget` 不再 `unlink`，而是把事实文件移进 `<记忆根>/trash/`，保留最近 50 个；`trash/` 不参与注入、提取清单、目录列举与快照 | §数据布局 |
| **写互斥** | 每个记忆根一把 promise 链锁，包住「提取写盘」与「索引修复」的读写区间——同工作区多会话不会交错覆盖 `MEMORY.md` | §后台提取 |
| **索引写守卫** | 新索引落盘前做**内容级** diff：指针总数不得低于「现有 − forget」，且只能新增/改写本轮真正写过的指针，否则拒绝写入并记日志 | §后台提取 |
| **RPC 收窄** | `catalog`/`activities` 的可见范围 = 工作区白名单 ∪ 请求来源会话自己的工作区；会话 cwd 不被枚举，伪造 `sessionId` 不能扩大范围 | §它做什么、`INTERFACES.md` §6.2 |
| **预算与计数** | `extractMinIntervalMs` / `extractDailyLimit` 双闸；按本地日滚动的 per-workspace 计数，页面顶栏显示「今日提取 N 次」 | §配置 |
| **只注入本工作区** | 注入的就是该工作区 `MEMORY.md` 一个索引块，按 `maxIndexChars` + 200 行双上限截断；没有第二层可合并 | §后台提取 |
| **时间戳** | frontmatter 维护 `createdAt`/`updatedAt`/`lastAccessedAt`（读命中惰性刷新、防抖批量落盘），页面展示相对时间 | §数据布局 |
| **相关性注入排序** | 会话首条带关键词的用户消息给指针行打分（标题 ×2 / hook ×1 / 文件名 ×1），**先排序再截断**——老而有效的偏好不再被尾部挤掉 | §已知限制 |
| **冲突再询问** | 候选 `name` 与现有事实前缀相同或编辑距离 ≤ 2 时，把冲突正文摘要塞回提示词重问一次，引导原地更新而不是新建近似副本 | §后台提取 |
| **分段提取** | 单轮转录超 24,000 字符切成至多 3 段各问一次，按 `name` 合并后走一次冲突重问 + 一次加锁写盘，整轮仍只算 1 次提取 | §后台提取 |
| **快照导出 / 导入** | 零依赖目录快照 + `manifest.json`（逐文件 `bytes`+`sha256`）；导入**先全量校验再写**，坏快照一个字节都不落地 | §快照导出 |
| **git 版本化（可选）** | 记忆根**已经是** git 仓库时，每次写盘后派游离子进程 `git add -A && git commit`；永不 `git init`、永不拖住本轮 | §快照导出 |
| **整理提案** | 工作区事实数 > 60 时产出 `proposals/consolidation-<ISO>.md`（近似重名 / 疑似矛盾 / 长期未访问），**永不自动应用**，需人工接受 | §整理提案 |
| **提取活动流** | 每轮提取后页面记一条「记住了 N 条 / 忘了 M 条」，点开看索引 diff | §它做什么 |
| **会话无痕开关** | 页面顶部为当前会话提供「本轮不提取」toggle，跳过时零模型调用 | §配置 |
| **搜索 / 筛选 / 虚拟列表** | 按 type chips + 关键词过滤，超 60 条走零依赖窗口化虚拟滚动 | §它做什么 |
| **面板增删改（C3）** | 页面里可新建 / 编辑 / 删除事实，删除进回收站（宿主端点 `fact-read` / `fact-save` / `fact-delete`）；写盘复用宿主的锁、索引守卫与回收站助手，索引与文件同一次临界区内更新 | §它做什么、`INTERFACES.md` §6.10、§7.1 |
| **回收站视图（C3）** | 面板列出 `trash/` 里的事实（名字 / 大小 / 时间，最新在前），`trash-list` 拉列表、`trash-restore` 一键恢复并补回索引指针；同名事实已存在时拒绝恢复而不是覆盖 | §数据布局、`INTERFACES.md` §6.11 |
| **子 Agent 只读注入** | subagent / workflow child / 队友注入只读索引段，不建目录、不提取、不响应 tools/result | §生效范围 |
| **同会话即时可见** | 提取落盘后后台刷新 section 缓存，本会话下一轮就能看到新记忆 | §后台提取 |
| **索引自愈** | 会话初始化时对照磁盘事实文件补齐丢失的指针（只补缺、不删悬空、受 5s 预算与 200 行上限约束） | §已知限制 |
| **日志轮转** | `%TEMP%\workspace-memory-host.log` 超 1 MiB 轮转为 `.log.1`，只保留一代 | §配置 |

**0.2.0 明确没做的一项**（详见 [`PLAN.md`](PLAN.md)）：

- **Markdown 渲染（C5）**：事实正文以等宽 `<pre>` 显示原文，不渲染 Markdown——纯 JS 插件拿不到
  可信的渲染器，自己写一个白名单渲染器等于在「读任意记忆正文」这一处引入 XSS 面。

## 生效范围

| 维度 | 行为 |
|---|---|
| 开关粒度 | `enabled` 是**插件级（profile 级）**配置；开启后该 profile 下所有工作区的主会话都生效（与 ZCode 的全局开关一致） |
| 内容隔离 | **按工作区隔离**（唯一模式）：记忆根 = 会话不可变的 `session.header.cwd`；工作区之间互不可见，同一工作区的多个会话共享一份。没有全局层，`~/.dsh/memory/` 不读也不写 |
| 落盘时机 | **惰性**：只有真的开过主会话的工作区才会 best-effort 创建 `.dsh/memory/` |
| 子 Agent | **只读生效**：`session.header.origin === 'subagent'`（subagent / workflow child / 队友）注入只读索引段，但**不建目录、不提取、不响应 tools/result**——模型写记忆写不进也不会触发任何落盘 |
| read-only 会话 | 半生效：规则段照常注入，但**不建目录、不提取**；模型写记忆按沙箱正常被拒（无绕过） |
| 极简模式 | **完全不生效**：`session.header.agentPreset === 'minimal'` 的会话不读索引、不建目录、不注入、不提取，全程零 fs 调用 |
| 计划模式 | 记忆写入沿用宿主工具策略，会被拦（与 ZCode 有意不同，见下） |
| 其它 profile | 不装不生效；安装是 profile 级动作 |

## 数据布局

**只有一个记忆根**（v2.1 起；v2 的全局层已撤回）：

```text
<workspaceRoot>/.dsh/memory/
  MEMORY.md              # 索引；无 frontmatter；一行一条 `- [Title](fact-name.md) — hook`
  <fact-name>.md         # 一事实一文件
  trash/                 # 回收站：`forget` 把事实文件移进来而不是直接删除；只保留最近 50 个（按 mtime 淘汰）
  proposals/             # 整理提案：`consolidation-<ISO>.md`，永不自动应用，不算事实
```

`MEMORY.md` 每个工作区独立维护、独立注入（一个索引块，按 `maxIndexChars` + 200 行双上限截断）。
`trash/` 与 `proposals/` 不参与注入、提取清单、目录列举、索引修复与快照导出：模型看不到它们，
也没有工具会把它们当成事实再提取一遍。

**不再按类型分层**：四类事实都写同一个工作区记忆根，`forget` 只作用于该工作区。v2 曾把
`user`/`feedback` 路由到 `~/.dsh/memory/`，那个层已被撤回——旧文件不会被读、也不会被搬移，
要保留就自己拷进工作区 `.dsh/memory/`。

事实文件格式（与 ZCode 一致）：

```markdown
---
name: concise-memory-name
description: one-line recall description
metadata:
  node_type: memory
  type: user | feedback | project | reference
  originSessionId: sess_…
  createdAt: 2026-10-24T11:35:00.000Z
  updatedAt: 2026-10-25T09:02:11.000Z
  lastAccessedAt: 2026-10-25T09:02:11.000Z   # 可选：读命中时才写
---
One durable fact.
```

- `type`：`user`（用户角色/背景/偏好）、`feedback`（协作方式的确认或纠正，正文带 `**Why:**` /
  `**How to apply:**`）、`project`（代码里推不出的项目原因/约束/决策）、`reference`（外部资源指针）。
- `name` 为小写 kebab-case（1–48 字符），正文可用 `[[other-name]]` 关联其它事实。
- `metadata.node_type` 与 `originSessionId` 由插件维护（新建时填当前会话，更新时保留原值）；
  其余约束与 ZCode 一样是提示词级约束，不做写后 schema 校验。
- `createdAt`/`updatedAt` 写入时自动维护（更新保留 `createdAt`）；`lastAccessedAt` 在模型读命中
  这条事实时惰性刷新，按防抖窗口批量落盘——**旧文件缺这三个字段照样能解析**（一律按未知处理）。
- 描述里含 `#`、`:` 这类 YAML 敏感字符时整值加引号，不会被当成注释截断。
- 建议把记忆目录加进 `.gitignore`（插件自身绝不改 `.gitignore` 或其它仓库文件）：

  ```bash
  echo '.dsh/memory' >> .gitignore
  ```

## 配置（插件设置页 / cordis.patch.yml）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关：注入规则与索引、创建记忆目录、后台提取、页面数据 |
| `autoExtract` | `true` | 每轮成功对话后自动提取长期记忆（会产生额外模型请求与 token 成本） |
| `maxIndexChars` | `25000` | 注入的 `MEMORY.md` 块字符上限（另有 200 行上限） |
| `extractMinIntervalMs` | `0` | 两次提取的最小间隔毫秒数；`0` 表示不限。间隔未到时跳过本轮并记日志（`min interval not elapsed: …`） |
| `extractDailyLimit` | `0` | 每工作区每日提取次数上限；`0` 表示不限。到达日限时跳过并记日志（`daily limit reached: C/L today`）。计数按本地日（`YYYY-MM-DD`）滚动重置，重启后归零 |
| `extractProvider` | `''` | 后台提取专用 provider；留空则沿用会话路由。只填这个时 model 也取自会话路由 |
| `extractModel` | `''` | 后台提取专用 model；留空则沿用会话路由。两个都填时完全不看会话路由（可用便宜模型跑提取） |
| `debugLog` | `false` | 追加更细的诊断（索引读取、跳过原因、写盘细节）到 `%TEMP%\workspace-memory-host.log` |
| `gitCommitEnabled` | `true` | 记忆根**已经是** git 仓库（存在 `.git/`）时，每次写盘成功后自动 `git add -A && git commit`。不存在 `.git/` 时完全无效，插件永不替你 `git init` |

> 计数与限额是 **per-workspace** 的宿主内存态：`catalog` RPC 会把每个工作区的
> `{todayCount, lastAt}` 一并返回，页面顶栏显示「今日提取 N 次」徽标。

> 宿主日志 `%TEMP%\workspace-memory-host.log` 只记录**错误**（`extraction request failed …` 等）；
> 每轮的提取结论行（`extraction done …` / `extraction skipped … (原因)`）需要开 `debugLog` 才会记录，
> 因为后台提取是一次真实计费请求、不会进入会话日志。日志超过 1 MiB 时轮转为
> `workspace-memory-host.log.1`（只保留一代）。

> 用量提示：开启 `autoExtract` 后，系统可能发起额外的模型请求来提取长期记忆，从而增加 Token
> 用量与使用成本。关掉它仍然可以手动让助手「记住…」。

## 后台提取（autoExtract）细节

- **触发**：`turn/end` 且 `reason.kind === 'completed'`；每个 Agent 单槽排队（正在跑时只保留最新一次）。
- **跳过规则**（ZCode 同款）：本轮里模型自己写过记忆（写工具参数命中记忆根）→ 跳过；
  本轮没有「独立文本块且词数 ≥ 3」的用户发言 → 跳过。中文按 CJK 字符折半计词
  （否则纯中文发言的词数永远算 1，自动提取再也不会触发）。
- **模型请求**：复用会话当前路由（`session.requestContext()` → 请求头 → Agent 选项 → 默认模型）；
  设了 `extractProvider` / `extractModel` 时按字段覆盖（两个都填则完全脱离会话路由，可用便宜模型跑提取），
  只覆盖了其中一个时另一个仍取自会话路由。`maxTokens = 1200`，只喂本轮的 user/assistant 文本
  （单段尾部截断 24,000 字符）与现有记忆清单；
  要求回复固定 JSON（`{"memories":[…],"forget":[…]}`），失败/非法 JSON/非 `stop` 结束 → 整轮放弃，不重试、不部分写入。
- **JSON 逐条校验**：非法回复整轮放弃，但合法 JSON 里的坏条目（未知 type、空描述/正文）只丢那一条；
  `name` 缺失或非法时先按标题 slug 化，仍不行则用条目内容的确定性哈希生成 `fact-<sha256 前 8 位>` 文件名。
- **写入**：每轮最多 5 条事实；沿用会话自己的沙箱策略写入本工作区，`forget` 把文件移入回收站
  （`trash/`，先复制后删原文，保留最近 50 个）并移除索引指针；回收站不参与注入与提取。
- **写盘顺序与失败原子性**：先写全部事实文件 → 再改 `MEMORY.md`（先备份 `MEMORY.md.prev`）→ 最后
  执行 forget。任一步失败立即中止（后续阶段不动），已写入但没进索引的事实留给下次索引自愈。
- **索引写守卫**：新索引落盘前做内容 diff 校验——指针总数不得低于「现有数 − forget 数」，且只能
  新增/改写本轮真正写过的文件的指针；否则拒绝写（`index write refused …`）。
- **近似重名冲突只重问一次**：首轮回复里的 `name` 与现有事实「前缀相同（两名字都 ≥ 3 字符）或编辑
  距离 ≤ 2」时，把冲突文件的正文摘要（≤ 600 字符）连同 `## Conflicting existing files` 一起追加进
  提示词重问一次，让模型改写那个已有文件而不是新建近似副本；重问回复不可用则沿用首轮计划，没有冲突
  时整轮只花一次模型调用。被重问纠正到已有名字的条目，写盘时原地更新那个已有文件。
- **超长轮次分段提取**：本轮转录超过 24,000 字符时切成至多 3 段（按消息边界、逐段 ≤ 24,000 字符）
  各问一次模型，按 `name` 合并（同名以后出现的为准、`forget` 取并集），再把合并结果交给**同一次**
  冲突重问与**一次**加锁写盘；整轮仍只算 1 次提取（预算/日限/`todayCount` 都只 +1）。
  短轮次行为不变，仍然整轮只花一次模型调用。三段（72,000 字符）都装不下时按截断方向丢最旧的消息。
- **并发与预算**：同一工作区的「索引修复 + 提取写盘」共用一把 per-workspace 锁（多会话串行）；
  触发时先过预算门（见上表 `extractMinIntervalMs` / `extractDailyLimit`）再排队。
- **索引自愈**：每次会话初始化读索引时，对照磁盘上的事实文件补齐丢失的指针行（受 5 秒读取预算与
  200 行上限约束，先备份 `MEMORY.md.prev`）；读索引持续失败时按 1s/4s/16s 退避重试，3 次后本会话
  退化为只注入规则。
- 关闭宿主/会话结束时中断在飞的提取，丢弃迟到结果。

## 快照导出 / 导入与 git 提交（D7）

零依赖：导出就是**拷文件**，不引入压缩库、不打包 tar。

- **导出** —— RPC `export`，载荷 `{ path, targetDir }`（`path` 只能是工作区路径）。
  产物：`<targetDir>/workspace-memory-export-<ISO 时间戳>/`，里面是 `workspace/MEMORY.md`、
  `workspace/<事实名>.md`，加上根部的 `manifest.json`
  （`{format, version, createdAt, layers: [{layer, root, files: [{name, kind, bytes, sha256}]}]}`）。
  `proposals/` 与 `trash/` 属于记账目录，**不进快照**。
- **导入** —— RPC `import`，载荷 `{ path, dir, layers? }`。**先校验、后写盘**：manifest 的
  `format`/`version`/层名/文件名/重名与每个文件的 `sha256` 全部读一遍并通过，才开始写第一个字节
  （v2 快照里若还有 `global` 层，直接忽略，只应用 `workspace` 层）。
  校验失败返回 `invalid-manifest` / `invalid-snapshot` / `nothing-to-import`，记忆根**一个字节都不变**。
  写盘复用同一条受保护路径：per-根互斥锁、内容相同即跳过（重复导入是 no-op）、`MEMORY.md` 覆盖前
  备份 `MEMORY.md.prev`、冲突的事实文件先进 `trash/` 再落新内容（永不直接删）。
- **校验脚本** —— `node scripts/verify-snapshot.mjs <exportDir>` 用与导入相同的规则核对一个快照目录
  （manifest 形状 + 文件名 + 字节数 + 校验和），退出码非 0 即有坏项。
- **git 提交（可选）** —— 记忆根里**已经**有 `.git/` 且 `gitCommitEnabled` 为开（默认开）时，提取落盘、
  导入、接受提案之后会派一个游离的 `git add -A` → `git commit -m "workspace-memory: …"` 子进程
  （`stdio: 'ignore'`，最多等 15 秒）；本轮对话**从不**等它，失败只写日志。插件永不 `git init`：
  想版本化记忆，自己 `cd .dsh/memory && git init`。

## 整理提案（D8）

工作区的事实数**超过 60** 时，该工作区**下一次**提取落盘后额外产出一个人工复核文件
（`<记忆根>/proposals/consolidation-<ISO>.md`）：

- 三个固定小节：`## Near-duplicate names`（名字前缀相同或编辑距离 ≤ 2 的近似重名，给出 keep/drop）、
  `## Contradiction candidates`（描述高度重合的成对事实，供人判断是否互相矛盾）、
  `## Long-unaccessed facts`（`lastAccessedAt` 超过 90 天没被碰过的事实）。
- 文件第一段就写明「只是提案，什么都没应用」；每节最多列 50 条，尾部 `… N more` 提示截断，
  末尾的 ` ```json ` marker 保留**全量**机器可读项与 `{nearDuplicates, contradictions, stale}` 计数。
- **永不自动应用**。RPC `proposals` 列表（含 `acceptedAt`、三类计数），RPC `proposals-accept`
  只应用「近似重名」里的删除项——走与提取相同的受保护写路径：改索引前备份 `MEMORY.md.prev`、
  索引指针同步移除、被丢弃的文件进 `trash/`、提案文件标记 `acceptedAt`；已接受的提案再次接受
  返回 `already-accepted`，不会执行两次。矛盾与长期未访问两类只做提示，需要人自己判断。
- `proposals/` **不算事实**：索引修复、目录/页面列举、提取用的现有记忆清单、快照导出都会跳过它。

## ZCode 对齐（0.3.0）

这一版把上游 5 个能力缺口补齐，原则是「能力等价、按 DSH 约束落地」，不是逐行复制（照搬清单见
`docs/alignment/`，许可证见 `NOTICE.md`）。

- **相关记忆可见性（W1）**：提取请求在「已有记忆清单」之后追加「可能相关的既有记忆」——用转录文本对既有
  条目做词项/前缀打分（`lib/related.js` `rankRelatedMemories`），最多 8 条、每条摘录 400 字符、总长 3200
  字符。上游靠提取 Agent 自己 Read/Grep，这里用一次性的相关条目摘录近似同一条件。
- **检索分支（W2）**：`lib/recall.js` 实现上游两分支——`default-index`（默认，注入 `MEMORY.md`）与
  `semantic-recall`（selector 选最多 5 条、单条 200 行 / 4096 字节、会话累计 61440 字符、超过 48h 标年龄）。
  开关与上游一致是**代码常量** `SEMANTIC_RECALL_ENABLED = false`，不开放给面版；`retrieval` 端点只读报告
  当前分支。
- **Dream 整理（W3）**：`lib/dream.js` 移植锁（`.consolidate-lock`，1h 新鲜度 + PID）与时机判定（24h
  最小间隔、10min 扫描节流、≥5 个新会话），提示词保留四阶段（Orient / Gather / Consolidate / Prune）。
  `dream-run` 手动触发一次整理（`force` 跳过门槛），`dream-status` 报告状态。与上游一致：**不自动触发**，
  没有定时调度器。
- **提取游标（W4）**：`lib/cursor.js` 记录每个会话「已提取到哪条消息」（`.dsh/memory-state/cursor.json`）。
  成功与空计划推进、失败保留以便下轮重试；未推进的消息在下一轮一并重放，窗口至少保留分段容量
  （3 × 24000 字符），所以长轮次仍走分段提取。
- **custom-agent 记忆（W5）**：`lib/agent-memory.js` 里 `standard` preset 与 main 会话用工作区记忆根；其它
  preset（minimal / cordis / …）与 subagent 会话按键隔离到 `agent-memory/<key>/`，索引与规则文本与主记忆同构。

新增的只读/手动 RPC 端点：

| 端点 | 作用 |
|---|---|
| `dream-run` | 手动跑一次整理（`force` 跳过 24h / 5 会话门槛），返回 `started / updates / deletes / applied` |
| `dream-status` | 整理状态：是否运行中、上次整理时间、下一步判定与原因、锁路径 |
| `retrieval` | 当前检索分支（`default-index` / `semantic-recall`）、是否启用、召回预算字符数 |

## 与 ZCode 的差异（有意为之）

| 项 | ZCode | 本插件 |
|---|---|---|
| 存储根 | CLI 私有存储 `memories/projects/<key>/memory/`（仓库外） | 工作区内 `<cwd>/.dsh/memory/` —— DSH 沙箱默认 workspace-write，工作区外写会被拒；放工作区内可全程不绕过沙箱、模型用原生工具维护 |
| 写入方式 | 模型用 Write/Edit 写；提取是受限的 5 轮 Memory Agent（Read/Grep/Glob/只读 Bash/记忆目录内 Write/Edit） | 模型用 `write`/`edit`；提取是一次性 JSON 请求 + Host 写盘（DSH 不允许插件注册新工具策略/追加事件类型） |
| 注入位置 | system 段（规则）+ 首条 user message（索引） | 单个 per-agent system section（规则 + 索引），语义等价、KV 前缀更稳 |
| 索引刷新 | 每会话初始化读一次 | 初始化读一次；提取落盘后后台刷新（写入后失效重读，同会话下轮可见；刷新失败保留旧文本并维持退避） |
| Plan 模式 | 允许写记忆 | 沿用宿主工具策略（会被拦） |
| 提取资格 | 「独立文本块 ≥ 3 个空白分隔词」 | 同样阈值，但 CJK 字符折半计词（中文发言才能合格） |
| 语义召回 / Dream | 代码保留但当前产品链路不启用（`PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED=false`；Dream 无自动触发） | 同样保留但不启用：`SEMANTIC_RECALL_ENABLED=false`（`retrieval` 端点报告 `default-index`），Dream 只由 `dream-run` 手动触发，不挂自动调度 |
| custom-agent 记忆 | 按 `user` / `project` / `local` 三种 scope 分根 | 已移植：非 `standard` preset 的会话按 preset 键获得独立记忆根（`agent-memory/<key>/`），`standard` 与 main 会话仍用工作区根 |
| 全局 kill switch 分层 / `-p` headless 门控 | 有 | 不做（DSH 侧由 `enabled` 与 minimal preset 承担） |
| 用户全局记忆层（跨项目共享） | ZCode 无此概念 | v2 曾加、**v2.1 按用户要求撤回**：记忆只按工作区 |

## 安装 / 更新 / 卸载

从 GitHub 安装：

```bash
dsh plugin --profile <profile> add github:moondrop12138/dsh-zcode-workspace-memory
```

本地开发目录安装：`plugin_manager` → `install_bundle`，target 为本目录绝对路径。

- 更新：**Client 半改动刷新页面即可；Host 半改动必须 `remove_bundle` + `install_bundle` 重装**
  （Host 模块在安装时被加载，热替换不生效）。
- 从 **0.1.x / 0.2.0 升到当前版**属于跨契约版本升级（`INTERFACES.md` v1 / v2 → **v2.1**）：一律走
  `remove_bundle` → `install_bundle`，不要只刷新页面。已有的工作区记忆数据**无需迁移**，目录会被
  原样读取；`~/.dsh/memory/` 既不再创建也不再读取（v2 全局层已撤回，见 `INTERFACES.md` §2.5）。
- 卸载：`remove_bundle`（或 `dsh plugin --profile <profile> remove dsh-workspace-memory`），
  左栏图标与页面随之消失（监听/定时器都由 `ctx.effect` 接管）。卸载**不会**删除任何记忆目录——
  `.dsh/memory/`（以及 v2 时期可能存在的 `~/.dsh/memory/`）都留在原地。

## 测试

```bash
cd dsh-workspace-memory && node --test
```

覆盖：路径与文件名安全、索引 frontmatter/注释剥离与双上限截断、指针 upsert/remove、
事实文件生成与 frontmatter 解析、origin 保留、提取资格判定（direct-write / 词数）、
转录尾部截断与 24k 分段、提取提示词、提取路由覆盖（`extractProvider`/`extractModel`）、JSON 解析（围栏/前后废话/字符串内花括号/非法条目整轮放弃/5 条上限）、
路由回退顺序、宿主集成（注入/RPC/提取落盘/回收站/并发锁/预算跳过/索引修复与重试/最小模式）、
快照导出与导入（manifest、校验和不符拒写、冲突进回收站、重复导入 no-op）、git 模式（有仓提交、无仓不 init）、
整理提案（阈值上下、三个小节、`proposals/` 不计为事实、接受提案删重名）、
日志轮转、页面徽标与目录数据、CI 工作流矩阵与脚本接线。

本地全量校验三步（CI 每个矩阵作业同样跑这三步）：

```bash
npm run lint        # 把 lib/test/scripts 全部 JS 源按 ES module 解析一遍（不执行）
npm test            # node --test
npm run verify:e2e  # node scripts/verify-host-e2e.mjs，16 项宿主侧端到端断言
```

## 验收实测（2026-10-18 live 安装，2026-10-24 以测试套件闭环挂账项；本机 Desktop profile）

| 验收项 | 结果 | 证据 |
|---|---|---|
| A1 安装 | ✅ | `install_bundle` → `application: applied`、`warnings: []`；`Config.listConfigs` 返回 `enabled/autoExtract/maxIndexChars/debugLog` 四个 `x-cordis.volatile` 字段与默认值 |
| A2 会话注入 | ✅（活会话） | 安装后同一个正在运行的会话，最新 `system/message` 含 `# Memory`，且带绝对记忆根 `<workspace>\.dsh\memory/`；`.dsh/memory/` 已被创建 |
| A2' 插件热生效 | ✅ | 删除记忆目录后 `remove_bundle` + `install_bundle`，目录被重新创建，宿主日志无 `systemPrompt is unavailable`（`systemPrompt` 已声明为硬依赖） |
| A4' 提取落盘（宿主侧） | ✅ | Lead 独立 E2E（`scripts/verify-host-e2e.mjs`）：23/23 通过 —— 事实文件 + `originSessionId` + `MEMORY.md` 指针、请求带 route/system/1200 maxTokens、direct-write 跳过、read-only 不建目录不提取、subagent 只读注入（含索引、零写入、零提取）、相关记忆可见性、提取游标落盘、检索分支、Dream 状态与单次整理 |
| A5 read-only | ✅ | 同上（不建目录、不提取、仍注入规则段） |
| A6 子 Agent | ✅ | 同上（只读索引段注入、不建目录、不提取、零写入） |
| A7 UI 注册 | ✅（live 槽位） | `Slots.listSubTree('sidebar.panellist')` 出现 `workspace-memory`（order 30，active）；`main` 出现 key `workspace-memory` |
| A8 单元测试 | ✅ | `node --test` 304/304 通过（22 个套件：agent-memory / ci / cursor / dogfood / dream / export-import / extraction / fact-timestamps / log-rotation / memory-core / panel / panel-editor / panel-write / proposals / recall / related / relevance / search-filter / section-refresh / section-retry / segmented-extraction / workspace-layer） |
| A6 CI 双平台 | ✅（矩阵就绪） | `.github/workflows/ci.yml`：windows-latest + ubuntu-latest × Node 20/22，每作业跑 `node scripts/check-syntax.mjs`、`node --test`、`node scripts/verify-host-e2e.mjs`；状态见顶部徽章 |
| A4 触发与判定（live） | ✅ | 宿主日志每个 `turn/end` 一行结论：本会话 3 个完成的 turn 都在判定范围内；定时提醒那轮判为 `extraction skipped … (no-user-prose)`——正确，因为提醒消息的 `source.kind` 是 `schedule` 而不是 `user`（会话日志实测 `userMessageSources = {user:2, runtime-context:1, skill-catalog:1, time-context:5, agent-message:5, subagent-settled:5, schedule:2}`） |
| A4' 真实模型提取 | ✅（stub 模型闭环 + 代码路径审计） | 完整模型请求→解析→写盘链路已在测试里用 stub 模型端到端跑通：提取请求携带真实路由/系统规则/`maxTokens=1200` 并以 JSON 计划落盘（`apply wires the section, live agents, extraction, and both RPC endpoints`；`scripts/verify-host-e2e.mjs` 16/16：请求带 route/system/1200 maxTokens 与 no-op 契约）；合法 JSON 里的坏条目只丢那一条、`name` 非法时 slug/哈希兜底（memory-core 解析套件）；事实写失败中止整批、索引写失败不动 forget（`a failed fact write aborts the batch…` / `a failed index write leaves the forgets untouched`）；真实计费行为与 stub 唯一差异是模型回复内容，解析器对回复不做信任假设（非法 JSON 整轮放弃）。唯一未覆盖的是线上真实模型的回复分布，行为面已全部由测试钉住 |
| A3 记忆协议落盘（live） | ✅（协议） | 按协议写入示例事实 `workspace-memory-port.md` + `MEMORY.md`，用插件自己的纯函数回读校验：文件名被接受、frontmatter 解析出 `type: project` 与 `originSessionId`、`buildManifest` 正常、下一会话的注入块含该指针行 |
| A3' 模型自主写入 | ✅（stub 模型闭环 + 代码路径审计） | 模型自主写入与后台提取走同一条写盘链（`applyExtraction`：事实 → 索引 → forget，见「后台提取细节」）；提示词注入已由 A2/A2' 实测，写入结果由上述 stub 套件验证（`planExtractionWrites creates facts, preserves origins, and edits the index`、回收站/索引守卫/并发锁各用例）；模型是否「照做」属于提示词依从性而非插件代码路径，协议与落盘行为已全部钉住 |
| 设置表单可见性 | ✅（代码路径验证） | Config schema 用 `x-cordis.volatile` 标注 8 个值（`enabled/autoExtract/maxIndexChars/extractMinIntervalMs/extractDailyLimit/extractProvider/extractModel/debugLog`），测试钉住：`the loaded Config schema exposes the volatile switches`、`cfg reads plain values, volatile references, and falls back safely`、`extraction budget helpers reject nonsense and default to unlimited`；A1 实测 `Config.listConfigs` 已返回 volatile 字段与默认值——表单由宿主按同一 schema 渲染，字段全部带默认值可安全落盘 |

复现命令：

```bash
cd dsh-workspace-memory
node --test                        # 304 项纯函数/集成用例
node scripts/verify-host-e2e.mjs   # 23 项宿主侧端到端断言
node scripts/verify-snapshot.mjs <导出目录>                 # 校验一个快照目录（manifest + 校验和）
node scripts/inspect-session.mjs <session.v4.jsonl.zstd>   # 检查某会话最新 system 段是否含 # Memory
node scripts/verify-memory-dir.mjs "<工作区绝对路径>"        # 用插件自己的纯函数校验记忆目录与注入块
```

## 已知限制

| 限制 | 具体表现 | 现状 / 缓解 |
|---|---|---|
| **面板写操作直连磁盘**（C3） | 面板的保存/删除/恢复都走宿主端点，在页面外改动（模型自己写、外部编辑器）不会被页面「接管」；同时打开两个页面时以最后一次写为准（同一把锁串行，不做乐观并发校验） | Host 没有文件监听，页面靠手动刷新拿最新目录 |
| **正文不渲染 Markdown**（C5 降级） | 事实正文以等宽 `<pre>` 显示原始 Markdown 文本，索引也保持纯文本 | 纯 JS 插件拿不到可信渲染器；自写白名单渲染器等于在读任意记忆正文处引入 XSS 面，故不做 |
| **提取请求不可回放** | DSH 不允许插件追加新事件类型，提取的请求/响应不进会话日志 | 宿主日志 `%TEMP%\workspace-memory-host.log` 记每轮结论行；开 `debugLog` 才有成功/跳过详情 |
| **刷新是 best-effort** | 提取落盘后会后台重读索引刷新注入缓存（C6），但模型用 `write`/`edit` 自写记忆**不触发**刷新 | 要等下一次提取或下个会话；刷新读失败时保留上一次好文本并维持退避 |
| **相关性排序只影响注入展示序** | 首条带关键词的用户消息成为排序 query，指针行重排后才截断（D3） | 从不回写 `MEMORY.md`；无 query 的会话逐字节等价；磁盘索引顺序始终是权威顺序 |
| **索引指针可能悬空** | 记忆文件被外部删除/改名后，悬空指针行不会被删（与 ZCode 一致） | `repairIndex` 只**补缺**、不删悬空、不越过 200 行上限，改前备份 `MEMORY.md.prev` |
| **v2 全局层数据不再读取** | v2 时期写进 `~/.dsh/memory/` 的事实不会出现在任何工作区（v2.1 撤回全局层，用户决定） | 要保留就手工把文件拷进 `<workspaceRoot>/.dsh/memory/` 并补 `MEMORY.md` 指针行；插件不搬移、不删除 |
| **运行态数据重启即丢** | `todayCount`/`lastAt`、提取活动流、会话无痕标记都是内存态 | 预算是「本进程今天」的语义；活动流只用于当次浏览 |
| **git 提交是 best-effort** | 只在记忆根**已有** `.git/` 时生效，15 秒上限，失败只记日志 | 插件永不 `git init`、永不阻塞对话；要版本化就自己 `git init` |
| **记忆可见性** | `.dsh/memory/` 就在仓库里，随仓库一起可见 | 是否提交由你决定，插件绝不改 `.gitignore` |

## 许可证与上游

- **本仓库第一方代码：MIT**（见 `LICENSE`）。
- 记忆的提示词文本（`memoryRulesText` / `buildExtractionPrompt`）与记忆设计移植自
  **ZCode**（[zai-org/ZCode](https://github.com/zai-org/ZCode)，Apache-2.0，Copyright 2026 Z.AI Co., Ltd）：
  改了什么、没移植什么、哪些是重写而非照抄，见 [`NOTICE.md`](NOTICE.md)；该许可的副本是
  [`LICENSE-Apache-2.0.txt`](LICENSE-Apache-2.0.txt)。

## 结构

```text
package.json        # dsh.bundle.patch + dsh.client{platform:web, immediately, inject:[…]}；version 0.2.0
cordis.patch.yml    # insert: id: workspace-memory, name: dsh-workspace-memory
README.md           # 本文件
INTERFACES.md       # 冻结的跨半契约（RPC 信封/端点/数据形状/座位/config 语义）；契约 v2，§8 是变更记录
PLAN.md             # 路线图与逐项交付状态（v0.2.0 每一条都带 ✅/⚠️ 状态行）
lib/memory-core.js  # 纯函数：路径、索引、指针、事实文件、提取提示与解析、相关度打分、路由（零依赖）
lib/host.js         # Host 半：Config、system section、会话监听、后台提取、ctx.fs 写盘、RPC、导出/导入、提案
lib/client.js       # Client 半：左栏图标 + 整页（纯浏览器 JS，只 require('react')）
locale/{zh,en}.json # 插件管理页元数据
icon.svg            # 原创图标
test/               # node --test 用例（22 个套件 / 304 项）
scripts/            # 校验脚本：check-syntax（ESM 语法 lint）、verify-host-e2e、verify-snapshot、inspect-session、verify-memory-dir
.github/workflows/ci.yml  # CI：windows/ubuntu × Node 20/22 矩阵，跑 lint + 测试 + E2E
NOTICE.md           # 上游 ZCode 归属与「改了什么」说明
LICENSE / LICENSE-Apache-2.0.txt  # 第一方 MIT + 上游 Apache-2.0 许可副本
```
