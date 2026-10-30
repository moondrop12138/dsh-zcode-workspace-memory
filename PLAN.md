# dsh-workspace-memory 路线图

> 2026-10-24 上线前审查产出。按里程碑组织：M1 修数据安全阻断项，M2 补运营安全与卫生，M3 做不改契约的体验升级，M4 动冻结契约的记忆智能。
> 行号基于 v0.1.3 源码，改动后需按符号名重新定位。
> 工作量记号：S ≤ 半天，M 1–2 天，L ≥ 3 天。
>
> **发布状态（2026-10-25，v0.2.0）**：M1–M4 一次性随 **v0.2.0** 发布，中间没有单独出版本
> （下表的 0.1.4 / 0.1.5 / 0.1.6 是计划版本号，实际未发版）。逐项状态见每个条目的
> `状态：` 行——26 项 ✅ done，1 项 ⚠️ 降级（C5 Markdown 渲染）。

## 总览

| 里程碑 | 计划版本 | 实际发布 | 主题 | 契约影响 |
|---|---|---|---|---|
| M1 | 0.1.4 | 0.2.0 | 数据安全与一致性（上线阻断） | 无 |
| M2 | 0.1.5 | 0.2.0 | 安全边界、成本控制、运营卫生 | RPC 行为收窄（修 bug 性质） |
| M3 | 0.1.6 | 0.2.0 | 记忆体验（面板 + 可见性） | 新增 RPC 端点，向后兼容 |
| M4 | 0.2.0 | 0.2.0 | 契约升级：智能召回（D1 全局层已撤回，契约 v2.1） | INTERFACES.md v2.1 |
| M5 | 0.3.0 | 0.3.0 | ZCode 能力对齐：相关记忆 / 检索分支 / Dream / 游标 / agent 记忆 | INTERFACES.md v2.2 |
| M6 | 0.4.0 | 0.4.0 | 受限工具循环提取引擎（W6） | INTERFACES.md v2.3 |

明确不做（当前版本范围外）：向量/embedding 检索、云端同步、多设备实时协作、记忆跨用户共享。

---

## M1 — 数据安全与一致性（v0.1.4，上线阻断）

### A1. forget 进回收站，不再直接删除 — S
- **问题**：`forget` 列表直接 `unlink` 事实文件（`lib/host.js:1177-1186`），`MEMORY.md.prev` 只回滚索引不恢复文件；模型幻觉一个真实 fact 名 = 永久丢数据。
- **方案**：删除改为移动到 `<memory-root>/trash/<name>.md`（同工作区可见、可手工恢复）；trash 目录在 listDir/manifest/buildManifest 中排除；trash 保留最近 N=50 条，超出按时间淘汰。
- **验收**：单测覆盖 forget → trash 存在原文件、索引指针已移除、再次提取不把 trash 当事实；README 数据布局章节更新。
- **状态：✅ done（v0.2.0）**。`trash/` 实现在 `lib/host.js`（`trashDir` / 先复制后删原文，`TRASH_KEEP = 50` 按 mtime 淘汰）；`isNonFactEntry` 让清单、catalog、索引修复、快照导出全部跳过 `trash/`；README §数据布局 与 §后台提取 已写明。测试：`extraction.test.mjs`（回收站用例）。

### A2. 工作区级写互斥 — M
- **问题**：`bySession` 按会话键控，同工作区多会话的 `applyExtraction` 可交错 read-modify-write MEMORY.md，后写覆盖前写（`lib/host.js` applyExtraction 全程无跨会话锁）。
- **方案**：按 `normalizePathKey(memoryRoot)` 维护 per-workspace promise 链互斥（模块级 Map，键为工作区记忆根），包住 applyExtraction 与 repairIndex 的读写区间；锁要在 `ctx.effect` dispose 时清理。
- **验收**：新增并发测试——两个 fake 会话对同一工作区交错触发提取，最终索引包含双方写入的指针，无丢失。
- **状态：✅ done（v0.2.0）**。模块级 `workspaceLocks`（promise 链，键 = `normalizePathKey(<层根>)`）包住 `applyExtraction` 与 `repairIndex` 的读写区间，dispose 时清理；v2 起键是层根路径，所以全局层与每个工作区层各自独立。测试：`extraction.test.mjs` 并发用例。

