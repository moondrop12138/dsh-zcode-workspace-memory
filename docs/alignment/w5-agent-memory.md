# W5 — agent-scoped memory (`lib/agent-memory.js`)

状态：已实现，待 Lead 集成进 `lib/host.js` / `INTERFACES.md`。

## 1. 这个模块补的是什么

`NOTICE.md` 把「custom-agent memory layering」列为**刻意未移植**的一层：v0.2.0 之前，一个工作区里
所有会话（主会话、子代理、任何自定义预设）共用同一份 `<workspaceRoot>/.dsh/memory/`。W5 把
「按 agent 分层」补回来，但换了一套与 DSH 沙箱相容的落盘方式：

| | 上游 ZCode | 本仓库 W5 |
| --- | --- | --- |
| 存储位置 | CLI 仓库外 store | `<workspaceRoot>/.dsh/agent-memory/<key>/` 与 `<homeDir>/.dsh/agent-memory/<key>/` |
| 目录归属 | agent 配置内部 | 模型用原生 `write`/`edit` 直接维护 |
| 文件格式 | ZCode memory v4 | 与工作区记忆**完全相同**（frontmatter + `MEMORY.md` 指针行） |
| 注入位置 | 独立 section | 工作区记忆 section 之后的 `## Agent memory (<key>)` 段落 |

## 2. 自研说明（不是移植）

`.tmp-upstream/zcode/` 里没有 agent 记忆分层的实现可抄：`recall-types.ts` 只有
`MEMORY_RECALL_TYPES` 这个类型枚举（本仓库已由 `MEMORY_TYPES` 覆盖）和 recall 相关 interface，
没有任何 preset / 作用域解析逻辑。因此 `lib/agent-memory.js` 是**为 DSH 新写**的，文件头不写
`// Adapted from ZCode`；唯一继承的是措辞——`agentMemoryRulesText()` 复用了
`memoryRulesText()`（Apache-2.0，见 `NOTICE.md`）里 frontmatter、指针行、`[[name]]` 的说法，
但压缩成一段短规则，不复制全文。

复用而非重写：`INDEX_FILE`（`MEMORY.md`）、`MEMORY_DIR_SEGMENTS[0]`（`.dsh`）、`MEMORY_TYPES`
都从 `lib/memory-core.js` 导入；索引解析、frontmatter 解析、指针读写一律走 `memory-core.js`
已有导出，本模块**不新增**任何解析器。

## 3. 冻结契约

### 3.1 常量

| 导出 | 值 | 说明 |
| --- | --- | --- |
| `AGENT_MEMORY_SCOPES` | `['local', 'project', 'user']`（frozen） | 三个作用域 |
| `DEFAULT_AGENT_PRESET` | `'standard'` | 默认预设不单独分层 |
| `AGENT_MEMORY_DIR` | `'agent-memory'` | `.dsh` 下的目录名，与 `memory/` 不冲突 |
| `AGENT_MEMORY_INDEX` | `'MEMORY.md'` | 等于 `memory-core` 的 `INDEX_FILE` |

### 3.2 `resolveAgentKey(session) → string | undefined`

`session` 可能是 `{ header }`。判定顺序（**预设优先于 origin**）：

1. `header.agentPreset` 是字符串、`trim()` 后非空、且小写后 `!== 'standard'` → 返回 `trim()` 后的原样 preset（保留大小写，路径构建时再 sanitize）。
2. 否则 `header.origin === 'subagent'` → 返回 `'subagent'`。
3. 否则 → `undefined`。

| 输入 header | 返回 |
| --- | --- |
| `{ agentPreset: 'minimal', origin: 'subagent' }` | `'minimal'` |
| `{ agentPreset: 'cordis', origin: 'user' }` | `'cordis'` |
| `{ agentPreset: 'standard' }` | `undefined` |
| `{ agentPreset: 'Standard', origin: 'subagent' }` | `'subagent'`（大小写不敏感地视作默认） |
| `{ origin: 'subagent' }` / `{ agentPreset: '', origin: 'subagent' }` | `'subagent'` |
| `{ origin: 'user' }` / `{}` / 非对象 / 抛错 getter | `undefined` |

