# W3 — Dream 整理模块对齐记录

对照实现：`lib/dream.js`，测试 `test/dream.test.mjs`（24 个用例，`node --test test/dream.test.mjs` 全绿）。

## 上游来源与许可

- 上游：ZCode `apps/zcode-cli/packages/core/src/memory/dream.ts`（Apache-2.0）。
- 本仓库副本：`.tmp-upstream/zcode/dream.ts`。
- 文件头已按要求标注：

  ```js
  // Adapted from ZCode apps/zcode-cli/packages/core/src/memory/dream.ts
  // (Apache-2.0). Changes: ...
  ```

- 零运行时依赖：只 import `node:fs/promises`、`node:path` 和 `./memory-core.js`。

## 照搬（行为不变）

| 项 | 说明 |
| --- | --- |
| `DREAM_LOCK_FILE` | `.consolidate-lock`，位于 memory 目录内 |
| `DREAM_LOCK_FRESH_MS` | 1h；锁新鲜且 PID 存活即视为他人持有 |
| 锁夺取流程 | `stat` + `readFile` 取旧 mtime/PID → 新鲜且存活则 `null` → `mkdir` → 写自己的 PID → 读回比对，不等则 `null` → 返回旧 mtime（无锁为 0） |
| `readDreamLastConsolidatedAt` | 读锁文件 mtime；任何 `stat` 失败返回 0 |
| `restoreDreamLockAfterFailure` | `priorMtimeMs === 0` 删除锁；否则写空内容并 `utimes` 恢复 mtime |
| 提示词骨架 | 四阶段（Orient / Gather recent signal / Consolidate / Prune and index）、索引是「index 不是 dump」的约束、`feedback`/`project` 与项目指令文件的对账三分类 |

## 有意改写（与原版不同）

1. **常量前缀**：`evaluateAutoDreamTiming` → `evaluateDreamTiming`，参数改为契约里的四个显式字段（`nowMs` / `lastConsolidatedAtMs` / `lastScanAtMs` / `newSessionCount`），不再由宿主读锁。
2. **新增第 5 个门控**：`AUTO_DREAM_MIN_SESSIONS = 5`。判定顺序为 `minimum-interval` → `scan-throttled` → `not-enough-sessions`，都 skip 时返回 `reason`，不产生任何写入。
3. **CLAUDE.md → AGENTS.md**：对账段落全部改为 AGENTS.md（"AGENTS.md may be stale" 时不改 AGENTS.md，只在自己的记忆里标注）。
4. **工具假设移除**：上游让模型自己 `ls`/`grep`/`Read`/`Write`、grep transcript；现在提示词明确写 "No tools in this run"，并把三块材料内联：
   - `indexText` → Phase 1 的 `### Current index (MEMORY.md)` 代码块；
   - `factBriefs` → Phase 1 的 `### Existing fact files`，每个文件一行 `- name [type]: description` + 用 `conflictExcerpt` 截断（240 字符）的正文摘要；
   - `activityText` → Phase 2 的 `Recent activity` 代码块；`sessionIds` 仍按 `Sessions since the last consolidation (N)` 列出。
5. **输出从工具调用改为 JSON 契约**：提示词末尾固定一段（上限由常量插值，保证与 `parseDreamResponse` 的截断一致）：

   ```
   Return exactly one JSON object and nothing else: {"updates":[{"name":"...","title":"...","type":"user|feedback|project|reference","description":"...","body":"...","why":"...","howToApply":"..."}],"deletes":["<name>"]}. At most 10 updates and 10 deletes. Reuse an existing name to update it. If nothing needs consolidation, return {"updates":[],"deletes":[]}.
   ```

   索引本身不进 JSON：宿主由事实文件重新渲染 MEMORY.md，避免模型手写索引。
6. **删除 `collectDreamTouchedPaths`**：上游用工具调用流记录本次 dream 碰过的 `.md`，用于事后审计；本模块没有工具流，写域由宿主已知，故不移植（依赖的 `resolveContainedMemoryFilePath`、bash 命令解析器本仓库也没有）。
7. **新增 `releaseDreamLock`**：上游只在失败时 `restore`，没有成功路径的显式释放；这里补一个幂等删除（成功跑完后锁文件 mtime 即"上次整理时间"）。

## 导出面

```js
DREAM_LOCK_FILE = '.consolidate-lock'
DREAM_LOCK_FRESH_MS = 60 * 60 * 1000
AUTO_DREAM_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1000
AUTO_DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000
AUTO_DREAM_MIN_SESSIONS = 5
DREAM_MAX_UPDATES = 10
DREAM_MAX_DELETES = 10

evaluateDreamTiming({ nowMs?, lastConsolidatedAtMs?, lastScanAtMs?, newSessionCount? })
  → { decision: 'scan' } | { decision: 'skip', reason: 'minimum-interval' | 'scan-throttled' | 'not-enough-sessions' }

readDreamLastConsolidatedAt(memoryRoot) → Promise<number>          // 0 = 无记录
acquireDreamLock({ memoryRoot, nowMs?, pid? }) → Promise<number|null>  // 0 = 此前无锁
restoreDreamLockAfterFailure({ memoryRoot, priorMtimeMs }) → Promise<void>
releaseDreamLock({ memoryRoot }) → Promise<void>
buildDreamPrompt({ memoryRoot, indexText?, factBriefs?, sessionIds?, activityText? }) → string
parseDreamResponse(text) → { updates, deletes, parsed }
planDreamWrites(plan) → { memories, forget }
```

