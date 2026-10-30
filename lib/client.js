/**
 * Client half of `dsh-workspace-memory`.
 *
 * Adds a read-only view of this profile's workspace memory to the DSH Web UI:
 *
 *   1. a left-sidebar panel row (`sidebar.panellist`, id `workspace-memory`,
 *      order 30) with an original inline glyph;
 *   2. the keyed `main` page that row selects — every workspace that has a
 *      `.dsh/memory/` directory, its files (`MEMORY.md` index pinned first,
 *      then one fact per file), the raw Markdown of the selected file, and the
 *      read-only `enabled` / `autoExtract` state of the Host half.
 *
 * Contract: `INTERFACES.md` §6 (RPC) and §7 (seats). Plain browser JavaScript
 * only: React comes from the module table, no Harness Client package is
 * imported, no JSX (this file is plain `.js`), and every visible string goes
 * through the locale namespace `workspace-memory`.
 *
 * The page never writes anything: switches live in the plugin's Host `Config`
 * (the standard plugin settings form), and memory content is written by the
 * model or by Host extraction.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PKG = 'dsh-workspace-memory'
    const NS = 'workspace-memory'
    const PANEL_ID = 'workspace-memory'
    const PANEL_ORDER = 30
    const RPC_BASE = '/api'
    const RPC_ENDPOINT = PKG + '/call'
    /** Longest diagnostic string the UI shows: one error line, never a flood. */
    const DETAIL_MAX = 240
    /** Defensive client-side render cap for one file body (chars). */
    const CONTENT_RENDER_MAX = 1000000
    /** Memory types the panel can filter by (mirrors memory-core MEMORY_TYPES). */
    const MEMORY_TYPE_KEYS = ['user', 'feedback', 'project', 'reference']
    /** Longest fact name the editor accepts (mirrors the host validation). */
    const FACT_NAME_MAX = 48
    /** Longest pointer hook the editor accepts (mirrors the host validation). */
    const FACT_DESCRIPTION_MAX = 300
    /** Fact names are one kebab-case slug: lowercase words joined by hyphens. */
    const FACT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    /** Fixed pixel height of one virtualized file row (roadmap C4). */
    const FILE_ROW_HEIGHT = 58
    /** Above this item count the file list virtualizes; below it renders plain. */
    const VIRTUAL_LIST_MIN = 60
    /** Height of the scroll viewport the virtualized list measures against. */
    const FILE_VIEWPORT_HEIGHT = 480

    /* ---------------------------------------------------------------- locale */

    const zh = {
      'panel': '工作区记忆',
      'title': '工作区记忆',
      'subtitle': '每个工作区一份持久 Markdown 记忆：MEMORY.md 索引 + 一事实一文件；主会话开始时注入，每轮成功对话后后台自动提取。',
      'config.label': '开关状态',
      'config.enabledOn': '记忆：已启用',
      'config.enabledOff': '记忆：已关闭',
      'config.autoExtractOn': '自动提取：已开启',
      'config.autoExtractOff': '自动提取：已关闭',
      'config.hint': '这些开关在「插件设置 → 工作区记忆」里修改；事实可以在这里直接新建、编辑和删除。',
      'config.skipTurnOn': '本轮不提取：已开启',
      'config.skipTurnOff': '本轮不提取',
      'config.costHint': '自动提取会在每轮成功对话后发起额外模型请求，增加 token 用量与成本。',
      'catalog.extractCount': '今日提取 {n} 次',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中…',
      'action.retry': '重试',
      'action.reload': '重新读取',
      'catalog.workspaces': '有记忆的工作区',
      'catalog.workspaceCount': '共 {n} 个工作区',
      'catalog.files': '记忆文件',
      'catalog.fileCount': '{n} 个文件',
      'catalog.index': '索引',
      'catalog.fact': '事实',
      'catalog.typeAll': '全部',
      'catalog.type.user': '用户',
      'catalog.type.feedback': '反馈',
      'catalog.type.project': '项目',
      'catalog.type.reference': '参考',
      'catalog.searchPlaceholder': '搜索文件名或类型…',
      'catalog.filterEmpty': '没有符合筛选条件的文件',
      'catalog.memoryRoot': '记忆目录：{path}',
      'catalog.filePath': '文件：{path}',
      'activity.title': '最近提取活动',
      'activity.empty': '还没有提取活动',
      'activity.remembered': '记住了 {n} 条',
      'activity.forgot': '忘了 {n} 条',
      'activity.noDiff': '这条记录没有保存索引前后文本',
      'activity.diffSame': '索引内容没有变化',
      'state.loading': '正在读取工作区记忆…',
      'state.empty': '还没有任何工作区留下记忆',
      'state.emptyHint': '在某个工作区里对话并说「记住…」，或等一轮成功对话后的自动提取，这里就会出现内容。',
      'state.noWorkspace': '从左侧选择一个工作区',
      'state.noFile': '选择一个文件查看原文',
      'state.fileLoading': '正在读取文件…',
      'state.truncated': '文件过大，只显示末尾部分（上限 {limit}）',
      'state.updatedAt': '更新于 {time}',
      'state.createdAt': '创建于 {time}',
      'state.lastAccessedAt': '最近读取 {time}',
      'error.title': '无法读取工作区记忆',
      'error.host': '宿主 RPC 尚不可用：插件宿主半可能还没有加载完成，稍后重试。',
      'error.line': '读取失败：{message}',
      'error.code': '错误代码：{code}',
      'error.render': '页面渲染失败',
      'time.unknown': '未知时间',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'fact.new': '新建事实',
      'fact.newTitle': '新建事实',
      'fact.editTitle': '编辑 {name}',
      'fact.edit': '编辑',
      'fact.delete': '删除',
      'fact.save': '保存',
      'fact.saving': '保存中…',
      'fact.cancel': '取消',
      'fact.restore': '恢复',
      'fact.restoring': '恢复中…',
      'fact.name': '文件名（kebab-case）',
      'fact.nameHint': '1-48 个字符：小写字母、数字和连字符，例如 prefers-tabs。',
      'fact.type': '类型',
      'fact.description': '摘要（写进 MEMORY.md 索引的一行）',
      'fact.body': '内容',
      'fact.deleteConfirm': '删除后可在回收站恢复。',
      'fact.deleteYes': '确认删除',
      'fact.deleteNo': '先不删',
      'fact.trashOpen': '回收站',
      'fact.trashClose': '返回文件',
      'fact.trashTitle': '回收站（可恢复）',
      'fact.trashHint': '删除的事实先放进这里，最多保留 {n} 条。',
      'fact.trashEmpty': '回收站是空的',
      'fact.restoreFailed': '恢复失败：{message}',
      'fact.errorName': '名字不合法：1-48 个字符，只能用小写字母、数字和连字符，且不能叫 memory。',
      'fact.errorType': '请选择类型。',
      'fact.errorDescription': '摘要不能为空。',
      'fact.errorDescriptionLong': '摘要最多 {n} 个字符。',
      'fact.errorBody': '内容不能为空。',
      'value.none': '—',
    }

    const en = {
      'panel': 'Workspace Memory',
      'title': 'Workspace Memory',
      'subtitle': 'One persistent Markdown memory per workspace (a MEMORY.md index plus one fact per file): injected at the start of every main session and refreshed by background extraction after each successful turn.',
      'config.label': 'Switches',
      'config.enabledOn': 'Memory: on',
      'config.enabledOff': 'Memory: off',
      'config.autoExtractOn': 'Auto-extract: on',
      'config.autoExtractOff': 'Auto-extract: off',
      'config.hint': 'Change these in Plugin settings → Workspace Memory; facts can be created, edited and deleted right here.',
      'config.skipTurnOn': 'No extraction this session: on',
      'config.skipTurnOff': 'No extraction this session',
      'config.costHint': 'Auto-extract issues an extra model request after every successful turn, which adds token usage and cost.',
      'catalog.extractCount': '{n} extraction(s) today',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.retry': 'Retry',
      'action.reload': 'Reload',
      'catalog.workspaces': 'Workspaces with memory',
      'catalog.workspaceCount': '{n} workspace(s)',
      'catalog.files': 'Memory files',
      'catalog.fileCount': '{n} file(s)',
      'catalog.index': 'index',
      'catalog.fact': 'fact',
      'catalog.typeAll': 'All',
      'catalog.type.user': 'user',
      'catalog.type.feedback': 'feedback',
      'catalog.type.project': 'project',
      'catalog.type.reference': 'reference',
      'catalog.searchPlaceholder': 'Search names or types…',
      'catalog.filterEmpty': 'No file matches the current filter',
      'catalog.memoryRoot': 'Memory directory: {path}',
      'catalog.filePath': 'File: {path}',
      'activity.title': 'Recent extraction activity',
      'activity.empty': 'No extraction activity yet',
      'activity.remembered': 'Remembered {n}',
      'activity.forgot': 'Forgot {n}',
      'activity.noDiff': 'This entry has no before/after index text',
      'activity.diffSame': 'Index content unchanged',
      'state.loading': 'Reading workspace memory…',
      'state.empty': 'No workspace has any memory yet',
      'state.emptyHint': 'Talk in a workspace and say "remember …", or wait for the automatic extraction after a successful turn; content shows up here.',
      'state.noWorkspace': 'Pick a workspace on the left',
      'state.noFile': 'Pick a file to read its content',
      'state.fileLoading': 'Reading file…',
      'state.truncated': 'File too large; only the tail is shown (limit {limit})',
      'state.updatedAt': 'Updated {time}',
      'state.createdAt': 'Created {time}',
      'state.lastAccessedAt': 'Last read {time}',
      'error.title': 'Cannot read workspace memory',
      'error.host': 'The host RPC is not available yet: the plugin host half may still be loading. Try again shortly.',
      'error.line': 'Request failed: {message}',
      'error.code': 'Error code: {code}',
      'error.render': 'The page failed to render',
      'time.unknown': 'unknown time',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} h ago',
      'time.daysAgo': '{n} d ago',
      'fact.new': 'New fact',
      'fact.newTitle': 'New fact',
      'fact.editTitle': 'Edit {name}',
      'fact.edit': 'Edit',
      'fact.delete': 'Delete',
      'fact.save': 'Save',
      'fact.saving': 'Saving…',
      'fact.cancel': 'Cancel',
      'fact.restore': 'Restore',
      'fact.restoring': 'Restoring…',
      'fact.name': 'Name (kebab-case)',
      'fact.nameHint': '1-48 characters: lowercase letters, digits and hyphens, e.g. prefers-tabs.',
      'fact.type': 'Type',
      'fact.description': 'Description (the one MEMORY.md pointer line)',
      'fact.body': 'Body',
      'fact.deleteConfirm': 'Deleted facts go to the trash and can be restored.',
      'fact.deleteYes': 'Delete it',
      'fact.deleteNo': 'Keep it',
      'fact.trashOpen': 'Trash',
      'fact.trashClose': 'Back to files',
      'fact.trashTitle': 'Trash (restorable)',
      'fact.trashHint': 'Deleted facts land here; the newest {n} are kept.',
      'fact.trashEmpty': 'The trash is empty',
      'fact.restoreFailed': 'Restore failed: {message}',
      'fact.errorName': 'Invalid name: 1-48 characters of lowercase letters, digits and hyphens, and not "memory".',
      'fact.errorType': 'Pick a type.',
      'fact.errorDescription': 'Description is required.',
      'fact.errorDescriptionLong': 'Description is at most {n} characters.',
      'fact.errorBody': 'Body is required.',
      'value.none': '—',
    }

    /* ------------------------------------------------------------ primitives */

    function isObject(value) {
      return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    /** A string, or '' for anything else. */
    function str(value) {
      return typeof value === 'string' ? value : ''
    }

    /** Non-negative finite number, else 0. */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    /** Trim and cap a diagnostic string; non-strings become ''. */
    function truncate(text) {
      if (typeof text !== 'string') return ''
      const trimmed = text.trim()
      return trimmed.length > DETAIL_MAX ? trimmed.slice(0, DETAIL_MAX - 1) + '…' : trimmed
    }

    /** First non-empty readable string among the candidates. */
    function firstText(candidates) {
      for (const candidate of candidates) {
        const text = truncate(candidate)
        if (text !== '') return text
      }
      return ''
    }

    /**
     * Readable text for any failure value: strings pass through, Error-like
     * objects keep `name` + `message`, other objects become truncated JSON
     * (never `[object Object]`).
     */
    function describeError(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return truncate(value)
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (typeof value !== 'object') return ''
      const name = typeof value.name === 'string' ? value.name : ''
      const message = typeof value.message === 'string' ? value.message : ''
      if (message !== '') {
        return truncate(name !== '' && name !== 'Error' ? name + ': ' + message : message)
      }
      try {
        const text = JSON.stringify(value)
        return text === undefined ? '' : truncate(text)
      } catch (_ignored) {
        return ''
      }
    }

    /** Defensive translator: never throws, never returns an empty string. */
    function makeT(t) {
      if (typeof t !== 'function') return (key) => key
      return (key, vars) => {
        try {
          const value = vars === undefined ? t(key) : t(key, vars)
          return typeof value === 'string' && value !== '' ? value : key
        } catch (_ignored) {
          return key
        }
      }
    }

    /** Compact byte size (`0 B`, `812 B`, `1.2 KB`, `3.4 MB`). */
    function formatBytes(value) {
      const bytes = num(value)
      if (bytes < 1024) return String(Math.round(bytes)) + ' B'
      const units = ['KB', 'MB', 'GB']
      let scaled = bytes / 1024
      let index = 0
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      const digits = scaled < 10 ? 1 : 0
      return scaled.toFixed(digits).replace(/\.0$/, '') + ' ' + units[index]
    }

    /** Relative time for an epoch-ms value; never throws, never empty. */
    function formatRelative(value, t) {
      const at = num(value)
      if (at === 0) return t('time.unknown')
      const delta = Date.now() - at
      if (!Number.isFinite(delta) || delta < 0) return t('time.justNow')
      if (delta < 60 * 1000) return t('time.justNow')
      const minutes = Math.floor(delta / (60 * 1000))
      if (minutes < 60) return t('time.minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 3650) return t('time.daysAgo', { n: days })
      return t('time.unknown')
    }

    /* -------------------------------------------------- fact draft & payloads */

    /** The `fact-save` payload for one editor draft (pure; no request made). */
    function factSavePayload(workspacePath, draft) {
      const source = isObject(draft) ? draft : {}
      return {
        path: str(workspacePath),
        name: str(source.name).trim(),
        type: str(source.type),
        description: str(source.description).trim(),
        body: str(source.body).trim(),
      }
    }

    /** The `fact-read` payload for one file of the selected workspace. */
    function factReadPayload(workspacePath, fileName) {
      return { path: str(workspacePath), name: str(fileName) }
    }

    /** The `fact-delete` payload for one file of the selected workspace. */
    function factDeletePayload(workspacePath, fileName) {
      return { path: str(workspacePath), name: str(fileName) }
    }

    /** The `trash-restore` payload for one trashed entry. */
    function trashRestorePayload(workspacePath, name) {
      return { path: str(workspacePath), name: str(name) }
    }

    /** `prefers-tabs` -> `prefers-tabs.md`, leaving an existing suffix alone. */
    function factFileNameOf(name) {
      const text = str(name).trim()
      if (text === '') return ''
      return text.endsWith('.md') ? text : text + '.md'
    }

    /** `prefers-tabs.md` -> `prefers-tabs`: the name the host validates. */
    function bareFactName(name) {
      const text = str(name).trim()
      return text.endsWith('.md') ? text.slice(0, -3) : text
    }

    /** An empty create draft: name editable, user type, empty fields. */
    function blankFactDraft() {
      return { name: '', fileName: '', type: 'user', description: '', body: '', creating: true, createdAt: '' }
    }

    /** Editor draft from one `fact-read` value (or one catalog fact row). */
    function draftFromFact(value) {
      const fact = isObject(value) ? value : {}
      const name = bareFactName(fact.name)
      const type = str(fact.type)
      return {
        name,
        fileName: str(fact.fileName) !== '' ? str(fact.fileName) : factFileNameOf(name),
        type: MEMORY_TYPE_KEYS.indexOf(type) >= 0 ? type : 'user',
        description: str(fact.description),
        body: str(fact.body),
        creating: false,
        createdAt: str(fact.createdAt),
      }
    }

    /**
     * Client-side mirror of the host's `fact-save` validation: the first problem
     * as a readable line, or `null` when the draft can be sent.
     */
    function validateFactDraft(draft, t) {
      const source = isObject(draft) ? draft : {}
      const name = str(source.name).trim()
      if (
        name.length === 0
        || name.length > FACT_NAME_MAX
        || !FACT_NAME_PATTERN.test(name)
        || name.toLowerCase() === 'memory'
      ) {
        return t('fact.errorName')
      }
      if (MEMORY_TYPE_KEYS.indexOf(str(source.type)) < 0) return t('fact.errorType')
      const description = str(source.description).trim()
      if (description.length === 0) return t('fact.errorDescription')
      if (description.length > FACT_DESCRIPTION_MAX) {
        return t('fact.errorDescriptionLong', { n: FACT_DESCRIPTION_MAX })
      }
      if (str(source.body).trim().length === 0) return t('fact.errorBody')
      return null
    }

    /** Whether one catalog row is an editable fact file (the index is not). */
    function isFactFile(file) {
      return isObject(file) && file.kind === 'fact' && str(file.name) !== ''
    }

    /* ------------------------------------------------------------------- rpc */

    /**
     * Normalize one `connection.rpc.call` outcome into `{ ok:true, value }` /
     * `{ ok:false, error:{code,message,details} }`.
     *
     * The framework rewrites the Host envelope before we see it
     * (`@deepseek-ai/dsh-client-connection` `parseConnectionResponse`): success
     * becomes `{ ok:true, value }` — a Host `data` field is dropped — and
     * failure becomes `{ ok:false, error:{ code, message, details:object } }`.
     * `data` stays accepted for forward/backward compatibility.
     */
    function normalizeResult(result) {
      if (result === null || result === undefined) {
        return { ok: false, error: { code: 'empty-response', message: '', details: {} } }
      }
      if (typeof result !== 'object') {
        return { ok: false, error: { code: 'bad-response', message: describeError(result), details: {} } }
      }
      if (result.ok === true) {
        const payload = isObject(result.value) ? result.value : result.data
        if (!isObject(payload)) {
          return { ok: false, error: { code: 'bad-response', message: 'missing data', details: {} } }
        }
        return { ok: true, value: payload }
      }
      if (result.ok === undefined) {
        // Pre-rewrite Host shape or a bare value: accept object payloads only.
        if (isObject(result.value)) return { ok: true, value: result.value }
        if (isObject(result.data)) return { ok: true, value: result.data }
        if (isObject(result.catalog) || isObject(result.config) || isObject(result.workspaces)
          || isObject(result.content)) {
          return { ok: true, value: result }
        }
      }
      const raw = isObject(result.error) ? result.error : {}
      const code = str(raw.code) !== '' ? str(raw.code) : 'error'
      const message = firstText([
        raw.message,
        isObject(raw.details) ? raw.details.message : undefined,
        describeError(raw.details),
        describeError(result.error),
      ])
      return {
        ok: false,
        error: {
          code,
          message,
          details: isObject(raw.details) ? raw.details : {},
        },
      }
    }

    /**
     * Backoff waits between RPC attempts when the transport itself throws
     * (route not registered yet, dropped connection). Three attempts total;
     * a structured `ok:false` result is a domain answer and is never retried.
     */
    const RPC_RETRY_BACKOFF_MS = [250, 500]

    function delay(ms) {
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    }

    /**
     * Call one endpoint of the Host half over its shared `/api` Fetch route.
     * Never throws: an inactive host half becomes an `ok:false` outcome so the
     * page can render an error state instead of empty content.
     */
    async function callHost(root, endpoint, payload) {
      const connection = root !== null && root !== undefined && typeof root.get === 'function'
        ? root.get('connection')
        : undefined
      const rpc = connection && connection.rpc
      if (!rpc || typeof rpc.call !== 'function') {
        return { ok: false, error: { code: 'host-unavailable', message: 'connection.rpc', details: {} } }
      }
      let lastFailure
      for (let attempt = 0; attempt <= RPC_RETRY_BACKOFF_MS.length; attempt += 1) {
        if (attempt > 0) await delay(RPC_RETRY_BACKOFF_MS[attempt - 1])
        try {
          const result = await rpc.call(RPC_BASE, RPC_ENDPOINT, { endpoint, payload })
          return normalizeResult(result)
        } catch (failure) {
          lastFailure = failure
        }
      }
      return { ok: false, error: { code: 'rpc-failed', message: describeError(lastFailure), details: {} } }
    }

    /* ------------------------------------------------------------ data shape */

    /** `MEMORY.md` first, then facts by name; never throws. */
    function sortFiles(files) {
      const list = asArray(files).map((file) => {
        const name = str(file && file.name)
        const kind = file && file.kind === 'index' ? 'index' : 'fact'
        return {
          name,
          kind,
          type: file && typeof file.type === 'string' && MEMORY_TYPE_KEYS.includes(file.type)
            ? file.type
            : undefined,
          size: num(file && file.size),
          updatedAt: num(file && file.updatedAt),
          createdAt: num(file && file.createdAt),
          lastAccessedAt: num(file && file.lastAccessedAt),
        }
      }).filter((file) => file.name !== '')
      list.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'index' ? -1 : 1
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      return list
    }

    /** Filter files by memory type and a name/keyword query (roadmap C4). */
    function filterFiles(files, filterType, keyword) {
      const type = typeof filterType === 'string' && MEMORY_TYPE_KEYS.includes(filterType)
        ? filterType
        : 'all'
      const text = typeof keyword === 'string' ? keyword.trim().toLowerCase() : ''
      return asArray(files).filter((file) => {
        if (!isObject(file) || str(file.name) === '') return false
        if (type !== 'all' && file.type !== type) return false
        if (text === '') return true
        // The index matches by name only; facts match name and memory type.
        if (file.kind === 'index') return str(file.name).toLowerCase().includes(text)
        const haystacks = [str(file.name), file.type === 'user' || file.type === 'feedback'
          || file.type === 'project' || file.type === 'reference' ? file.type : '']
        return haystacks.some((hay) => hay.toLowerCase().includes(text))
      })
    }

    /**
     * Window the filtered list down to the rows the viewport shows (roadmap C4):
     * all items stay rendered as slim placeholder rows, only the visible
     * window carries the full row content. Zero-dependency virtualization.
     * @returns {{ start: number, stop: number, padTop: number, padBottom: number }}
     */
    function windowFiles(total, scrollTop, viewportHeight, rowHeight) {
      const count = Math.max(0, Math.floor(num(total)))
      const height = Math.max(1, Math.floor(num(viewportHeight)))
      const row = Math.max(1, Math.floor(num(rowHeight)))
      const top = Math.max(0, Math.floor(num(scrollTop)))
      const overscan = Math.max(0, Math.ceil(height / row / 2))
      const start = Math.min(count, Math.max(0, Math.floor(top / row) - overscan))
      const visible = Math.ceil(height / row) + overscan * 2
      const stop = Math.min(count, start + visible)
      return {
        start,
        stop,
        padTop: start * row,
        padBottom: Math.max(0, (count - stop) * row),
      }
    }

    /** Normalize one Catalog workspace; returns null for unusable entries. */
    function normalizeWorkspace(entry) {
      if (!isObject(entry)) return null
      const path = str(entry.path)
      if (path === '') return null
      const files = sortFiles(entry.files)
      if (files.length === 0) return null
      const title = str(entry.title) !== '' ? str(entry.title) : path
      return {
        path,
        title,
        memoryRoot: str(entry.memoryRoot),
        files,
        todayCount: num(entry.todayCount),
        lastAt: num(entry.lastAt),
      }
    }

    /** Defensive Catalog normalization: never throws, always an object. */
    function normalizeCatalog(value) {
      const config = isObject(value && value.config) ? value.config : {}
      const session = isObject(value && value.session) ? value.session : null
      const workspaces = asArray(value && value.workspaces)
        .map(normalizeWorkspace)
        .filter((entry) => entry !== null)
      workspaces.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return {
        config: {
          enabled: config.enabled !== false,
          autoExtract: config.autoExtract !== false,
        },
        session: session !== null
          ? {
            sessionId: str(session.sessionId),
            skipTurnExtraction: session.skipTurnExtraction === true,
          }
          : null,
        workspaces,
      }
    }

    /** Normalize one `read` value; never throws. */
    function normalizeFileValue(value, requestedPath, requestedName) {
      const content = str(value && value.content)
      return {
        path: str(value && value.path) !== '' ? str(value.path) : requestedPath + '/.dsh/memory/' + requestedName,
        name: requestedName,
        content: content.length > CONTENT_RENDER_MAX ? content.slice(content.length - CONTENT_RENDER_MAX) : content,
        truncated: (value && value.truncated === true) || content.length > CONTENT_RENDER_MAX,
      }
    }

    /**
     * Normalize one `activities` value; never throws. Entries are kept as the
     * host wrote them — wrote/forgot stay arrays of file names, and the raw
     * before/after index texts ride along for the click-to-expand diff.
     */
    function normalizeActivities(value) {
      const raw = value && Array.isArray(value.activities) ? value.activities : []
      const activities = []
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        activities.push({
          at: num(entry.at),
          workspace: str(entry.workspace),
          wrote: asArray(entry.wrote).map((name) => str(name)).filter((name) => name.length > 0),
          forgot: asArray(entry.forgot).map((name) => str(name)).filter((name) => name.length > 0),
          diffSummary: str(entry.diffSummary),
          indexBefore: str(entry.indexBefore),
          indexAfter: str(entry.indexAfter),
        })
      }
      activities.sort((a, b) => b.at - a.at)
      return activities
    }

    /**
     * Line-level diff via longest common subsequence, computed cell by cell —
     * plain-text only, no dependency. Returns the runs so the panel can render
     * removed lines first, then added ones, per hunk.
     */
    function diffLines(before, after) {
      const left = typeof before === 'string' ? before.split('\n') : []
      const right = typeof after === 'string' ? after.split('\n') : []
      const rows = left.length
      const cols = right.length
      // lcs[i][j] = LCS length of left.slice(i) vs right.slice(j); dropping
      // trailing equals via split'' artifacts is not needed — '' lines compare
      // naturally and an empty index is just one '' line.
      const lcs = []
      for (let i = 0; i <= rows; i += 1) lcs.push(new Array(cols + 1).fill(0))
      for (let i = rows - 1; i >= 0; i -= 1) {
        for (let j = cols - 1; j >= 0; j -= 1) {
          lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
      }
      const hunks = []
      let hunk = null
      const open = () => {
        if (hunk === null) {
          hunk = { removed: [], added: [] }
          hunks.push(hunk)
        }
      }
      const close = () => {
        hunk = null
      }
      let i = 0
      let j = 0
      while (i < rows && j < cols) {
        if (left[i] === right[j]) {
          close()
          i += 1
          j += 1
        } else {
          open()
          // Consume the whole non-matching run in one hunk: removals first,
          // then additions, so the walk cannot split an edit into fragments.
          while (i < rows && j < cols && left[i] !== right[j] && lcs[i + 1][j] >= lcs[i][j + 1]) {
            hunk.removed.push(left[i])
            i += 1
          }
          while (i < rows && j < cols && left[i] !== right[j]) {
            hunk.added.push(right[j])
            j += 1
          }
          if (i < rows && j >= cols) {
            while (i < rows) {
              hunk.removed.push(left[i])
              i += 1
            }
          }
        }
      }
      while (i < rows) {
        open()
        hunk.removed.push(left[i])
        i += 1
      }
      while (j < cols) {
        open()
        hunk.added.push(right[j])
        j += 1
      }
      return hunks
    }

    /* ------------------------------------------------------------ style sheet */

    const CSS = [
      // Colors come only from the live theme tokens listed in INTERFACES.md §7.
      '.dwm-page{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;height:100%;min-height:0;overflow-y:auto;padding:20px 24px 28px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;}',
      '.dwm-page *{box-sizing:border-box;}',
      '.dwm-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;}',
      '.dwm-headtext{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.dwm-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em;}',
      '.dwm-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:72ch;}',
      '.dwm-headtools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dwm-btn{display:inline-flex;align-items:center;gap:6px;appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;padding:4px 12px;cursor:pointer;}',
      '.dwm-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dwm-btn:disabled{opacity:.55;cursor:default;}',
      '.dwm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dwm-config{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.dwm-chips{display:inline-flex;flex-wrap:wrap;gap:6px;}',
      '.dwm-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;white-space:nowrap;}',
      '.dwm-chip.is-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dwm-chip.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dwm-chip.is-off{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-state-idle-primary);}',
      '.dwm-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dwm-cols{display:grid;grid-template-columns:minmax(220px,min-content) 1fr;gap:12px;align-items:start;min-height:0;}',
      '.dwm-col{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.dwm-col-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.dwm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',
      '.dwm-item{display:flex;flex-direction:column;gap:2px;width:100%;appearance:none;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;padding:7px 10px;cursor:pointer;}',
      '.dwm-item:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dwm-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dwm-item.is-active{border-left-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dwm-item-name{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.dwm-item-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dwm-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dwm-badge{flex:none;padding:1px 6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.6;}',
      '.dwm-badge.is-index{color:var(--dsw-alias-brand-primary);}',
      '.dwm-filefilter{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
      '.dwm-type-chip{appearance:none;font:inherit;font-size:11px;cursor:pointer;}',
      '.dwm-type-chip:hover{background:var(--dsw-alias-bg-overlay);}',
      '.dwm-type-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dwm-type-badge{color:var(--dsw-alias-brand-primary);}',
      '.dwm-filesearch{flex:1 1 140px;min-width:120px;appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;padding:4px 10px;}',
      '.dwm-filesearch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dwm-list-pad{list-style:none;}',
      '.dwm-list-virtual{max-height:56vh;overflow-y:auto;overscroll-behavior:contain;}',
      '.dwm-panel{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);padding:10px 12px;}',
      '.dwm-path{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dwm-pre{margin:0;max-height:56vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;}',
      '.dwm-state{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:22px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.dwm-state-title{margin:0;font-size:13px;font-weight:600;}',
      '.dwm-state-text{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:72ch;}',
      '.dwm-state.is-error{border-style:solid;border-color:var(--dsw-alias-state-error-primary);}',
      '.dwm-state.is-error .dwm-state-title{color:var(--dsw-alias-state-error-primary);}',
      '.dwm-errorline{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-state-error-primary);}',
      '.dwm-activities{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.dwm-activity{display:flex;flex-direction:column;gap:4px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;padding:7px 10px;cursor:pointer;text-align:left;}',
      '.dwm-activity:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dwm-activity:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dwm-activity.is-open{background:var(--dsw-alias-bg-layer-2);}',
      '.dwm-activity-line{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;}',
      '.dwm-activity-count{color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dwm-activity-count.is-added{color:var(--dsw-alias-state-success-primary);}',
      '.dwm-activity-count.is-removed{color:var(--dsw-alias-state-warn-primary);}',
      '.dwm-activity-summary{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dwm-activity-diff{display:flex;flex-direction:column;gap:6px;min-width:0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;}',
      '.dwm-diffline{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:11px;line-height:1.55;padding:1px 6px;border-radius:4px;}',
      '.dwm-diffline.is-removed{background:var(--dsw-alias-state-error-muted);color:var(--dsw-alias-label-primary);}',
      '.dwm-diffline.is-added{background:var(--dsw-alias-state-success-muted);color:var(--dsw-alias-label-primary);}',
      '.dwm-activity-note{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dwm-icon{display:block;}',
      '.dwm-icon[data-active="false"]{opacity:.78;}',
      '.dwm-icon[data-active="true"]{opacity:1;}',
      '.dwm-colhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.dwm-btn.is-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dwm-btn.is-danger:hover{background:var(--dsw-alias-state-error-muted);}',
      '.dwm-btn.is-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dwm-btn.is-on{background:var(--dsw-alias-bg-layer-2);}',
      '.dwm-filepane{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.dwm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.dwm-confirm{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 10px;}',
      '.dwm-editor{display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.dwm-editor-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.dwm-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.dwm-field-label{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dwm-input{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:6px 8px;}',
      '.dwm-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dwm-input[readonly]{color:var(--dsw-alias-label-secondary);}',
      '.dwm-textarea{min-height:140px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}',
      '.dwm-fielderror{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary);}',
      '.dwm-trash{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.dwm-trash-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:6px 10px;}',
      '.dwm-trash-row .dwm-btn{margin-left:auto;}',
      '@media (max-width:719px){',
      '.dwm-page{padding:16px 14px 24px;}',
      '.dwm-cols{grid-template-columns:1fr;}',
      '.dwm-pre{max-height:none;}',
      '}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const tagId = PKG + '/styles'
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
      try {
        if (document.querySelector(selector) !== null) return () => {}
      } catch (_ignored) { /* no document.head yet */ }
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        try { tag.remove() } catch (_ignored) { /* already gone */ }
      }
    }

    /* ------------------------------------------------------------------ icon */

    /**
     * Sidebar glyph: two stacked memory cards with a spark (original artwork).
     * `size` drives both axes, `currentColor` inherits the row color, and
     * `active` reads thicker.
     */
    function MemoryIcon(props) {
      const rawSize = props !== null && props !== undefined ? Number(props.size) : NaN
      const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 16
      const active = props !== null && props !== undefined && props.active === true
      const stroke = active ? 2.1 : 1.6
      return h('svg', {
        className: 'dwm-icon',
        'data-active': active ? 'true' : 'false',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M8.6 4.8h7.6a1.8 1.8 0 0 1 1.8 1.8v7.6',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: active ? 1 : 0.85,
        }),
        h('rect', {
          x: 4.6,
          y: 8.6,
          width: 10.4,
          height: 10.4,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: stroke,
        }),
        h('path', {
          d: 'M7.6 12.1h4.4M7.6 14.8h3',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 18.2, cy: 6.6, r: active ? 1.8 : 1.5, fill: 'currentColor' }),
      )
    }

    /* ------------------------------------------------------------ small views */

    function Chip(props) {
      const tone = props.tone === 'on' ? 'is-on' : props.tone === 'warn' ? 'is-warn' : 'is-off'
      return h('span', { className: 'dwm-chip ' + tone }, props.text)
    }

    function StateBlock(props) {
      return h('div', { className: props.error === true ? 'dwm-state is-error' : 'dwm-state' },
        h('p', { className: 'dwm-state-title' }, props.title),
        props.text !== undefined && props.text !== null && props.text !== ''
          ? h('p', { className: 'dwm-state-text' }, props.text)
          : null,
        props.action !== undefined && props.action !== null ? props.action : null,
      )
    }

    /** Catches a render-time throw anywhere below it: the slot never blanks. */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failure: null }
      }

      static getDerivedStateFromError(failure) {
        return { failure }
      }

      componentDidCatch() {
        /* The fallback below is the whole reaction; no global reporting. */
      }

      render() {
        if (this.state.failure !== null) {
          return h(StateBlock, {
            error: true,
            title: this.props.t('error.render'),
            text: describeError(this.state.failure),
          })
        }
        return this.props.children
      }
    }

    /** Render-call guard for a component whose own body could throw. */
    function guarded(label, t, render) {
      try {
        return render()
      } catch (failure) {
        return h(StateBlock, {
          error: true,
          title: t('error.render'),
          text: describeError(failure) !== '' ? describeError(failure) : label,
        })
      }
    }

    /* ------------------------------------------------------------------- page */

    function MemoryPage(props) {
      const t = makeT(props.t)
      return h(PageBoundary, { t },
        guarded('page', t, () => h(PageBody, props)))
    }

    /** Pure view the tests drive: filter + window a file list (roadmap C4). */
    function FileListView(props) {
      return h('div', { className: 'dwm-filelist' },
        h(FileFilterBar, { t: props.t, filter: props.filter, onFilter: props.onFilter }),
        h(FileList, {
          t: props.t,
          files: props.files,
          selectedFile: props.selectedFile,
          scrollTop: props.scrollTop,
          onScroll: props.onScroll,
          onPickFile: props.onPickFile,
        }))
    }

    function PageBody(props) {
      const t = makeT(props.t)
      const requests = React.useRef({
        catalog: undefined,
        file: undefined,
        activities: undefined,
        toggleSkip: undefined,
        factRead: undefined,
        factSave: undefined,
        factDelete: undefined,
        trashList: undefined,
        trashRestore: undefined,
      })
      requests.current = {
        catalog: props.requestCatalog,
        file: props.requestFile,
        activities: props.requestActivities,
        toggleSkip: props.requestToggleSkip,
        factRead: props.requestFactRead,
        factSave: props.requestFactSave,
        factDelete: props.requestFactDelete,
        trashList: props.requestTrashList,
        trashRestore: props.requestTrashRestore,
      }

      const [tick, setTick] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState(null)
      const [data, setData] = React.useState(null)
      const dataRef = React.useRef(null)
      const [pickedWorkspace, setPickedWorkspace] = React.useState(null)
      const [pickedFile, setPickedFile] = React.useState(null)
      const [fileState, setFileState] = React.useState({ status: 'idle', error: null, value: null })
      const [activities, setActivities] = React.useState([])
      const [openActivity, setOpenActivity] = React.useState(null)
      // Roadmap C3: the body pane is a reader, the inline editor or the trash,
      // and none of these writes bypass the host's lock + guard path.
      const [paneMode, setPaneMode] = React.useState('view')
      const [draft, setDraft] = React.useState(null)
      const [deleteConfirm, setDeleteConfirm] = React.useState(false)
      const [paneError, setPaneError] = React.useState(null)
      const [trashEntries, setTrashEntries] = React.useState([])
      const [trashKeep, setTrashKeep] = React.useState(0)
      const [writing, setWriting] = React.useState(false)
      const busyTimer = React.useRef(null)

      // No timer survives unmount: the refresh indicator is the only timer here.
      React.useEffect(() => () => {
        if (busyTimer.current !== null) {
          try { clearTimeout(busyTimer.current) } catch (_ignored) { /* timer already gone */ }
          busyTimer.current = null
        }
      }, [])

      // One catalog fetch per tick: mount and every manual refresh.
      React.useEffect(() => {
        let cancelled = false
        if (dataRef.current === null) setStatus('loading')
        Promise.resolve()
          .then(() => (typeof requests.current.catalog === 'function'
            ? requests.current.catalog()
            : { ok: false, error: { code: 'host-unavailable', message: 'connection.rpc', details: {} } }))
          .then((outcome) => {
            if (cancelled) return
            const result = normalizeResult(outcome)
            if (result.ok === true) {
              const catalog = normalizeCatalog(result.value)
              dataRef.current = catalog
              setData(catalog)
              setError(null)
              setStatus('ready')
              return
            }
            setError(result.error)
            setStatus(dataRef.current === null ? 'error' : 'ready')
          })
          .catch((failure) => {
            if (cancelled) return
            setError({ code: 'rpc-failed', message: describeError(failure), details: {} })
            setStatus(dataRef.current === null ? 'error' : 'ready')
          })
        return () => { cancelled = true }
      }, [tick])

      const workspaces = data !== null ? data.workspaces : []
      const config = data !== null ? data.config : { enabled: true, autoExtract: true }
      // Session state comes with the catalog; an untracked session is null and
      // the toggle stays hidden.
      const session = data !== null ? data.session : null

      const toggleSkip = () => {
        if (session === null || typeof requests.current.toggleSkip !== 'function') return
        const next = session.skipTurnExtraction !== true
        // Optimistic flip, then reconcile with the host answer.
        dataRef.current = { ...dataRef.current, session: { ...session, skipTurnExtraction: next } }
        setData(dataRef.current)
        Promise.resolve()
          .then(() => requests.current.toggleSkip(next))
          .then((outcome) => {
            const result = normalizeResult(outcome)
            const state = result.ok === true && result.value !== null && typeof result.value === 'object'
              ? result.value
              : null
            if (dataRef.current === null) return
            dataRef.current = {
              ...dataRef.current,
              session: state !== null && typeof state.skipTurnExtraction === 'boolean'
                ? { sessionId: state.sessionId, skipTurnExtraction: state.skipTurnExtraction }
                : { ...dataRef.current.session, skipTurnExtraction: false },
            }
            setData(dataRef.current)
          })
          .catch(() => { /* the next refresh re-syncs from the catalog */ })
      }
      const selected = (() => {
        if (workspaces.length === 0) return null
        const exact = workspaces.filter((entry) => entry.path === pickedWorkspace)
        return exact.length > 0 ? exact[0] : workspaces[0]
      })()
      // Search & filter state (roadmap C4): one keyword, one type, reset when
      // the workspace changes so the next workspace starts unfiltered.
      const [fileFilter, setFileFilter] = React.useState({ type: 'all', keyword: '' })
      const [fileScrollTop, setFileScrollTop] = React.useState(0)
      React.useEffect(() => {
        setFileFilter({ type: 'all', keyword: '' })
        setFileScrollTop(0)
      }, [selected === null ? '' : selected.path])
      const selectedFiles = selected !== null ? selected.files : []
      const filteredFiles = filterFiles(selectedFiles, fileFilter.type, fileFilter.keyword)
      const selectedFile = (() => {
        if (filteredFiles.length === 0) return null
        const exact = filteredFiles.filter((file) => file.name === pickedFile)
        return exact.length > 0 ? exact[0] : filteredFiles[0]
      })()

      // One file fetch per (workspace, file, tick).
      React.useEffect(() => {
        const target = selected
        if (target === null || selectedFile === null) {
          setFileState({ status: 'idle', error: null, value: null })
          return undefined
        }
        let cancelled = false
        setFileState({ status: 'loading', error: null, value: null })
        Promise.resolve()
          .then(() => (typeof requests.current.file === 'function'
            ? requests.current.file(target.path, selectedFile.name)
            : { ok: false, error: { code: 'host-unavailable', message: 'connection.rpc', details: {} } }))
          .then((outcome) => {
            if (cancelled) return
            const result = normalizeResult(outcome)
            if (result.ok === true) {
              setFileState({
                status: 'ready',
                error: null,
                value: normalizeFileValue(result.value, target.path, selectedFile.name),
              })
              return
            }
            setFileState({ status: 'error', error: result.error, value: null })
          })
          .catch((failure) => {
            if (cancelled) return
            setFileState({
              status: 'error',
              error: { code: 'rpc-failed', message: describeError(failure), details: {} },
              value: null,
            })
          })
        return () => { cancelled = true }
      }, [tick, selected === null ? '' : selected.path, selectedFile === null ? '' : selectedFile.name])

      // One activities fetch per tick; entries are filtered to the workspace
      // the panel currently shows. A failed feed never blocks the files view.
      React.useEffect(() => {
        let cancelled = false
        Promise.resolve()
          .then(() => (typeof requests.current.activities === 'function'
            ? requests.current.activities()
            : { ok: false, error: { code: 'host-unavailable', message: 'connection.rpc', details: {} } }))
          .then((outcome) => {
            if (cancelled) return
            const result = normalizeResult(outcome)
            if (result.ok === true) setActivities(normalizeActivities(result.value))
          })
          .catch(() => { /* activity is best-effort decoration */ })
        return () => { cancelled = true }
      }, [tick])

      const workspaceActivities = (() => {
        if (selected === null) return []
        const key = selected.path
        return activities.filter((entry) => entry.workspace === key)
      })()

      const refresh = () => {
        if (busy) return
        setBusy(true)
        setTick((value) => value + 1)
        if (typeof setTimeout === 'function') {
          busyTimer.current = setTimeout(() => {
            busyTimer.current = null
            try { setBusy(false) } catch (_ignored) { /* unmounted */ }
          }, 400)
        } else {
          setBusy(false)
        }
      }

      /* --------------------------------------------------- fact writes (C3) */

      const hostUnavailable = {
        ok: false,
        error: { code: 'host-unavailable', message: 'connection.rpc', details: {} },
      }

      /**
       * One serialized write: a second click while the first is in flight is
       * ignored, a failure becomes one readable line, and the busy flag always
       * clears so the form cannot be stuck disabled.
       */
      const runWrite = (call) => {
        if (writing === true) return Promise.resolve(null)
        setWriting(true)
        setPaneError(null)
        return Promise.resolve()
          .then(() => (typeof call === 'function' ? call() : hostUnavailable))
          .then((outcome) => {
            const result = normalizeResult(outcome)
            if (result.ok === true) return result.value === undefined ? {} : result.value
            setPaneError(errorText(result.error, t))
            return null
          })
          .catch((failure) => {
            setPaneError(describeError(failure) !== '' ? describeError(failure) : t('error.title'))
            return null
          })
          .then((value) => {
            setWriting(false)
            return value
          })
      }

      // Picking another file or workspace abandons a half-written form.
      React.useEffect(() => {
        setPaneMode('view')
        setDraft(null)
        setDeleteConfirm(false)
        setPaneError(null)
      }, [selected === null ? '' : selected.path, selectedFile === null ? '' : selectedFile.name])

      const openNewFact = () => {
        setDraft(blankFactDraft())
        setPaneMode('edit')
        setDeleteConfirm(false)
        setPaneError(null)
      }

      const openEditFact = () => {
        if (selected === null || selectedFile === null) return
        const target = selected
        const fileName = selectedFile.name
        setDraft(draftFromFact({ ...selectedFile, fileName }))
        setPaneMode('edit')
        setDeleteConfirm(false)
        setPaneError(null)
        // `fact-read` only refills the body; the catalog already has the rest.
        Promise.resolve()
          .then(() => (typeof requests.current.factRead === 'function'
            ? requests.current.factRead(factReadPayload(target.path, fileName))
            : hostUnavailable))
          .then((outcome) => {
            const result = normalizeResult(outcome)
            if (result.ok === true) setDraft(draftFromFact(result.value))
            else setPaneError(errorText(result.error, t))
            return null
          })
          .catch((failure) => {
            setPaneError(describeError(failure) !== '' ? describeError(failure) : t('error.title'))
            return null
          })
      }

      const onDraftField = (field, value) => {
        setDraft((current) => ({ ...(current === null ? blankFactDraft() : current), [field]: value }))
      }

      const cancelEdit = () => {
        setPaneMode('view')
        setDraft(null)
        setDeleteConfirm(false)
        setPaneError(null)
      }

      const saveFact = () => {
        if (selected === null || draft === null) return
        const problem = validateFactDraft(draft, t)
        if (problem !== null) {
          setPaneError(problem)
          return
        }
        const target = selected
        const payload = factSavePayload(target.path, draft)
        payload.name = bareFactName(payload.name)
        runWrite(() => (typeof requests.current.factSave === 'function'
          ? requests.current.factSave(payload)
          : hostUnavailable))
          .then((value) => {
            if (value === null) return null
            const saved = isObject(value) ? value : {}
            setPaneMode('view')
            setDraft(null)
            setDeleteConfirm(false)
            setPickedWorkspace(target.path)
            // Re-select what was written so the pointer change is visible.
            setPickedFile(str(saved.fileName) !== '' ? str(saved.fileName) : factFileNameOf(payload.name))
            setTick((count) => count + 1)
            return null
          })
      }

      const confirmDelete = () => {
        if (selected === null || selectedFile === null) return
        const target = selected
        const fileName = selectedFile.name
        runWrite(() => (typeof requests.current.factDelete === 'function'
          ? requests.current.factDelete(factDeletePayload(target.path, fileName))
          : hostUnavailable))
          .then((value) => {
            if (value === null) return null
            setDeleteConfirm(false)
            setPaneMode('view')
            setPickedWorkspace(target.path)
            setPickedFile(null)
            setTick((count) => count + 1)
            return null
          })
      }

      const loadTrash = () => {
        if (selected === null) return
        const target = selected
        setPaneError(null)
        Promise.resolve()
          .then(() => (typeof requests.current.trashList === 'function'
            ? requests.current.trashList({ path: target.path })
            : hostUnavailable))
          .then((outcome) => {
            const result = normalizeResult(outcome)
            if (result.ok !== true) {
              setTrashEntries([])
              setTrashKeep(0)
              setPaneError(errorText(result.error, t))
              return null
            }
            const value = isObject(result.value) ? result.value : {}
            setTrashEntries(asArray(value.entries))
            setTrashKeep(num(value.keep))
            return null
          })
          .catch((failure) => {
            setTrashEntries([])
            setPaneError(describeError(failure) !== '' ? describeError(failure) : t('error.title'))
            return null
          })
      }

      const toggleTrash = () => {
        if (paneMode === 'trash') {
          setPaneMode('view')
          setPaneError(null)
          return
        }
        setPaneMode('trash')
        setDraft(null)
        setDeleteConfirm(false)
        loadTrash()
      }

      const restoreEntry = (name) => {
        if (selected === null) return
        const target = selected
        runWrite(() => (typeof requests.current.trashRestore === 'function'
          ? requests.current.trashRestore(trashRestorePayload(target.path, name))
          : hostUnavailable))
          .then((value) => {
            if (value === null) return null
            setPaneMode('view')
            setPickedWorkspace(target.path)
            setPickedFile(str(value.fileName) !== '' ? str(value.fileName) : factFileNameOf(name))
            setTick((count) => count + 1)
            return null
          })
      }

      if (status === 'loading' && data === null) {
        return h('section', { className: 'dwm-page' },
          h(PageHead, { t, busy, onRefresh: refresh, config: null }),
          h(StateBlock, { title: t('state.loading') }))
      }

      if (status === 'error' && data === null) {
        return h('section', { className: 'dwm-page' },
          h(PageHead, { t, busy, onRefresh: refresh, config: null }),
          h(StateBlock, {
            error: true,
            title: t('error.title'),
            text: errorText(error, t),
            action: h('button', {
              type: 'button',
              className: 'dwm-btn',
              onClick: refresh,
            }, t('action.retry')),
          }))
      }

      return h('section', { className: 'dwm-page' },
        h(PageHead, { t, busy, onRefresh: refresh, config, activity: selected }),
        h(ConfigBar, { t, config, session, onToggleSkip: toggleSkip }),
        error !== null
          ? h('div', { className: 'dwm-errorline' },
            h('span', null, t('error.line', { message: errorText(error, t) })),
            h('button', { type: 'button', className: 'dwm-btn', onClick: refresh }, t('action.retry')))
          : null,
        workspaces.length === 0
          ? h(StateBlock, { title: t('state.empty'), text: t('state.emptyHint') })
          : h('div', { className: 'dwm-cols' },
            h(WorkspaceColumn, {
              t,
              workspaces,
              selectedPath: selected === null ? null : selected.path,
              onPick: (path) => {
                setPickedWorkspace(path)
                setPickedFile(null)
                setOpenActivity(null)
              },
            }),
            h(FileColumn, {
              t,
              selected,
              files: filteredFiles,
              totalCount: selected !== null ? selected.files.length : 0,
              filter: fileFilter,
              onFilter: (next) => setFileFilter((current) => ({ ...current, ...next })),
              scrollTop: fileScrollTop,
              onScroll: setFileScrollTop,
              selectedFile,
              fileState,
              onPickFile: (name) => {
                setPickedWorkspace(selected === null ? null : selected.path)
                setPickedFile(name)
              },
              onReload: () => setTick((value) => value + 1),
              mode: paneMode,
              draft,
              deleteConfirm,
              factError: paneError,
              busy: busy || writing,
              trashEntries,
              trashKeep,
              onNewFact: openNewFact,
              onEdit: openEditFact,
              onField: onDraftField,
              onSave: saveFact,
              onCancelEdit: cancelEdit,
              onAskDelete: () => {
                setDeleteConfirm(true)
                setPaneError(null)
              },
              onConfirmDelete: confirmDelete,
              onCancelDelete: () => {
                setDeleteConfirm(false)
                setPaneError(null)
              },
              onToggleTrash: toggleTrash,
              onRestore: restoreEntry,
            })),
        h(ActivityFeed, {
          t,
          entries: workspaceActivities,
          openIndex: openActivity,
          onToggle: (index) => setOpenActivity((current) => (current === index ? null : index)),
        }))
    }

    /** Left column: every workspace that currently has memory files. */
    function WorkspaceColumn(props) {
      const t = props.t
      const workspaces = asArray(props.workspaces)
      return h('div', { className: 'dwm-col' },
        h('h2', { className: 'dwm-col-title' },
          t('catalog.workspaces') + ' · ' + t('catalog.workspaceCount', { n: workspaces.length })),
        h('ul', { className: 'dwm-list' }, workspaces.map((entry) => h('li', { key: entry.path },
          h('button', {
            type: 'button',
            className: 'dwm-item' + (props.selectedPath === entry.path ? ' is-active' : ''),
            title: entry.memoryRoot !== '' ? entry.memoryRoot : entry.path,
            onClick: () => props.onPick(entry.path),
          },
            h('span', { className: 'dwm-item-name' },
              h('span', null, entry.title),
              h('span', { className: 'dwm-badge' }, t('catalog.fileCount', { n: entry.files.length }))),
            h('span', { className: 'dwm-item-meta' }, entry.path))))))
    }

    /** Right column: the selected workspace's files plus the selected file body. */
    function FileColumn(props) {
      const t = props.t
      if (props.selected === null || props.selected === undefined) {
        return h('div', { className: 'dwm-col' }, h(StateBlock, { title: t('state.noWorkspace') }))
      }
      const selected = props.selected
      const files = asArray(props.files)
      const totalCount = Math.max(0, Math.floor(num(props.totalCount)))
      // Roadmap C3: the body pane shows the reader, the inline editor or the
      // trash, and the list header carries the create action.
      const mode = props.mode === 'edit' || props.mode === 'trash' ? props.mode : 'view'
      const trashOpen = mode === 'trash'
      const rootLabel = selected.memoryRoot !== '' && selected.memoryRoot !== undefined
        ? selected.memoryRoot
        : selected.path
      return h('div', { className: 'dwm-col' },
        h('div', { className: 'dwm-colhead' },
          h('h2', { className: 'dwm-col-title' },
            t('catalog.files') + ' · ' + t('catalog.fileCount', {
              n: files.length === totalCount ? totalCount : files.length + '/' + totalCount,
            })),
          h('span', { className: 'dwm-chips' },
            h('button', {
              type: 'button',
              className: 'dwm-btn dwm-new-fact',
              onClick: props.onNewFact,
            }, t('fact.new')),
            h('button', {
              type: 'button',
              className: 'dwm-btn dwm-trash-toggle' + (trashOpen ? ' is-on' : ''),
              onClick: props.onToggleTrash,
            }, trashOpen ? t('fact.trashClose') : t('fact.trashOpen')))),
        h(FileFilterBar, {
          t,
          filter: props.filter,
          onFilter: props.onFilter,
        }),
        files.length === 0
          ? h(StateBlock, { title: t('state.filterEmpty') })
          : h(FileList, {
            t,
            files,
            selectedFile: props.selectedFile,
            scrollTop: props.scrollTop,
            onScroll: props.onScroll,
            onPickFile: props.onPickFile,
          }),
        h('div', { className: 'dwm-panel' },
          trashOpen
            ? h(TrashPanel, {
              t,
              entries: props.trashEntries,
              keep: props.trashKeep,
              error: props.trashError,
              busy: props.busy === true,
              onRestore: props.onRestore,
            })
            : mode === 'edit'
              ? h(FactEditor, {
                t,
                draft: props.draft,
                error: props.factError,
                busy: props.busy === true,
                onField: props.onField,
                onSave: props.onSave,
                onCancel: props.onCancelEdit,
              })
              : h('div', { className: 'dwm-filepane' },
                h('p', { className: 'dwm-path' }, t('catalog.memoryRoot', { path: rootLabel })),
                isFactFile(props.selectedFile)
                  ? h(FactActions, {
                    t,
                    confirm: props.deleteConfirm === true,
                    busy: props.busy === true,
                    error: props.factError,
                    onEdit: props.onEdit,
                    onAskDelete: props.onAskDelete,
                    onConfirmDelete: props.onConfirmDelete,
                    onCancelDelete: props.onCancelDelete,
                  })
                  : null,
                h(FileBody, { t, file: props.selectedFile, state: props.fileState, onReload: props.onReload }))))
    }

    /** Type chips + keyword input driving the file list filter (roadmap C4). */
    function FileFilterBar(props) {
      const t = props.t
      const filter = isObject(props.filter) ? props.filter : { type: 'all', keyword: '' }
      const types = ['all'].concat(MEMORY_TYPE_KEYS)
      return h('div', { className: 'dwm-filefilter' },
        h('span', { className: 'dwm-chips' }, types.map((type) => h('button', {
          key: type,
          type: 'button',
          className: 'dwm-chip dwm-type-chip' + (filter.type === type ? ' is-on' : ''),
          onClick: () => props.onFilter({ type }),
        }, type === 'all' ? t('catalog.typeAll') : t('catalog.type.' + type)))),
        h('input', {
          className: 'dwm-filesearch',
          type: 'search',
          placeholder: t('catalog.searchPlaceholder'),
          value: typeof filter.keyword === 'string' ? filter.keyword : '',
          onChange: (event) => props.onFilter({ keyword: str(event && event.target && event.target.value) }),
        }))
    }

    /**
     * The file list itself: plain below VIRTUAL_LIST_MIN items, windowed
     * above. The window renders only the visible slice full-size inside a
     * scroll container; the rest of each row is one fixed-height placeholder
     * <li>, so huge catalogs stay cheap (roadmap C4).
     */
    function FileList(props) {
      const t = props.t
      const files = asArray(props.files)
      const virtualize = files.length > VIRTUAL_LIST_MIN
      if (!virtualize) {
        return h('ul', { className: 'dwm-list' },
          files.map((file) => h(FileRow, { key: file.name, t, file, selectedFile: props.selectedFile, onPickFile: props.onPickFile })))
      }
      const win = windowFiles(files.length, props.scrollTop, FILE_VIEWPORT_HEIGHT, FILE_ROW_HEIGHT)
      const rows = []
      if (win.padTop > 0) {
        rows.push(h('li', { key: 'pad-top', className: 'dwm-list-pad', 'aria-hidden': 'true',
          style: { height: win.padTop + 'px' } }))
      }
      for (let at = win.start; at < win.stop; at += 1) {
        rows.push(h(FileRow, { key: files[at].name, t, file: files[at], selectedFile: props.selectedFile, onPickFile: props.onPickFile }))
      }
      if (win.padBottom > 0) {
        rows.push(h('li', { key: 'pad-bottom', className: 'dwm-list-pad', 'aria-hidden': 'true',
          style: { height: win.padBottom + 'px' } }))
      }
      return h('div', {
        className: 'dwm-list dwm-list-virtual',
        onScroll: (event) => props.onScroll(Math.max(0, Math.floor(num(event && event.target && event.target.scrollTop)))),
      }, rows)
    }

    /** One file row: kind badge, name, type badge, size and the three times. */
    function FileRow(props) {
      const t = props.t
      const file = isObject(props.file) ? props.file : { name: '', kind: 'fact' }
      const active = props.selectedFile !== null && props.selectedFile !== undefined
        && props.selectedFile.name === file.name
      // Roadmap D2: fact rows surface all three host-maintained times — the
      // index has none of them, so it keeps the single updated line.
      const meta = file.kind === 'fact'
        ? t('state.updatedAt', { time: formatRelative(file.updatedAt, t) }) + ' · '
          + t('state.createdAt', { time: formatRelative(file.createdAt, t) }) + ' · '
          + t('state.lastAccessedAt', { time: formatRelative(file.lastAccessedAt, t) })
        : t('state.updatedAt', { time: formatRelative(file.updatedAt, t) })
      return h('li', { key: file.name },
        h('button', {
          type: 'button',
          className: 'dwm-item' + (active ? ' is-active' : ''),
          onClick: () => props.onPickFile(file.name),
        },
          h('span', { className: 'dwm-item-name' },
            h('span', { className: 'dwm-badge' + (file.kind === 'index' ? ' is-index' : '') },
              t(file.kind === 'index' ? 'catalog.index' : 'catalog.fact')),
            h('span', null, file.name),
            file.type !== undefined
              ? h('span', { className: 'dwm-badge dwm-type-badge' }, t('catalog.type.' + file.type))
              : null,
            h('span', { className: 'dwm-badge' }, formatBytes(file.size))),
          h('span', { className: 'dwm-item-meta', title: meta }, meta)))
    }

    /** The `<pre>` body of the selected file, with its loading/error states. */
    function FileBody(props) {
      const t = props.t
      const state = isObject(props.state) ? props.state : { status: 'idle', error: null, value: null }
      if (props.file === null || props.file === undefined || state.status === 'idle') {
        return h(StateBlock, { title: t('state.noFile') })
      }
      if (state.status === 'loading') return h(StateBlock, { title: t('state.fileLoading') })
      if (state.status === 'error') {
        return h(StateBlock, {
          error: true,
          title: t('error.title'),
          text: errorText(state.error, t),
          action: h('button', {
            type: 'button',
            className: 'dwm-btn',
            onClick: props.onReload,
          }, t('action.reload')),
        })
      }
      const value = isObject(state.value) ? state.value : { path: '', content: '', truncated: false }
      return h('div', { className: 'dwm-file' },
        h('p', { className: 'dwm-path' }, t('catalog.filePath', { path: str(value.path) })),
        value.truncated === true
          ? h('p', { className: 'dwm-hint' }, t('state.truncated', { limit: formatBytes(262144) }))
          : null,
        h('pre', { className: 'dwm-pre' }, str(value.content) !== '' ? value.content : t('value.none')))
    }

    /**
     * Inline fact editor (roadmap C3): one form, no hooks, every value and
     * callback comes from props so the host owns the state machine.
     */
    function FactEditor(props) {
      const t = props.t
      const draft = isObject(props.draft) ? props.draft : blankFactDraft()
      const creating = draft.creating === true
      const onField = (field) => (event) => {
        if (typeof props.onField !== 'function') return
        props.onField(field, str(event && event.target && event.target.value))
      }
      const error = typeof props.error === 'string' && props.error !== '' ? props.error : null
      return h('form', {
        className: 'dwm-editor',
        onSubmit: (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
        },
      },
        h('h3', { className: 'dwm-editor-title' },
          creating ? t('fact.newTitle') : t('fact.editTitle', { name: str(draft.name) })),
        h('label', { className: 'dwm-field' },
          h('span', { className: 'dwm-field-label' }, t('fact.name')),
          h('input', {
            className: 'dwm-input',
            type: 'text',
            value: str(draft.name),
            readOnly: !creating,
            placeholder: 'prefers-tabs',
            onChange: creating ? onField('name') : undefined,
          }),
          creating ? h('span', { className: 'dwm-hint' }, t('fact.nameHint')) : null),
        h('label', { className: 'dwm-field' },
          h('span', { className: 'dwm-field-label' }, t('fact.type')),
          h('select', {
            className: 'dwm-input',
            value: str(draft.type) !== '' ? str(draft.type) : 'user',
            onChange: onField('type'),
          }, MEMORY_TYPE_KEYS.map((type) => h('option', { key: type, value: type }, t('catalog.type.' + type))))),
        h('label', { className: 'dwm-field' },
          h('span', { className: 'dwm-field-label' }, t('fact.description')),
          h('input', {
            className: 'dwm-input',
            type: 'text',
            value: str(draft.description),
            onChange: onField('description'),
          })),
        h('label', { className: 'dwm-field' },
          h('span', { className: 'dwm-field-label' }, t('fact.body')),
          h('textarea', {
            className: 'dwm-input dwm-textarea',
            rows: 10,
            value: str(draft.body),
            onChange: onField('body'),
          })),
        error !== null ? h('p', { className: 'dwm-fielderror', role: 'alert' }, error) : null,
        h('div', { className: 'dwm-actions' },
          h('button', {
            type: 'button',
            className: 'dwm-btn is-primary',
            disabled: props.busy === true,
            onClick: props.onSave,
          }, props.busy === true ? t('fact.saving') : t('fact.save')),
          h('button', {
            type: 'button',
            className: 'dwm-btn',
            onClick: props.onCancel,
          }, t('fact.cancel'))))
    }

    /**
     * Edit / delete actions for the selected fact. Delete is a two-step inline
     * confirm that says the fact is restorable, so no native dialog is needed.
     */
    function FactActions(props) {
      const t = props.t
      const error = typeof props.error === 'string' && props.error !== '' ? props.error : null
      if (props.confirm === true) {
        return h('div', { className: 'dwm-actions dwm-confirm' },
          h('span', { className: 'dwm-hint' }, t('fact.deleteConfirm')),
          h('button', {
            type: 'button',
            className: 'dwm-btn is-danger',
            disabled: props.busy === true,
            onClick: props.onConfirmDelete,
          }, t('fact.deleteYes')),
          h('button', {
            type: 'button',
            className: 'dwm-btn',
            onClick: props.onCancelDelete,
          }, t('fact.deleteNo')),
          error !== null ? h('p', { className: 'dwm-fielderror', role: 'alert' }, error) : null)
      }
      return h('div', { className: 'dwm-actions' },
        h('span', { className: 'dwm-chips' },
          h('button', { type: 'button', className: 'dwm-btn', onClick: props.onEdit }, t('fact.edit')),
          h('button', { type: 'button', className: 'dwm-btn', onClick: props.onAskDelete }, t('fact.delete'))),
        error !== null ? h('p', { className: 'dwm-fielderror', role: 'alert' }, error) : null)
    }

    /** Trash view (roadmap C3): newest first, every entry restorable. */
    function TrashPanel(props) {
      const t = props.t
      const entries = asArray(props.entries)
      const error = typeof props.error === 'string' && props.error !== '' ? props.error : null
      return h('div', { className: 'dwm-trash' },
        h('h3', { className: 'dwm-col-title' }, t('fact.trashTitle')),
        h('p', { className: 'dwm-hint' }, t('fact.trashHint', { n: num(props.keep) })),
        error !== null ? h('p', { className: 'dwm-fielderror', role: 'alert' }, error) : null,
        entries.length === 0
          ? h(StateBlock, { title: t('fact.trashEmpty') })
          : h('ul', { className: 'dwm-list' }, entries.map((entry) => h('li', {
            key: str(entry.fileName) !== '' ? str(entry.fileName) : str(entry.name),
            className: 'dwm-trash-row',
          },
            h('span', { className: 'dwm-item-name' },
              h('span', null, str(entry.name)),
              h('span', { className: 'dwm-badge' }, formatBytes(entry.size))),
            h('span', { className: 'dwm-item-meta' }, formatRelative(entry.modifiedAt, t)),
            h('button', {
              type: 'button',
              className: 'dwm-btn',
              disabled: props.busy === true,
              onClick: () => {
                if (typeof props.onRestore === 'function') props.onRestore(str(entry.name))
              },
            }, props.busy === true ? t('fact.restoring') : t('fact.restore'))))))
    }

    /** Old-vs-new index text rendered as plain-text diff runs (removed first). */
    function ActivityDiff(props) {
      const t = props.t
      const before = typeof props.before === 'string' ? props.before : ''
      const after = typeof props.after === 'string' ? props.after : ''
      if (before === '' && after === '') return h('p', { className: 'dwm-activity-note' }, t('activity.noDiff'))
      if (before === after) return h('p', { className: 'dwm-activity-note' }, t('activity.diffSame'))
      const hunks = diffLines(before, after)
      return h('div', { className: 'dwm-activity-diff' }, hunks.map((hunk, index) => h('div', { key: String(index), className: 'dwm-activity-diffhunk' },
        hunk.removed.map((line, at) => h('div', { key: 'r' + at, className: 'dwm-diffline is-removed' }, line === '' ? ' ' : line)),
        hunk.added.map((line, at) => h('div', { key: 'a' + at, className: 'dwm-diffline is-added' }, line === '' ? ' ' : line)))))
    }

    /** One extraction entry: remembered/forgot counts, click expands the index diff. */
    function ActivityEntry(props) {
      const t = props.t
      const entry = isObject(props.entry) ? props.entry : {}
      const wrote = Array.isArray(entry.wrote) ? entry.wrote.length : 0
      const forgot = Array.isArray(entry.forgot) ? entry.forgot.length : 0
      const open = props.open === true
      const line = [h('span', {
        key: 'wrote',
        className: 'dwm-activity-count' + (wrote > 0 ? ' is-added' : ''),
      }, t('activity.remembered', { n: wrote }))]
      if (forgot > 0) {
        line.push(h('span', { key: 'forgot', className: 'dwm-activity-count is-removed' }, t('activity.forgot', { n: forgot })))
      }
      if (str(entry.diffSummary) !== '') line.push(h('span', { key: 'sum', className: 'dwm-activity-summary' }, str(entry.diffSummary)))
      return h('button', {
        type: 'button',
        className: 'dwm-activity' + (open ? ' is-open' : ''),
        title: formatRelative(entry.at, t),
        onClick: props.onToggle,
      },
        h('span', { className: 'dwm-activity-line' }, line),
        open ? h(ActivityDiff, { t, before: entry.indexBefore, after: entry.indexAfter }) : null)
    }

    /** The workspace's recent extraction activity feed. */
    function ActivityFeed(props) {
      const t = props.t
      const entries = Array.isArray(props.entries) ? props.entries : []
      return h('section', { className: 'dwm-activities' },
        h('h2', { className: 'dwm-col-title' }, t('activity.title')),
        entries.length === 0
          ? h('p', { className: 'dwm-activity-note' }, t('activity.empty'))
          : entries.map((entry, index) => h(ActivityEntry, {
            key: String(entry.at ?? '') + '-' + String(index),
            t,
            entry,
            open: props.openIndex === index,
            onToggle: () => props.onToggle(index),
          })))
    }

    function PageHead(props) {
      const t = props.t
      const activity = isObject(props.activity) ? props.activity : null
      return h('header', { className: 'dwm-head' },
        h('div', { className: 'dwm-headtext' },
          h('h1', { className: 'dwm-title' }, t('title')),
          h('p', { className: 'dwm-sub' }, t('subtitle'))),
        h('div', { className: 'dwm-headtools' },
          activity !== null
            ? h(Chip, {
              tone: num(activity.todayCount) > 0 ? 'on' : 'off',
              text: t('catalog.extractCount', { n: num(activity.todayCount) }),
            })
            : null,
          h('button', {
            type: 'button',
            className: 'dwm-btn',
            disabled: props.busy === true,
            onClick: props.onRefresh,
          }, props.busy === true ? t('action.refreshing') : t('action.refresh'))))
    }

    function ConfigBar(props) {
      const t = props.t
      const config = props.config !== null && props.config !== undefined
        ? props.config
        : { enabled: true, autoExtract: true }
      const session = props.session !== null && props.session !== undefined ? props.session : null
      return h('div', { className: 'dwm-config' },
        h('span', { className: 'dwm-chips' },
          h(Chip, {
            tone: config.enabled === true ? 'on' : 'off',
            text: t(config.enabled === true ? 'config.enabledOn' : 'config.enabledOff'),
          }),
          h(Chip, {
            tone: config.autoExtract === true ? 'on' : 'warn',
            text: t(config.autoExtract === true ? 'config.autoExtractOn' : 'config.autoExtractOff'),
          }),
          // Session-level incognito toggle (roadmap C2): volatile, this
          // session only; hidden when the host has no trackable session.
          session !== null
            ? h('button', {
              type: 'button',
              className: 'dwm-btn dwm-session-toggle'
                + (session.skipTurnExtraction === true ? ' is-on' : ''),
              onClick: props.onToggleSkip,
            }, t(session.skipTurnExtraction === true
              ? 'config.skipTurnOn'
              : 'config.skipTurnOff'))
            : null),
        h('p', { className: 'dwm-hint' }, t('config.hint') + ' ' + t('config.costHint')))
    }

    /** One readable line for a failure object, host-unavailable aware. */
    function errorText(error, t) {
      const failure = isObject(error) ? error : {}
      if (failure.code === 'host-unavailable') {
        const reason = truncate(str(failure.message))
        return t('error.host') + (reason !== '' ? ' (' + reason + ')' : '')
      }
      const message = firstText([failure.message, describeError(failure.details), describeError(failure)])
      const code = str(failure.code)
      const parts = []
      if (message !== '') parts.push(message)
      if (code !== '' && code !== 'error') parts.push(t('error.code', { code }))
      return parts.length > 0 ? parts.join(' · ') : t('error.title')
    }

    /* ---------------------------------------------------------------- install */

    /** Register both dictionaries; the probe falls back to the per-locale form. */
    function registerDictionaries(ctx) {
      const dispose = []
      const remember = (value) => {
        if (typeof value === 'function') dispose.push(value)
      }
      const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined
      if (locale === undefined || locale === null || typeof locale.register !== 'function') return () => {}
      try {
        remember(locale.register(NS, { zh, en }))
      } catch (_typedFormFailed) {
        /* fall through to the per-locale form */
      }
      const probe = typeof locale.bind === 'function' ? locale.bind(NS) : undefined
      const resolved = typeof probe === 'function'
        ? (() => {
          try { return probe('panel') } catch (_ignored) { return undefined }
        })()
        : undefined
      if (resolved === undefined || resolved === 'panel') {
        try { remember(locale.register(NS, 'zh', zh)) } catch (_ignored) { /* no locale service */ }
        try { remember(locale.register(NS, 'en', en)) } catch (_ignored) { /* no locale service */ }
      }
      return () => {
        for (const off of dispose) {
          try { off() } catch (_ignored) { /* already disposed */ }
        }
      }
    }

    /** Register the page, the sidebar row and the dictionaries. */
    function install(ctx) {
      if (ctx === null || ctx === undefined) return
      const locale = ctx.locale
      const bound = locale !== undefined && locale !== null && typeof locale.bind === 'function'
        ? locale.bind(NS)
        : undefined
      const t = makeT(bound)

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => installStyles(), PKG + ': styles')
        ctx.effect(() => registerDictionaries(ctx), PKG + ': dictionaries')
      } else {
        installStyles()
        registerDictionaries(ctx)
      }

      if (ctx.slots === undefined || ctx.slots === null) return

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({
          requestCatalog: () => callHost(ctx, 'catalog', {}),
          requestFile: (path, name) => callHost(ctx, 'read', { path, name }),
          requestActivities: () => callHost(ctx, 'activities', {}),
          requestToggleSkip: (skipTurnExtraction) => callHost(ctx, 'session-state', { skipTurnExtraction: skipTurnExtraction === true }),
          requestFactRead: (payload) => callHost(ctx, 'fact-read', payload),
          requestFactSave: (payload) => callHost(ctx, 'fact-save', payload),
          requestFactDelete: (payload) => callHost(ctx, 'fact-delete', payload),
          requestTrashList: (payload) => callHost(ctx, 'trash-list', payload),
          requestTrashRestore: (payload) => callHost(ctx, 'trash-restore', payload),
        }),
      }, MemoryPage))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        locale: NS,
        label: () => t('panel'),
      }, MemoryIcon))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        install(ctx)
      },
      /** Test seam: pure helpers and hook-free views with no runtime effect. */
      __internals: {
        normalizeResult,
        normalizeCatalog,
        normalizeFileValue,
        normalizeActivities,
        diffLines,
        sortFiles,
        filterFiles,
        windowFiles,
        formatBytes,
        formatRelative,
        describeError,
        errorText,
        makeT,
        factSavePayload,
        factReadPayload,
        factDeletePayload,
        trashRestorePayload,
        factFileNameOf,
        bareFactName,
        blankFactDraft,
        draftFromFact,
        validateFactDraft,
        isFactFile,
        FactEditor,
        FactActions,
        TrashPanel,
        callHost,
        MemoryIcon,
        Chip,
        StateBlock,
        PageHead,
        ConfigBar,
        WorkspaceColumn,
        FileColumn,
        FileFilterBar,
        FileList,
        FileRow,
        FileListView,
        FileBody,
        ActivityDiff,
        ActivityEntry,
        ActivityFeed,
        MemoryPage,
      },
    }
  },
})