任何异常输入返回 `undefined`，**绝不抛错**（整段包在 `try/catch` 里，覆盖抛错的 getter）。

### 3.3 `sanitizeAgentKey(value) → string`

1. 非字符串按空串处理；小写化。
2. `[a-z0-9._-]` 之外的字符每段替换成一个 `-`，折叠连续 `-`，去掉首尾 `-`。
3. 结果为空 → `'agent-' + sha256(原文本).slice(0, 8)`（确定性；不同的不可用输入不会撞目录）。
4. 长度上限 48，截断后再次去尾 `-`。

例：`'My Agent'→'my-agent'`、`'a---b'→'a-b'`、`'--x--'→'x'`、`'v2.1_beta-rc'` 原样、
`'' / '中文' / '✨'` → `agent-xxxxxxxx`（各自不同）、`'x'.repeat(120)` → 48 个 `x`。

### 3.4 `resolveAgentMemoryRoots({ workspaceRoot, homeDir, agentKey }) → { local, project, user } | undefined`

| 条件 | 结果 |
| --- | --- |
| `agentKey` 非字符串 / `trim()` 后为空 | 返回 `undefined`（整体） |
| 其余 | `local === project === join(workspaceRoot, '.dsh', 'agent-memory', sanitizeAgentKey(agentKey))`；`user === join(homeDir, '.dsh', 'agent-memory', key)` |
| `workspaceRoot` 缺失 | `local` / `project` 为 `undefined`，`user` 照常 |
| `homeDir` 缺失 | `user` 为 `undefined`，`local` / `project` 照常 |

`local` 与 `project` 是同一路径：DSH 没有项目注册表，「本项目」就是「本工作区」。这个决定
让 `project` 作用域不需要新的配置项，也让两层永远落在同一个沙箱可写根下。

### 3.5 `agentMemoryRulesText(root) → string`

一段短规则（无尾部换行），首句说明这是 agent 作用域、别的 agent 读不到；第二句给出
`` `root/` ``（`root` 不是可用字符串时省略路径但句子仍成立）；随后是「与工作区记忆相同的
frontmatter 格式（`name` / `description` / `metadata.type` = user | feedback | project | reference）」、
「写完在 `MEMORY.md` 加一行指针」、「只存跨会话可复用信息，不存密钥/一次性状态/仓库已记录的东西」。

**不是** `memoryRulesText()` 的副本：没有 ```markdown 代码块、没有 `AGENTS.md` 段、没有
「never shared with another one」，长度不到全文的一半（测试里有断言）。

### 3.6 `renderAgentMemoryBlock({ agentKey, indexText, rulesText }) → string`

- `agentKey` 或 `indexText` 为空/空白/非字符串 → `''`（宿主据此整段跳过，不会输出空标题）。
- 否则：

```
## Agent memory (<agentKey>)

<rulesText，若为空则整段省略>

Contents of `MEMORY.md` (agent memory, persists across sessions):

<indexText>
```

- 标题里用传入的 `agentKey` 原样（不 sanitize），因为它只是给人/模型看的标签；目录名才需要 sanitize。
- 输出以 `indexText` 结尾，不追加额外空行。

## 4. 磁盘布局

```
<workspaceRoot>/.dsh/
├── memory/                      # 工作区记忆（不变）
│   ├── MEMORY.md
│   └── <fact>.md
└── agent-memory/                # W5 新增
    ├── minimal/                 # preset id，sanitize 后
    │   ├── MEMORY.md
    │   └── <fact>.md
    ├── cordis/
    └── subagent/                # 无自定义预设的子代理共用