`parseDreamResponse` 的 `updates` 条目字段与提取管线一致：`{ name, title, type, description, body, why, howToApply }`；`deletes` 为去重后的字符串数组。`parsed: false` 只表示「回复里找不到可解析的 JSON 对象」。

## 复用而不是重写

| 已有导出 | 用途 |
| --- | --- |
| `MEMORY_TYPES` | 校验 `type`，并决定 fact brief 里的 `[type]` 标签 |
| `extractJsonObject` | 容忍外围文字与代码围栏的 JSON 抽取 |
| `conflictExcerpt` | fact brief 正文摘要（先剥 frontmatter 再截断） |

`normalizeExtractedMemory` 在 `lib/memory-core.js` 中是**模块私有**（未 export，且本任务禁止修改该文件），因此 `lib/dream.js` 里用同名规则的本地 `normalizeDreamUpdate` 做校验：type 必须属于 `MEMORY_TYPES`，`title`/`description`/`body` 去空白后非空，`why`/`howToApply` 缺省为 `''`。字段名与它保持一致，`planDreamWrites` 的输出可直接喂给现有提取应用路径。若 Lead 之后决定把 `normalizeExtractedMemory` 导出，这里应改为直接复用，避免两份规则漂移。

## 解析规则细化

- 按 `name` 去重，后出现的覆盖先出现的（与 `parseExtractionResponse` 的 `Map.set` 语义一致，保留首次出现的位置）。
- 先校验、再去重、最后截断到 `DREAM_MAX_UPDATES` / `DREAM_MAX_DELETES`。
- `deletes` 只保留字符串，trim 后非空者，去重后截断。
- 契约要求「name 非空」；实现额外拒绝 `.`、`..` 和含 `/`、`\`、NUL 的名字，防止名字被当成路径逃出 memory 目录。正常 kebab-case 名字不受影响。

## 锁状态机

| 现状 | 结果 |
| --- | --- |
| 无锁 / 读不出 | 创建目录、写本进程 PID、读回确认 → 返回 `0` |
| 锁 < 1h 且 PID 存活 | 放弃，返回 `null`（持有者的 PID 保持原样） |
| 锁 ≥ 1h（PID 存活也算过期） | 夺取，返回旧 mtime |
| 锁 < 1h 但 PID 已死 / PID 不是数字 | 夺取，返回旧 mtime |
| 写入后读回的 PID 不是自己 | 放弃，返回 `null`（并发竞争） |

## 测试覆盖（test/dream.test.mjs）

- 常量值与契约一致；三个门控各自的正/负边界（24h 恰好、10min 恰好、5 个会话恰好），以及门控优先级。
- 锁：无锁夺取并递归建目录、新鲜+存活 PID 拒绝、过期+存活 PID 夺取、新鲜+死 PID 夺取、垃圾 PID 夺取、`restore` 的 0/非 0 两条路径、`release` 幂等。
- 提示词：四个阶段标题、AGENTS.md 存在且 CLAUDE.md 不存在、`200 lines` / `~25KB` / `~150 characters` 三个上限、JSON 契约原文、`indexText`/`activityText`/`factBriefs`/会话列表全部被内联、缺省输入的占位文案、超长正文被摘要。
- 解析：围栏+外围文字、非法 type、空字段、路径型名字、非对象条目全部丢弃、同名去重后者胜、超量截断、不可解析返回 `parsed: false`、空计划为 parsed 空结果。
- `planDreamWrites`：字段映射、`deletes → forget`、缺省/畸形输入降级、`parse → plan` 往返。

全部锁测试用 `mkdtemp` 临时目录，`after` 里统一 `rm -rf`。

## 集成注意（留给 Lead）

1. `package.json` 的 `exports` 目前没有 `./dream` 子路径；宿主集成时按需添加（本任务禁止改 `package.json`）。
2. 宿主需要在调用 `buildDreamPrompt` 前自行准备 `indexText`（`MEMORY.md` 原文）、`factBriefs`（可由 `buildManifest` 结果 + 正文摘要构造）和 `activityText`（会话日志切片）。
3. 建议调用顺序：`evaluateDreamTiming` → `readDreamLastConsolidatedAt` → `acquireDreamLock`（`null` 即退出）→ 模型调用 → `parseDreamResponse` → `planDreamWrites` → 应用写入；成功 `releaseDreamLock`，失败 `restoreDreamLockAfterFailure(priorMtimeMs)`。