### A3. 索引守卫升级为内容比对 — S
- **问题**：`evaluateIndexReplacement`（`lib/memory-core.js:775-786`）只数指针行数，两份行数相同、内容不同的索引可互相覆盖且守卫不响。
- **方案**：在行数守卫之上加指针集合 diff：after 中出现的每个指针行，要么存在于 before，要么属于本轮 plan 的 writes；否则拒绝写入并记日志。同名指针的 title/hook 被改写时要求该 name 出现在本轮 plan 中。
- **验收**：单测——用行数相同但内容无关的索引尝试替换，守卫拒绝；正常的 upsert（改 title/hook）放行。
- **状态：✅ done（v0.2.0）**。`evaluateIndexReplacement` 在行数守卫之上做指针集合 diff（after 的每个指针要么在 before、要么属于本轮 plan），返回 `write-refused` 时不落盘；`MEMORY.md` 覆盖前备份 `MEMORY.md.prev`。测试：`memory-core.test.mjs`。

### A4. 部分写失败的一致性 — S
- **问题**：写 fact 失败即 `break`（`lib/host.js:1174`），但已执行的 forget 删除和索引更新不回退，产生悬空指针/丢事实的混合状态。
- **方案**：调整执行顺序为「先全部写入 → 再更新索引 → 最后执行删除（进 trash）」；任一步失败则整批中止且索引不动，已写入的 fact 文件留下（无指针，下轮 repairIndex 兜底补指针，无害）。
- **验收**：单测模拟第 2 个 fact 写入抛错：索引未更新、forget 未执行、第 1 个 fact 文件存在；日志含失败原因。
- **状态：✅ done（v0.2.0）**。写盘顺序改为「事实 → 索引 → forget 进回收站」，任一步失败整批中止；测试 `a failed fact write aborts the batch…` / `a failed index write leaves the forgets untouched`。

### A5. CJK 标题兜底 slug — S
- **问题**：模型未给 kebab `name` 且标题为纯中文时，`slugifyTitle` 返回 undefined，`normalizeExtractedMemory` 返回 undefined（`lib/memory-core.js:697`）连带**整轮** memories 全部丢弃。对中文用户生态是功能性缺陷。
- **方案**：`normalizeExtractedMemory` 对无法 slug 的条目改用兜底名 `fact-<内容短哈希前 8 位>`，仅丢弃该条无效字段，不再整轮放弃；仅当条目本身缺 body/description 时才丢单条。
- **验收**：单测——纯中文标题 + 无 name 的条目产出 `fact-xxxxxxxx` 并正常写入；其余条目不受连带丢弃。
- **状态：✅ done（v0.2.0）**。无法 slug 的条目回退到 `fact-<sha256 前 8 位>`，只丢该条坏字段、不再整轮放弃。测试：`memory-core.test.mjs`。

### A6. CI 与并发测试基建 — S
- **问题**：package.json 无 lint/typecheck/CI；现有 37 单测 + 14 E2E 全部跑在内存假文件系统上，无任何并发场景。
- **方案**：GitHub Actions（windows-latest + ubuntu-latest 矩阵）跑 `node --test` 与 `node scripts/verify-host-e2e.mjs`；A2/A4 的新测试并入。
- **验收**：双平台绿；README 验收表引用 CI 状态。
- **状态：✅ done（v0.2.0）**。`.github/workflows/ci.yml`：windows-latest + ubuntu-latest × Node 20/22，每作业跑 `node scripts/check-syntax.mjs`、`node --test`、`node scripts/verify-host-e2e.mjs`；README 顶部挂状态徽章，`test/ci.test.mjs` 钉住矩阵与脚本接线。

---

## M2 — 安全边界、成本控制、运营卫生（v0.1.5）

### B1. RPC 收窄到调用方工作区 — M
- **问题**：`/api/dsh-workspace-memory/call` 的 `catalog` 聚合 workspaceRegistry ∪ sessions 的**所有** cwd，任何能向该端点 POST 的页面可枚举并读取全部工作区记忆。
- **方案**：catalog 默认只返回「请求来源会话的工作区」；panel 需要的多工作区列表改为显式白名单（settings 中登记的工作区），或要求请求携带 workspace id 并校验其属于当前连接可见集合。
- **验收**：集成测试——伪造请求无法列出新开工作区；panel 正常显示已登记工作区。
- **状态：✅ done（v0.2.0）**。`collectWorkspaceCandidates` = workspaceRegistry 白名单 ∪ 请求来源会话自己的工作区；session cwd 不再被枚举，伪造的 `sessionId` 必须先解析到 live tracked session 才生效。测试：`extraction.test.mjs` RPC 可见范围用例。

