# dsh-workspace-memory — 工作区记忆（移植 ZCode）

把 ZCode 的 **Project / Workspace Memory** 移植到 DeepSeek Harness：每个工作区一份持久 Markdown
记忆，主会话开始时自动进入模型上下文，每轮成功对话后由后台提取补充；另有一个只读页面浏览记忆。

- 上游依据：ZCode `apps/zcode-cli/docs/design/v2/memory/README.md`（Memory 设计 v4）+
  `packages/core/src/memory/*`、`packages/core/src/context/sections/memory.ts`。
- 本插件是 **Host + Client** 两半，纯 JS、无构建步骤；`dsh plugin add` 一条命令装好，
  也可用 `plugin_manager install_bundle` 从本地目录装。

## 它做什么

1. **持久记忆目录**：每个工作区 `<workspaceRoot>/.dsh/memory/`，内含 `MEMORY.md` 索引与
   「一事实一文件」的 `<fact-name>.md`（YAML frontmatter + Markdown 正文）。
2. **会话开始注入**：主会话创建/恢复时，把 ZCode 同源的 `# Memory` 使用规则 + 当前
   `MEMORY.md` 索引注入 system prompt（每个 Agent 只读一次，会话中途不重读）。
3. **模型自己写**：你对助手说「记住…」，它按规则用现有 `write` / `edit` 工具把事实写进记忆目录，
   并同步 `MEMORY.md` 指针行（`- [Title](fact.md) — hook`）。
4. **后台自动提取**：每轮**成功**对话后（回复已经产出、不阻塞），后台发一个一次性模型请求，
   从本轮对话里挑出值得长期记住的事实，写成事实文件并维护索引。
5. **只读浏览**：左栏「工作区记忆」图标 → 整页列出所有有记忆的工作区与文件，查看原文（等宽原文，
   不渲染 Markdown）。

## 生效范围

| 维度 | 行为 |
|---|---|
| 开关粒度 | `enabled` 是**插件级（profile 级）**配置；开启后该 profile 下所有工作区的主会话都生效（与 ZCode 的全局开关一致） |
| 内容隔离 | **按工作区隔离**：记忆根 = 会话不可变的 `session.header.cwd`；工作区之间互不可见，同一工作区的多个会话共享一份 |
| 落盘时机 | **惰性**：只有真的开过主会话的工作区才会 best-effort 创建 `.dsh/memory/` |
| 子 Agent | **不生效**：`session.header.origin === 'subagent'`（subagent / workflow child / 队友）不注入、不提取 |
| read-only 会话 | 半生效：规则段照常注入，但**不建目录、不提取**；模型写记忆按沙箱正常被拒（无绕过） |
| 计划模式 | 记忆写入沿用宿主工具策略，会被拦（与 ZCode 有意不同，见下） |
| 其它 profile | 不装不生效；安装是 profile 级动作 |

## 数据布局

```text
<workspaceRoot>/.dsh/memory/
  MEMORY.md              # 索引；无 frontmatter；一行一条 `- [Title](fact-name.md) — hook`
  <fact-name>.md         # 一事实一文件
```

事实文件格式（与 ZCode 一致）：

```markdown
---
name: concise-memory-name
description: one-line recall description
metadata:
  node_type: memory
  type: user | feedback | project | reference
  originSessionId: sess_…
---
One durable fact.
```

- `type`：`user`（用户角色/背景/偏好）、`feedback`（协作方式的确认或纠正，正文带 `**Why:**` /
  `**How to apply:**`）、`project`（代码里推不出的项目原因/约束/决策）、`reference`（外部资源指针）。
- `name` 为小写 kebab-case（1–48 字符），正文可用 `[[other-name]]` 关联其它事实。
- `metadata.node_type` 与 `originSessionId` 由插件维护（新建时填当前会话，更新时保留原值）；
  其余约束与 ZCode 一样是提示词级约束，不做写后 schema 校验。
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
| `debugLog` | `false` | 追加更细的诊断（索引读取、跳过原因、写盘细节）到 `%TEMP%\workspace-memory-host.log` |

> 宿主日志 `%TEMP%\workspace-memory-host.log` 里，**每轮结束都会有一行提取结论**
> （`extraction done …` / `extraction skipped … (原因)` / `extraction request failed …`），
> 因为后台提取是一次真实计费请求、不会进入会话日志；`debugLog` 只增加更啰嗦的过程细节。

