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
      'config.hint': '这些开关在「插件设置 → 工作区记忆」里修改；本页只读。',
      'config.costHint': '自动提取会在每轮成功对话后发起额外模型请求，增加 token 用量与成本。',
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
      'catalog.memoryRoot': '记忆目录：{path}',
      'catalog.filePath': '文件：{path}',
      'state.loading': '正在读取工作区记忆…',
      'state.empty': '还没有任何工作区留下记忆',
      'state.emptyHint': '在某个工作区里对话并说「记住…」，或等一轮成功对话后的自动提取，这里就会出现内容。',
      'state.noWorkspace': '从左侧选择一个工作区',
      'state.noFile': '选择一个文件查看原文',
      'state.fileLoading': '正在读取文件…',
      'state.truncated': '文件过大，只显示末尾部分（上限 {limit}）',
      'state.updatedAt': '更新于 {time}',
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
      'config.hint': 'Change these in Plugin settings → Workspace Memory; this page is read-only.',
      'config.costHint': 'Auto-extract issues an extra model request after every successful turn, which adds token usage and cost.',
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
      'catalog.memoryRoot': 'Memory directory: {path}',
      'catalog.filePath': 'File: {path}',
      'state.loading': 'Reading workspace memory…',
      'state.empty': 'No workspace has any memory yet',
      'state.emptyHint': 'Talk in a workspace and say "remember …", or wait for the automatic extraction after a successful turn; content shows up here.',
      'state.noWorkspace': 'Pick a workspace on the left',
      'state.noFile': 'Pick a file to read its content',
      'state.fileLoading': 'Reading file…',
      'state.truncated': 'File too large; only the tail is shown (limit {limit})',
      'state.updatedAt': 'Updated {time}',
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
      try {
        const result = await rpc.call(RPC_BASE, RPC_ENDPOINT, { endpoint, payload })
        return normalizeResult(result)
      } catch (failure) {
        return { ok: false, error: { code: 'rpc-failed', message: describeError(failure), details: {} } }
      }
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
          size: num(file && file.size),
          updatedAt: num(file && file.updatedAt),
        }
      }).filter((file) => file.name !== '')
      list.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'index' ? -1 : 1
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      return list
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
      }
    }

    /** Defensive Catalog normalization: never throws, always an object. */
    function normalizeCatalog(value) {
      const config = isObject(value && value.config) ? value.config : {}
      const workspaces = asArray(value && value.workspaces)
        .map(normalizeWorkspace)
        .filter((entry) => entry !== null)
      workspaces.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return {
        config: {
          enabled: config.enabled !== false,
          autoExtract: config.autoExtract !== false,
        },
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
      '.dwm-panel{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);padding:10px 12px;}',
      '.dwm-path{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dwm-pre{margin:0;max-height:56vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;}',
      '.dwm-state{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:22px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.dwm-state-title{margin:0;font-size:13px;font-weight:600;}',
      '.dwm-state-text{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:72ch;}',
      '.dwm-state.is-error{border-style:solid;border-color:var(--dsw-alias-state-error-primary);}',
      '.dwm-state.is-error .dwm-state-title{color:var(--dsw-alias-state-error-primary);}',
      '.dwm-errorline{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-state-error-primary);}',
      '.dwm-icon{display:block;}',
      '.dwm-icon[data-active="false"]{opacity:.78;}',
      '.dwm-icon[data-active="true"]{opacity:1;}',
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

    function PageBody(props) {
      const t = makeT(props.t)
      const requests = React.useRef({ catalog: undefined, file: undefined })
      requests.current = { catalog: props.requestCatalog, file: props.requestFile }

      const [tick, setTick] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState(null)
      const [data, setData] = React.useState(null)
      const dataRef = React.useRef(null)
      const [pickedWorkspace, setPickedWorkspace] = React.useState(null)
      const [pickedFile, setPickedFile] = React.useState(null)
      const [fileState, setFileState] = React.useState({ status: 'idle', error: null, value: null })
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
      const selected = (() => {
        if (workspaces.length === 0) return null
        const exact = workspaces.filter((entry) => entry.path === pickedWorkspace)
        return exact.length > 0 ? exact[0] : workspaces[0]
      })()
      const selectedFile = (() => {
        if (selected === null || selected.files.length === 0) return null
        const exact = selected.files.filter((file) => file.name === pickedFile)
        return exact.length > 0 ? exact[0] : selected.files[0]
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
        h(PageHead, { t, busy, onRefresh: refresh, config }),
        h(ConfigBar, { t, config }),
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
              },
            }),
            h(FileColumn, {
              t,
              selected,
              selectedFile,
              fileState,
              onPickFile: setPickedFile,
              onReload: () => setTick((value) => value + 1),
            })))
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
      const files = asArray(selected.files)
      return h('div', { className: 'dwm-col' },
        h('h2', { className: 'dwm-col-title' },
          t('catalog.files') + ' · ' + t('catalog.fileCount', { n: files.length })),
        h('ul', { className: 'dwm-list' }, files.map((file) => h('li', { key: file.name },
          h('button', {
            type: 'button',
            className: 'dwm-item' + (props.selectedFile !== null && props.selectedFile !== undefined
              && props.selectedFile.name === file.name ? ' is-active' : ''),
            onClick: () => props.onPickFile(file.name),
          },
            h('span', { className: 'dwm-item-name' },
              h('span', { className: 'dwm-badge' + (file.kind === 'index' ? ' is-index' : '') },
                t(file.kind === 'index' ? 'catalog.index' : 'catalog.fact')),
              h('span', null, file.name),
              h('span', { className: 'dwm-badge' }, formatBytes(file.size))),
            h('span', { className: 'dwm-item-meta' },
              t('state.updatedAt', { time: formatRelative(file.updatedAt, t) })))))),
        h('div', { className: 'dwm-panel' },
          h('p', { className: 'dwm-path' },
            t('catalog.memoryRoot', {
              path: selected.memoryRoot !== '' && selected.memoryRoot !== undefined
                ? selected.memoryRoot
                : selected.path,
            })),
          h(FileBody, { t, file: props.selectedFile, state: props.fileState, onReload: props.onReload })))
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

    function PageHead(props) {
      const t = props.t
      return h('header', { className: 'dwm-head' },
        h('div', { className: 'dwm-headtext' },
          h('h1', { className: 'dwm-title' }, t('title')),
          h('p', { className: 'dwm-sub' }, t('subtitle'))),
        h('div', { className: 'dwm-headtools' },
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
      return h('div', { className: 'dwm-config' },
        h('span', { className: 'dwm-chips' },
          h(Chip, {
            tone: config.enabled === true ? 'on' : 'off',
            text: t(config.enabled === true ? 'config.enabledOn' : 'config.enabledOff'),
          }),
          h(Chip, {
            tone: config.autoExtract === true ? 'on' : 'warn',
            text: t(config.autoExtract === true ? 'config.autoExtractOn' : 'config.autoExtractOff'),
          })),
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
        sortFiles,
        formatBytes,
        formatRelative,
        describeError,
        errorText,
        makeT,
        MemoryIcon,
        Chip,
        StateBlock,
        PageHead,
        ConfigBar,
        WorkspaceColumn,
        FileColumn,
        FileBody,
        MemoryPage,
      },
    }
  },
})