### B2. 提取预算与活动可见性 — M
- **问题**：每轮带合格用户散文的成功对话必发一次提取请求（转录尾部 24000 字符 + maxTokens 1200），无预算、无频率限制、UI 无计数——付费 API 用户的隐形开销。
- **方案**：新增 volatile 配置 `extractMinIntervalMs`（默认 0，即现状）与 `extractDailyLimit`（默认 0=不限）；host 侧记录 per-workspace 提取计数与最近提取时间；catalog 返回 `{todayCount, lastAt}`，panel 顶栏展示。
- **验收**：单测——到达日限时跳过提取并记日志；panel 显示计数。
- **状态：✅ done（v0.2.0）**。两个 volatile 开关（`extractMinIntervalMs` / `extractDailyLimit`）+ 内存态 `workspaceBudgets`（按本地日 `YYYY-MM-DD` 滚动，重启归零）；`catalog` 返回 `{todayCount, lastAt}`，panel 顶栏显示「今日提取 N 次」徽标。测试：`extraction.test.mjs` 预算用例、`panel.test.mjs` 计数徽标。

### B3. 初始化失败可重试 — S
- **问题**：`initializeAgent` 读索引失败只注入 rules，read-once 语义下 sectionCache 永不再填，该 Agent 整个生命周期无索引，但提取照跑。
- **方案**：初始化失败时缓存「失败」状态并在下次 section 读取时（或下一 turn 开始时）重试一次；连续失败按指数退避到不再重试。
- **验收**：单测——首次读失败、第二次成功，section 最终包含索引。
- **状态：✅ done（v0.2.0）**。失败态缓存 + 下一轮重试，连续失败按 1s/4s/16s 退避后本会话退化为只注入规则。测试：`test/section-retry.test.mjs`（5 项）。

### B4. 日志轮转 — S
- **问题**：每轮至少一行 `appendFileSync` 到 `%TEMP%/workspace-memory-host.log`（`lib/host.js:222-228`），无限增长。
- **方案**：写入前 stat，超过 1 MiB 时重命名为 `.log.1`（保留一代）后新建；debugLog 关闭时降为只记错误。
- **验收**：单测——日志文件不会无限增长。
- **状态：✅ done（v0.2.0）**。超 1 MiB 轮转为 `workspace-memory-host.log.1`（只保留一代）；`debugLog` 关闭时只记错误。测试：`test/log-rotation.test.mjs`。

### B5. README 验收闭环与文档矛盾 — S
- **问题**：验收表三项挂账（A4' 真实模型提取、A3' 模型自主写入、设置表单可见性）；README 自述「插件不做修复器」与 repairIndex 行为矛盾。
- **方案**：补做三项验收并更新表格；README 明确 repairIndex 的实际范围（补缺指针，不删悬空）。
- **验收**：README 验收表零挂账。
- **状态：✅ done（v0.2.0）**。三项挂账改为「stub 模型闭环 + 代码路径审计」并写明证据；README 已知限制里明确 repairIndex「只补缺、不删悬空、不越过 200 行上限」。

### B6. 杂项卫生 — S
- `yamlScalar` 白名单正则放行 `#`（`lib/memory-core.js:406`）：描述含 ` #` 被 YAML 截断为注释——去掉 `#` 或含 `#` 时强制加引号。
- client RPC 失败加指数退避（≤3 次）。
- `loadSchemaModule()` top-level await（`lib/host.js:168`）改惰性加载，避免阻塞模块导入。
- repairIndex 首启大目录逐文件读的耗时上限（把修复纳入 INIT_READ_TIMEOUT_MS 同级的预算）。
- **状态：✅ done（v0.2.0）**。四项全做：`yamlScalar` 含 `#` 等不安全字符时整值 `JSON.stringify` 加引号（`lib/memory-core.js`，且 ISO 时间戳保持裸值）；`callHost` 指数退避 ≤3 次（测试 `callHost retries transient rpc failures…` / `…gives up after three attempts`）；`loadSchemaModule()` 改为 `apply` 内惰性加载；`REPAIR_READ_TIMEOUT_MS = 5000` 与 `INIT_READ_TIMEOUT_MS` 同级，超预算即停并记日志（`index repair budget of …ms exhausted`）。

---