> 用量提示：开启 `autoExtract` 后，系统可能发起额外的模型请求来提取长期记忆，从而增加 Token
> 用量与使用成本。关掉它仍然可以手动让助手「记住…」。

## 后台提取（autoExtract）细节

- **触发**：`turn/end` 且 `reason.kind === 'completed'`；每个 Agent 单槽排队（正在跑时只保留最新一次）。
- **跳过规则**（ZCode 同款）：本轮里模型自己写过记忆（写工具参数命中记忆根）→ 跳过；
  本轮没有「独立文本块且词数 ≥ 3」的用户发言 → 跳过。中文按 CJK 字符折半计词
  （否则纯中文发言的词数永远算 1，自动提取再也不会触发）。
- **模型请求**：复用会话当前路由（`session.requestContext()` → 请求头 → Agent 选项 → 默认模型），
  `maxTokens = 1200`，只喂本轮的 user/assistant 文本（尾部截断 24,000 字符）与现有记忆清单；
  要求回复固定 JSON（`{"memories":[…],"forget":[…]}`），失败/非法 JSON/非 `stop` 结束 → 整轮放弃，不重试、不部分写入。
- **写入**：每轮最多 5 条事实；沿用会话自己的沙箱策略写入本工作区，`forget` 删除文件并移除指针。
- 关闭宿主/会话结束时中断在飞的提取，丢弃迟到结果。

## 与 ZCode 的差异（有意为之）

| 项 | ZCode | 本插件 |
|---|---|---|
| 存储根 | CLI 私有存储 `memories/projects/<key>/memory/`（仓库外） | 工作区内 `<cwd>/.dsh/memory/` —— DSH 沙箱默认 workspace-write，工作区外写会被拒；放工作区内可全程不绕过沙箱、模型用原生工具维护 |
| 写入方式 | 模型用 Write/Edit 写；提取是受限的 5 轮 Memory Agent（Read/Grep/Glob/只读 Bash/记忆目录内 Write/Edit） | 模型用 `write`/`edit`；提取是一次性 JSON 请求 + Host 写盘（DSH 不允许插件注册新工具策略/追加事件类型） |
| 注入位置 | system 段（规则）+ 首条 user message（索引） | 单个 per-agent system section（规则 + 索引），语义等价、KV 前缀更稳 |
| 索引刷新 | 每会话初始化读一次 | 同（中途不重读；提取的新记忆下个会话可见） |
| Plan 模式 | 允许写记忆 | 沿用宿主工具策略（会被拦） |
| 提取资格 | 「独立文本块 ≥ 3 个空白分隔词」 | 同样阈值，但 CJK 字符折半计词（中文发言才能合格） |
| 语义召回 / Dream | 代码保留但当前产品链路不启用 | 不做（与上游当前行为一致） |
| custom-agent 记忆 / 全局 kill switch 分层 / `-p` headless 门控 | 有 | 不做 |

## 安装 / 更新 / 卸载

从 GitHub 安装：

```bash
dsh plugin --profile <profile> add github:moondrop12138/dsh-zcode-workspace-memory
```

本地开发目录安装：`plugin_manager` → `install_bundle`，target 为本目录绝对路径。

- 更新：**Client 半改动刷新页面即可；Host 半改动必须 `remove_bundle` + `install_bundle` 重装。**
- 卸载：`remove_bundle`（或 `dsh plugin --profile <profile> remove dsh-workspace-memory`），
  左栏图标与页面随之消失（监听/定时器都由 `ctx.effect` 接管）。

## 测试

```bash
cd dsh-workspace-memory && node --test
```

覆盖：路径与文件名安全、索引 frontmatter/注释剥离与双上限截断、指针 upsert/remove、
事实文件生成与 frontmatter 解析、origin 保留、提取资格判定（direct-write / 词数）、
转录尾部截断、提取提示词、JSON 解析（围栏/前后废话/字符串内花括号/非法条目整轮放弃/5 条上限）、
路由回退顺序。

## 验收实测（2026-10-18，本机 Desktop profile）