<homeDir>/.dsh/agent-memory/<key>/   # user 作用域，唯一离开工作区的路径
```

`local` / `project` 都在工作区内，因此默认落在 `workspace-write` 沙箱允许的写域里；`user`
作用域在沙箱之外，是否需要由宿主按会话策略决定（见 §5）。

## 5. Lead 集成清单（`lib/host.js` 尚未改动）

1. 注入：会话初始化时 `const key = resolveAgentKey(session)`；`key === undefined` 时行为完全不变。
   否则 `resolveAgentMemoryRoots({ workspaceRoot, homeDir, agentKey: key })`，读
   `local` 根的 `MEMORY.md`（复用 `formatIndexContent` 做行数/字符截断），再
   `renderAgentMemoryBlock({ agentKey: key, indexText, rulesText: agentMemoryRulesText(root) })`
   追加到工作区 section 之后（`MEMORY_SECTION_ORDER` 之后一个位次，或直接拼在同一 section 尾部）。
2. 读取路径：agent 记忆目录不存在 → 视为空索引（不要创建目录，也不要在注入阶段写盘）。
3. 写入路径：提取/修复/导出可复用 `memory-core.js` 与现有 `repairIndex`，只是把 `root` 换成
   agent 根；建议 `local` 作用域默认开启，`user` 作用域需要显式开关（它越过沙箱写域）。
4. 子代理：`key === 'subagent'` 的会话建议沿用 C7 的只读策略——可读索引，不写。
5. `minimal` 预设：`host.js` 现有的 `isMinimalSession()` 优先级更高，minimal 会话仍然整段跳过
   记忆（不读不写），W5 不改变这一点。
6. 面板/RPC：W5 不含 UI，`catalog` 等端点目前只覆盖工作区记忆；如需展示 agent 记忆，另开任务。

## 6. 测试

`test/agent-memory.test.mjs`，25 个用例，`node --test test/agent-memory.test.mjs` 全绿：

- 常量（frozen、值、`AGENT_MEMORY_INDEX === 'MEMORY.md'`）。
- `resolveAgentKey`：preset 压过 subagent、`standard` 与非 subagent 返回 `undefined`、
  大小写/空白、非对象/非字符串 preset/抛错 getter 不抛错。
- `sanitizeAgentKey`：大小写、非法字符折叠、首尾 `-`、空值与 CJK/emoji 的 sha256 回退、
  确定性、48 长度上限与截断后不留尾 `-`。
- `resolveAgentMemoryRoots`：三段路径正确、`user` 指向 `homeDir`、`local !== user` 前缀、
  key 经 sanitize、空 key 返回 `undefined`、缺 base 时只影响对应作用域、不修改入参。
- `agentMemoryRulesText`：含 root 路径、含 `MEMORY_TYPES` 全部取值、明显短于 `memoryRulesText`
  且不含其代码块/`AGENTS.md` 段、无 root 时不出现 `undefined`/`null`。
- `renderAgentMemoryBlock`：空输入（含空白、缺字段、非字符串）返回 `''`；正常输入以
  `## Agent memory (<key>)` 开头、包含规则与索引、以索引结尾；无 rulesText 仍成段。
- 端到端形状：`resolveAgentKey → resolveAgentMemoryRoots → agentMemoryRulesText → renderAgentMemoryBlock`。

已知全量 `node --test` 现状（2026-10-30，21 个 `*.test.mjs`）：304 项，303 通过，唯一失败是
`test/ci.test.mjs:96` 把套件数硬编码成 17（`expected 17 test suites, found: ...`），以及
README 里的 `188/188` 计数。那是 W5/W* 新增套件后的计数漂移，**不是本模块的缺陷**；
`ci.test.mjs`、`README.md` 不在 W5 写域内，需 Lead 集成时把计数改成实际值。

## 7. 非目标

- 不做 agent 记忆之间的共享/继承（`[[name]]` 链接只在同一目录内有效）。
- 不做跨工作区的 `user` 记忆合并。
- 不做 UI、不做导出/导入、不改 `package.json` 的 `exports`（Lead 需要时再加 `./agent-memory`）。
- 不引入任何 npm 依赖，保持 ESM + `node:test`。