## M3 — 记忆体验，不改冻结契约（v0.1.6）

### C1. 提取活动提示与 diff — M
- 提取落盘后，panel 生成活动条目「记住了 2 条 / 忘了 1 条」，点击展示新旧索引 diff 与 fact 变更摘要；新增 RPC 端点 `activities`（追加式，向后兼容）。
- **验收**：一轮提取后 panel 出现活动条目，diff 可见。
- **状态：✅ done（v0.2.0）**。RPC `activities`（per-记忆根 ring buffer，`ACTIVITY_KEEP ≈ 50`，重启丢失）+ panel 的 `ActivityFeed` / `ActivityEntry` / `ActivityDiff`；`diffLines` 零依赖渲染「先删后增」的索引 diff。测试：`panel.test.mjs`（normalizeActivities / diffLines / ActivityEntry / ActivityDiff / ActivityFeed）、INTERFACES.md §6.4。

### C2. 会话级无痕开关 — S
- panel 提供当前会话「本轮不提取」toggle，host 侧 per-session volatile 标记，turn/end 直接跳过提取。不动 INTERFACES.md 冻结面（会话态非持久配置）。
- **验收**：开启后带散文的完成轮零 LLM 调用。
- **状态：✅ done（v0.2.0）**。RPC `session-state`（读/写 `skipTurnExtraction`，只对 live tracked session 生效）+ panel 的 `ConfigBar` toggle；`turn/end` 在预算计数前就 drop。测试：`panel.test.mjs`（`normalizeCatalog keeps the per-session skip flag`、`ConfigBar renders the session incognito toggle…`）。

### C3. 面板增删改与回收站 UI — L ✅（v0.2.0）
- panel 支持新建/编辑/删除 fact（删除进 trash，可恢复，依赖 A1）；索引同步更新走 host 的统一写入路径（复用互斥锁与守卫）。
- **验收**：panel 编辑一条记忆后，索引与文件一致；删除可在回收站恢复。
- **状态：✅ done（v0.2.0）**。Host 新增五个写端点（`fact-read` / `fact-save` / `fact-delete` / `trash-list` / `trash-restore`，契约见 INTERFACES.md §6.10–6.11），全部走 `runWithWorkspaceLocks` + `evaluateIndexReplacement`，事实文件与 `MEMORY.md` 指针在同一次临界区内更新，删除复用 `forgetToTrash` + `trimTrash`；panel 新增「新建事实」入口、事实正文的「编辑 / 删除（两步确认，提示可在回收站恢复）」、内联编辑器（名称更新时只读）与回收站视图（列表 + 恢复）。测试：`test/panel-write.test.mjs` 8 项（save 建文件+指针 / 更新保留 createdAt 与指针标题 / 非法名类型空正文与路径穿越拒写 / delete 进 trash 并移除指针 / trash-list 列出 / restore 还原并补指针 / 同名拒恢复 / 守卫拒绝降级索引）、`test/panel-editor.test.mjs` 10 项（预填 / 新建草稿 / onField / fact-save payload 与 RPC 路由 / 前端校验 / 两步删除与 fact-delete / 内联错误 / 回收站列表与 trash-restore / 空回收站与忙碌态 / 无 innerHTML）。

### C4. 搜索、筛选与虚拟列表 — M ✅（2026-10-24）
- 按 type（user/feedback/project/reference）与关键词过滤；文件列表虚拟滚动（现全量渲染，仅靠 CONTENT_RENDER_MAX=1000000 兜底）。
- **验收**：host catalog 为 fact 条目补 `type`（读 frontmatter，5 秒预算，向后兼容增补，index/非法值不标）；页面文件列表提供 type chips + 关键词输入（纯客户端过滤，index 只按名匹配、fact 按名+type），超过 60 条走自实现窗口化虚拟列表（固定行高 + 上下 spacer + overscan，零依赖）。测试：`test/search-filter.test.mjs` 9 项（filterFiles / windowFiles / FileFilterBar / FileList 明细与虚拟 / FileColumn / locale keys / host 标注 / RPC catalog 契约）。
- **状态：✅ done（v0.2.0）**。`CATALOG_TYPE_TIMEOUT_MS = 5000` 逐文件读 frontmatter 标 type，`VIRTUAL_LIST_MIN = 60` 起走 `windowFiles` 虚拟列表，零依赖。

