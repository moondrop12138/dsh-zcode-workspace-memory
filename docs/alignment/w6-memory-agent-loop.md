# W6 — 五轮受限工具循环（v0.4.0）

上游对应：`apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts` +
`memory/extraction.ts` 的 `buildMemoryExtractionPrompt()`。

## 为什么 0.3.0 没做

0.3.0 的判断是「DSH 不允许插件注册写工具」，所以用一次性 JSON 计划代替整条工具循环。
这个判断是错的：`ctx.tools.register()` 可以注册工具，`GenerateOptions.tools` 也可以按请求
下发 schema。真正的约束只有一条——不能把记忆工具永久挂进主会话可见的工具清单。

## 0.4.0 的做法

不注册全局工具，schema 只随提取请求下发（`ctx.llm.stream({ ..., tools })`），由插件自己执行
这次调用并回放结果。这样主会话的工具清单完全不变，提取请求仍然能拿到一个真正的工具循环。

| 上游 | 本插件 |
|---|---|
| 子代理 + Read/Grep/Glob/只读 Bash/记忆目录 Write/Edit | 进程内六工具：`memory_read` / `memory_list` / `memory_grep` / `memory_write` / `memory_edit` / `memory_delete` |
| 子代理自身的 5 轮预算 | `runMemoryAgent` 的 `maxTurns`（默认 5，钳 1–10） |
| 子代理直接写文件 | 写进 journal，`journalToPlan` → `planExtractionWrites` → `applyExtraction` |
| 无保存时输出 `Nothing to save.` | 同样约定；空计划即 no-op |
| 失败即整轮失败 | 循环失败回落一次性 JSON 提示词，同一轮重跑一次 |

保留的一次性路径：`extractionMode: 'json'` 强制单次请求；agent 模式下模型直接吐 JSON 文本
也照走 `parseExtractionResponse`。

## 消息形状

每个 assistant 回合是一条 `{ role: 'assistant', content: [text?, ...tool-call] }`，
`source: { kind: 'model', provider, model }`；每次工具回放是一条
`{ role: 'user', content: [...tool-result], source: { kind: 'tool', callId } }`。

## 测试

- `test/memory-agent.test.mjs`（32 项）：schema 形状、journal 增删改查、grep 正则退化、
  同批同名覆盖、轮数上限、失败返回、计划映射。
- `test/agent-extraction.test.mjs`（7 项）：真实 `apply()` 下的工具写盘、`memory_delete` 进 trash、
  JSON 文本落地、轮数耗尽回落、`'json'` 模式无 tools、流失败回落。
- `scripts/verify-host-e2e.mjs` 新增 4 项：六个工具 schema 下发、`tool-result` 回放、
  工具写盘、`MEMORY.md` 指针更新。