| 验收项 | 结果 | 证据 |
|---|---|---|
| A1 安装 | ✅ | `install_bundle` → `application: applied`、`warnings: []`；`Config.listConfigs` 返回 `enabled/autoExtract/maxIndexChars/debugLog` 四个 `x-cordis.volatile` 字段与默认值 |
| A2 会话注入 | ✅（活会话） | 安装后同一个正在运行的会话，最新 `system/message` 含 `# Memory`，且带绝对记忆根 `<workspace>\.dsh\memory/`；`.dsh/memory/` 已被创建 |
| A2' 插件热生效 | ✅ | 删除记忆目录后 `remove_bundle` + `install_bundle`，目录被重新创建，宿主日志无 `systemPrompt is unavailable`（`systemPrompt` 已声明为硬依赖） |
| A4' 提取落盘（宿主侧） | ✅ | Lead 独立 E2E（`scripts/verify-host-e2e.mjs`）：14/14 通过 —— 事实文件 + `originSessionId` + `MEMORY.md` 指针、请求带 route/system/1200 maxTokens、direct-write 跳过、read-only 不建目录不提取、subagent 不注入不提取 |
| A5 read-only | ✅ | 同上（不建目录、不提取、仍注入规则段） |
| A6 子 Agent | ✅ | 同上（无 `# Memory`、不提取） |
| A7 UI 注册 | ✅（live 槽位） | `Slots.listSubTree('sidebar.panellist')` 出现 `workspace-memory`（order 30，active）；`main` 出现 key `workspace-memory` |
| A8 单元测试 | ✅ | `node --test` 37/37 通过 |
| A4 触发与判定（live） | ✅ | 宿主日志每个 `turn/end` 一行结论：本会话 3 个完成的 turn 都在判定范围内；定时提醒那轮判为 `extraction skipped … (no-user-prose)`——正确，因为提醒消息的 `source.kind` 是 `schedule` 而不是 `user`（会话日志实测 `userMessageSources = {user:2, runtime-context:1, skill-catalog:1, time-context:5, agent-message:5, subagent-settled:5, schedule:2}`） |
| A4' 真实模型提取 | ⏳ | 尚未发生：装好之后的所有 turn 的用户发言要么是 `schedule` 来源、要么在 journaling 之前结束。**发一句真实中文（≥3 字单位，如「记住：这个项目用 tabs」）**即可触发，届时日志出现 `extraction done … memories=N` |
| A3 记忆协议落盘（live） | ✅（协议） | 按协议写入示例事实 `workspace-memory-port.md` + `MEMORY.md`，用插件自己的纯函数回读校验：文件名被接受、frontmatter 解析出 `type: project` 与 `originSessionId`、`buildManifest` 正常、下一会话的注入块含该指针行 |
| A3' 模型自主写入 | ⏳ | 提示词与文件协议已就绪并已注入；是否照做取决于模型，需一次真实「记住…」指令才能作为证据 |
| 设置表单可见性 | ⏳（待目视） | schema 已确认；请在「插件」页确认 Configure 表单 |

复现命令：

```bash
cd dsh-workspace-memory
node --test                        # 37 项纯函数/集成用例
node scripts/verify-host-e2e.mjs   # 14 项宿主侧端到端断言
node scripts/inspect-session.mjs <session.v4.jsonl.zstd>   # 检查某会话最新 system 段是否含 # Memory
node scripts/verify-memory-dir.mjs "<工作区绝对路径>"        # 用插件自己的纯函数校验记忆目录与注入块
```

## 已知限制

- **提取请求不可回放**：DSH 不允许插件追加新的事件类型，提取的请求/响应不会写进会话日志；
  只有 `%TEMP%\workspace-memory-host.log` 里的每轮结论行（成功了什么、为什么跳过、是否失败）。
- **中途不刷新索引**：会话中途模型或提取写入的新记忆，要到下一个会话才进入上下文（ZCode 同语义）。
- **索引指针可能悬空**：记忆文件被外部删除/改名后，插件不做修复器（与 ZCode 一致）；页面会显示实际存在的文件。
- **记忆可见性**：`.dsh/memory/` 在仓库里，是否提交由你决定。
- **UI 是只读的**：页面不提供编辑/删除；开关在插件设置里，记忆内容由模型或提取写入。

## 结构

```text
package.json        # dsh.bundle.patch + dsh.client{platform:web, immediately, inject:[…]}
cordis.patch.yml    # insert: id: workspace-memory, name: dsh-workspace-memory
INTERFACES.md       # 冻结的跨半契约（RPC 信封/端点/数据形状/座位/config 语义）
lib/memory-core.js  # 纯函数：路径、索引、指针、事实文件、提取提示与解析、路由（零依赖）
lib/host.js         # Host 半：Config、system section、会话监听、后台提取、ctx.fs 写盘、RPC
lib/client.js       # Client 半：左栏图标 + 整页（纯浏览器 JS，只 require('react')）
locale/{zh,en}.json # 插件管理页元数据
icon.svg            # 原创图标
test/               # node --test 用例
```