### C5. Markdown 渲染 — M
- fact 正文以安全 Markdown 渲染（白名单标签、无原始 HTML；现有 React 文本节点方案保持 XSS 安全基线）。索引 MEMORY.md 保持纯文本。
- **状态：⚠️ 降级（v0.2.0 不做，有意为之）**。原因：纯 JS 插件（不打包、无 JSX、只从模块表取 React）拿不到可用的 Markdown 渲染器，自写一个白名单渲染器 = 在唯一读取任意记忆正文的地方引入 XSS 面。当前决定写在 INTERFACES.md §7：正文以等宽 `<pre>` 显示原文（XSS 安全基线），索引保持纯文本。若后续要做，需要自带一个零依赖的受限渲染器并配套安全测试。

### C6. 索引会话中刷新 — S ✅（2026-10-24）
- 提取落盘后使对应 Agent 的 sectionCache 失效，下一 turn 注入含新记忆（现状 read-once，本轮记的事同会话不可见）。
- **验收**：同会话第二轮 section 文本包含新指针。实现：`refreshAgentSection`（`lib/host.js`）在 applyExtraction 报告 `applied.changed` 后 fire-and-forget 重读 section——成功回填缓存并清理过期的 B3 重试态，失败保留上次好文本、不动退避；模型经 write/edit 自写的记忆不触发刷新。测试：`test/section-refresh.test.mjs` 5 项。
- **状态：✅ done（v0.2.0）**。

### C7. subagent 只读注入 — S ✅（2026-10-24）
- 队友/subagent 会话注入索引 section（不跑提取、不初始化写路径），解决 Team 场景零记忆。
- **验收**：subagent 会话 section 含索引；tools/result 不触发提取。实现：`isEligibleSession` 不再排除 subagent，新增 `isSubagentSession`，record 带 `readOnly` 标记——byAgent 注册（section/backoff 正常）、bySession 不注册（turn 事件不路由）、不建目录、索引修复不落盘（含 writable 沙箱）。测试：`subagent sessions are eligible for a read-only section…`、`isSubagentSession recognizes…`、`a subagent session gets a read-only index section and never extracts`；E2E case 4 重写为只读注入（16/16）。
- **状态：✅ done（v0.2.0）**。

---

## M4 — 契约升级：智能召回（全局层已撤回，v2.1）

> 本里程碑动 INTERFACES.md 冻结契约，需发布契约 v2 并写迁移说明（旧数据自动迁移或兼容读取）。

### D1. 双层记忆：工作区层 + 用户全局层 — L
- 新增 `~/.dsh/memory/`（用户主目录）为全局层；type=user/feedback 的记忆路由到全局层，project/reference 留在工作区层；注入时合并（全局在前），提取 manifest 同时带两层。
- **验收**：项目 A 学到的用户偏好在项目 B 注入可见；跨层 forget 不误删。
- **状态：✅ done（v0.2.0，契约 v2）→ ⚠️ 已撤回（契约 v2.1，2026-10-25，用户决定）**。v0.2.0 曾实现全局层 `~/.dsh/memory/`、按 type 路由、注入合并两层。用户随后明确要求**不要全局层**：记忆必须按工作区独立存放，`globalRootOf` / `Config.globalMemoryRoot` / 按 type 路由 / 所有 per-layer 循环已全部删除，`os.homedir()` 不再参与任何记忆根计算；RPC 响应、导出清单、提案载荷里的 `global` 也被剔除（`layer` 至多 `'workspace'`）。原 `test/dual-layer.test.mjs` 改写为 `test/workspace-layer.test.mjs`（断言只碰本工作区、不建全局目录、不碰用户主目录）。详见 INTERFACES.md §2.5。

### D2. frontmatter 时间戳与使用统计 — M
- 新增 `createdAt`/`updatedAt`（写入时维护）；host 在模型 read 命中 fact 文件时惰性更新 `lastAccessedAt`（低频、批量落盘）；panel 展示三时间。
- **验收**：新写入 fact 带时间戳；旧文件缺字段可正常解析。
- **状态：✅ done（v0.2.0）**。写入时铸 `createdAt`/`updatedAt`（更新保留 `createdAt`），`lastAccessedAt` 由 read 命中触发、经 debounce 批量落盘；旧文件缺字段按 0/未知处理照常解析；catalog 带上三者，panel 展示相对时间。测试：`test/fact-timestamps.test.mjs`。

### D3. 相关性注入排序 — M ✅（2026-10-24）
- 会话开始时用首条用户消息对索引指针做轻量排序（关键词/标题重叠打分，不用 embedding），截断发生在排序之后而非原文顺序——避免「最老但一直有效的偏好」被截断丢失。
- **验收**：注入后高相关指针排在前面；紧 cap 下高相关指针存活、按原文序会被截断。实现：`queryTermsForRanking`（ASCII 词去停用词+去尾 s 轻单数化、CJK 单字+相邻二元组）、`scoreIndexPointer`（title ×2 / hook ×1 / 文件名 ×1）、`reorderIndexForQuery`（稳定排序，平分与零分保原序，非指针行原位）——零依赖纯函数在 `lib/memory-core.js`；`formatIndexContent` 接受可选 `query`（先排序后截断），`buildMemorySection` 透传（v2.1 起只有工作区索引一块）；`lib/host.js` `noteSessionQuery` 在会话首条带关键词信号的用户消息时记 query 并 fire-and-forget `refreshAgentSection`。排序只影响注入展示序，永不回写 `MEMORY.md`；无 query 会话逐字节等价。测试：`test/relevance.test.mjs` 14 项。
- **状态：✅ done（v0.2.0）**。

### D4. 冲突更新引导 — S
- 提取 prompt 对 manifest 中与候选 name 相近（编辑距离/前缀）的条目附上正文，引导模型原地更新而非另起新名（upsert 按 name 匹配，名字不同即新增，是重复记忆的主因）。
- **状态：✅ done（v0.2.0）**。首轮回复里 `name` 与现有事实「前缀相同（两名字都 ≥ 3 字符）或编辑距离 ≤ 2」时，把冲突文件正文摘要（≤ 600 字符）+ `## Conflicting existing files` 追加进提示词**重问一次**；重问不可用则沿用首轮计划，无冲突时整轮只花一次调用；被纠正到已有名字的条目写盘时原地更新那个已有文件。测试：`extraction.test.mjs` 冲突用例。

### D5. 提取专用模型路由 — S
- 新增 volatile 配置 `extractProvider/extractModel`，缺省回退会话模型；提取是格式化转写任务，可用低价模型（同时缓解 B2 的成本问题）。
- **状态：✅ done（v0.2.0）**。两个 volatile 字段，都空则用会话路由；只填一个时另一个仍取自会话路由；两个都填则完全不看会话路由。测试：`extraction.test.mjs`（`extraction routes through the configured extractProvider/extractModel when set`、`an empty extraction route keeps the session route`）。

### D6. 长会话分段提取 — M
- 转录超 24000 字符时分段提取、按段合并去重后统一过守卫写入（现状尾部截断导致长会话开头的事实提不到）。
- **状态：✅ done（v0.2.0）**。超 24,000 字符切成至多 3 段（消息边界、逐段 ≤ 24,000）各问一次，按 `name` 合并（后者为准、`forget` 取并集），合并结果走**同一次**冲突重问 + **一次**加锁写盘；整轮仍只算 1 次提取（`todayCount` 只 +1）。测试：`test/segmented-extraction.test.mjs`（3 项，含「分段轮在日限 1 下只耗 1 单位」）。

### D7. 记忆 git 化与导出 — M ✅（2026-10-25）
- 提供 `memory export`（打包 zip）/ `import`；可选「git 模式」：每次成功写入后在工作区 memory 目录自动 commit（检测到已是 repo 才启用），免费获得版本历史/回滚/多机同步。
- **done（2026-10-25）**：导出改成零依赖快照（不引入压缩库、不打包 zip，`README`/`INTERFACES` §6.5 已写明）——RPC `export` 把工作区记忆根拷进 `<targetDir>/workspace-memory-export-<ISO>/workspace/` + 根部 `manifest.json`（format/version/createdAt/每文件 bytes+sha256），`proposals/`、`trash/` 不进快照。RPC `import` 两阶段：先校验 manifest 形状与每个文件的字节数/校验和，任一不符即以 `invalid-manifest`/`invalid-snapshot`/`nothing-to-import` 中止且**一个字节都不写**；再在同一个 per-root 互斥锁内走统一受保护写入（内容相同跳过、`MEMORY.md.prev` 备份、冲突事实先入 `trash/`）。git 模式：仅当 `<记忆根>/.git` 存在且 `gitCommitEnabled`（默认 true）时，在提取落盘/导入/接受提案后派游离子进程 `git add -A` → `git commit -m ...`（`stdio: 'ignore'`，15s 上限，绝不 `git init`，失败只写日志、永不拖住本轮）。辅助脚本 `scripts/verify-snapshot.mjs` 用同一套规则离线核对快照目录。测试：`test/export-import.test.mjs` 4 项（导出清单与文件、坏 manifest 零写入、真实临时 git 仓库确实产生提交、无 `.git` 时完全不碰 git）。
- **状态：✅ done（v0.2.0，含一处有意的口径变更）**。口径变更：计划里写的「打包 zip」没有实现，改成零依赖目录快照 + `manifest.json`（不引第三方压缩库，`GIT_TIMEOUT_MS = 15000`）。这不是缩水：快照可离线用 `scripts/verify-snapshot.mjs` 逐字节校验，导入前先全量校验再写。

### D8. 定期整理任务（可后置到 0.2.x）— M ✅（2026-10-25）
- 记忆数超阈值后跑一次合并去重分析（近重复名、矛盾事实），产出**待确认**的整理方案由用户批准执行，不自动写。
- **done（2026-10-25）**：工作区事实数 > 60（`PROPOSAL_FACT_THRESHOLD`）时，该工作区**下一次**提取落盘后写一个 `<记忆根>/proposals/consolidation-<ISO>.md`，固定三节——近似重名（复用既有前缀/编辑距离规则，给出 keep/drop）、疑似矛盾（描述词项重合，人工判定）、长期未访问（`lastAccessedAt` 超 90 天）——外加末尾 ```json marker 保存全量机器可读项与三类计数；每节最多渲染 50 条。**永不自动应用**：RPC `proposals` 列表，RPC `proposals-accept` 只应用近似重名的删除项，且复用统一受保护写入（索引指针同步移除、`MEMORY.md.prev` 备份、丢弃文件入 `trash/`、`evaluateIndexReplacement` 不通过则 `write-refused` 且不写、重复接受返回 `already-accepted`）。`proposals/` 不算事实：`isNonFactEntry` 让提取清单、catalog/目录列举、索引修复与快照导出全部跳过它。测试：`test/proposals.test.mjs` 3 项（阈值下不产出、阈值上产出且三节齐全、`proposals/` 不计入事实数）。
- **状态：✅ done（v0.2.0）**。

---

## 顺手项（随任意里程碑搭车）

- 更新本仓库记忆档案：`.dsh/memory/workspace-memory-index-overwrite-bug.md` 已过时（代码已修复），按插件自己的规则执行 forget/更新——该项目记忆系统自身的第一次dogfood。
- **状态：✅ done（v0.2.0）**。dogfood 闭环落在 `test/dogfood.test.mjs`；工作区记忆档案里的 `workspace-memory-index-overwrite-bug.md` 已按插件自身规则更正为「已修复」。

## M5 — ZCode 能力对齐（v0.3.0，2026-10-30）

用户要求「用 workflow 并行完成那 5 个能力缺口，这一次就完全对齐」（m00851）。做法是能力等价、
按 DSH 约束落地：能照搬的上游模块直接移植（Apache-2.0，见 NOTICE.md），DSH 拿不到的
（写工具、受限工具循环）用一次性 JSON 计划 + 宿主受保护写路径替代。

### W1. 相关记忆可见性 — S ✅（v0.3.0）

上游让提取 Agent 自己 Read/Grep 记忆目录；本插件在提取提示词里追加「可能相关的既有记忆」
（转录文本 vs 既有条目打分，最多 8 条 × 400 字符、总 3,200 字符）。
`lib/related.js` · `test/related.test.mjs`（16）· 集成在 `extractOnce`。
**状态：✅ done**（E2E 断言 `extraction prompt shows the possibly-related existing memories`）。

### W2. 检索分支 + selector — M ✅（v0.3.0）

`lib/recall.js` 移植 `project-memory-retrieval-branch.ts` 与 `recall/{manifest,selector,content,types,index}.ts`：
`default-index` 与 `semantic-recall` 互斥，selector 最多 5 条、单条 200 行 / 4096 字节、会话 61,440
字符、>48h 标年龄。开关保持上游的代码常量 `SEMANTIC_RECALL_ENABLED = false`，不开放配置；
`retrieval` 端点只读报告当前分支。**状态：✅ done**（`test/recall.test.mjs` 26 项；E2E 断言分支为 `default-index`）。

### W3. Dream 等价层 — L ✅（v0.3.0）

`lib/dream.js` 移植 `dream.ts` 的锁（`.consolidate-lock`，1h 新鲜度 + PID）与时机门（24h 最小间隔、
10min 扫描节流、≥5 个新会话），四阶段提示词改 `CLAUDE.md` → `AGENTS.md`；写盘复用 `applyExtraction`，
所以索引守卫、`MEMORY.md.prev`、trash 环全部生效。与上游一致**不自动触发**：只由 `dream-run` 手动跑，
`dream-status` 报告状态；`collectDreamTouchedPaths` 未搬（依赖 bash 命令解析）。
**状态：✅ done**（`test/dream.test.mjs` 24 项；E2E 跑通 `dream-status` 与一次 `dream-run`）。

### W4. 提取游标 — M ✅（v0.3.0）

`lib/cursor.js` + `.dsh/memory-state/cursor.json`：成功/空计划推进，失败保留并 `attempts + 1`，
未推进的消息下轮重放；窗口下限取分段容量（3 × 24,000 字符），长轮次仍走分段提取。
**状态：✅ done**（`test/cursor.test.mjs` 25 项；E2E 断言游标落盘与边界推进）。

### W5. custom-agent 记忆 — M ✅（v0.3.0）

`lib/agent-memory.js`：`standard` 与 main 会话沿用工作区根，其它 preset / subagent 会话按键隔离到
`agent-memory/<key>/`，规则与索引同构。**状态：✅ done**（`test/agent-memory.test.mjs` 25 项）。

### M5 验收

`node --test` 304/304（22 套件）、`scripts/verify-host-e2e.mjs` 23/23、`check-syntax` 35/35、
Windows + Linux × Node 20/22 四矩阵 CI；契约升到 v2.2（§2.6、§6.12）。

---

## M6 — 受限工具循环提取引擎（v0.4.0，2026-10-31）

> 起因：M5 把 `memory-agent-loop.ts` 记成「硬约束下不可搬」。用户指出 DSH 允许插件注册工具；
> 复核后确认 `ctx.tools.register` 与 `GenerateOptions.tools` 都可用，于是按「不让主会话看见工具」的
> 方案补齐：工具 schema 只随提取请求下发，宿主进程内执行——最接近上游的一版。

### W6. 五轮受限工具循环 — L ✅（v0.4.0）

`lib/memory-agent.js` + `lib/host.js` 双模式：六个进程内工具（`memory_read` / `memory_list` /
`memory_grep` / `memory_write` / `memory_edit` / `memory_delete`）随 `llm.stream({ tools })` 下发，
`collectStreamTurn` 收集文本与 `tool-call`，宿主执行后把 `tool-result` 作为 `{kind:'tool'}` 消息回放，
`agentMaxTurns`（默认 5，钳 1–10）封顶。模型不调工具、直接吐 JSON 时照走一次性解析；循环失败的段落
回落一次性 JSON 提示词。写入依旧全部经 `planExtractionWrites` / `applyExtraction`，模型只产出计划。
**状态：✅ done**（`test/memory-agent.test.mjs` 32 项 + `test/agent-extraction.test.mjs` 7 项；
E2E 新增 4 项：六个工具 schema 下发、tool-result 回放、工具写盘、索引指针更新）。

### M6 验收

`node --test` 343/343（24 套件）、`scripts/verify-host-e2e.mjs` 27/27、`check-syntax` 37/37、
Windows + Linux × Node 20/22 四矩阵 CI；契约升到 v2.3（§3 两个配置、§5.1）。

## 里程碑完成定义（逐级追加）

1. **M1**：并发与部分失败测试绿；forget 可恢复；CI 双平台绿。→ ✅ 达成（v0.2.0）
2. **M2**：README 验收表零挂账；catalog 不再跨工作区泄漏；提取计数可见。→ ✅ 达成（v0.2.0）
3. **M3**：用户可不离开 panel 完成记忆的看、增、删、改、恢复；同会话内新记忆即时生效。→ ✅ 达成（v0.2.0）：C3 落地后「增 / 删 / 改 / 恢复」都在面板内完成（写走宿主加锁 + 守卫），C6 提供同会话即时生效。
4. **M4**：INTERFACES.md v2 发布，注入按相关性排序。→ ✅ 达成（v0.2.0）；D1 的全局层随后按用户要求撤回（契约 v2.1，见 INTERFACES.md §2.5），记忆改为纯工作区隔离。
