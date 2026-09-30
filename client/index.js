/**
 * dsh-session-manager — client half.
 *
 * 官方 client 插件形态（window.__ModuleLoader__.load({id, factory(require)})，
 * factory 自包含，require 只解析 shell 种子：react / @deepseek-ai/dsh-client-ui-primitives
 * 等；**不使用 JSX**）。
 *
 * - 会话行菜单（sidebar.workspaces.session.menu.item，order 500）追加一项
 *   「删除会话…」（垃圾桶图标）；
 * - shell.overlay 注册确认弹窗（永久删除警告 + 会话标题），确认后经 Typert
 *   remote（ctx.get('remote.session-manager').deleteSession）调 host 半删磁盘日志；
 * - 删除成功后调 sessions.refresh() 重拉会话基线（host 的 session.list 每次
 *   现扫描磁盘，行随即消失；FTS 索引由 host 下次检索时自动 reconcile）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-manager', // must equal the package name (loader contract)
  factory(require) {
    const React = require('react')
    const { useState } = React
    const h = React.createElement
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    // ------------------------------------------------------------ typert

    const REMOTE_PACKAGE = 'dsh-session-manager' // 与 lib/index.js 的 PACKAGE 一致
    const REMOTE_NAMESPACE = 'session-manager'

    // strict codec 需要 typeSymbol + create() 工厂；透传 schema，真实校验在
    // host 半服务里（与 host contribution 的 SRC_JSON 对齐）。
    const PASSTHROUGH_SCHEMA = {
      '~standard': { version: 1, vendor: 'schemastery', validate: (value) => ({ value }) },
    }
    function paramCodec(name) {
      return { mode: 'strict', typeSymbol: REMOTE_PACKAGE + '#' + name, create: () => PASSTHROUGH_SCHEMA }
    }
    const CLIENT_TYPERT_REMOTE = {
      package: REMOTE_PACKAGE,
      schemas: ['sessionId', 'wait'].map((name) => ({ name, create: () => PASSTHROUGH_SCHEMA })),
      descriptors: [
        {
          id: REMOTE_PACKAGE + '#' + REMOTE_NAMESPACE + '/deleteSession',
          service: REMOTE_NAMESPACE,
          namespace: REMOTE_NAMESPACE,
          method: 'deleteSession',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: paramCodec('sessionId') },
            { name: 'wait', wire: 'wait', source: 'json', codec: paramCodec('wait') },
          ],
          result: { mode: 'src-json' },
        },
      ],
    }

    function unwrap(res, fallback) {
      if (res && typeof res === 'object' && res.ok === true) return res.value
      return fallback
    }
    function resError(res, fallback) {
      const e = res && typeof res === 'object' ? res.error : null
      return (e && typeof e === 'object' && typeof e.message === 'string' && e.message) || fallback
    }
    /** typert 调用超时保护：宿主侧挂起时给出可见错误，而不是无限转圈。 */
    function withTimeout(promise, ms, label) {
      const guarded = Promise.resolve(promise)
      guarded.catch(() => {})
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超时（请检查服务器是否可达）')), ms)
      })
      return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer))
    }

    // ---------------------------------------------------------------- css

    const CSS = `
.dsm-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.dsm-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsm-status { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dsm-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; margin: 0; }
.dsm-note { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.7; margin: 0; }
`

    // ------------------------------------------------------------ pieces

    /**
     * 菜单项（order 500）：删除会话…；点击只弹出确认请求，真正动作在
     * shell.overlay 的对话框里。
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(P.MenuItemButton, {
        icon: h(P.IconTrashOutlineRegular, {}),
        onSelect: () => {
          setMenuOpen(false)
          requestSessionDelete(sessionId, displayTitle)
        },
      }, t('menu.delete'))
    }

    /**
     * shell.overlay 条目：无待确认请求时不渲染，否则一个 Modal。确认后调
     * host 删除 → 刷新会话列表；live 拒绝时进入二段「停止并删除」；取消
     * 则原样关闭。
     */
    function SessionDeleteConfirmDialog({ useDeleteRequest, settleSessionDelete, deleteSession, stopAndDelete, isLiveRefusal, t }) {
      const request = useDeleteRequest((pending) => pending)
      if (request === null) return null
      return h(DeleteConfirmForm, {
        key: request.sessionId,
        request,
        settleSessionDelete,
        deleteSession,
        stopAndDelete,
        isLiveRefusal,
        t,
      })
    }

    /**
     * 单个请求的对话框：in-flight 与错误状态随其消亡。两段式：
     * confirm —— 常规确认；live 拒绝后进入 stop —— 「停止并永久删除」。
     */
    function DeleteConfirmForm({ request, settleSessionDelete, deleteSession, stopAndDelete, isLiveRefusal, t }) {
      const [busy, setBusy] = useState(false)
      const [stage, setStage] = useState('confirm')
      const [error, setError] = useState(null)
      const close = () => {
        if (busy) return
        settleSessionDelete()
      }
      const confirm = () => {
        setBusy(true)
        setError(null)
        deleteSession(request.sessionId).then(() => {
          setBusy(false)
          settleSessionDelete()
        }).catch((reason) => {
          setBusy(false)
          const message = reason instanceof Error ? reason.message : String(reason)
          if (isLiveRefusal(message)) setStage('stop')
          else setError(message)
        })
      }
      const stopDelete = () => {
        setBusy(true)
        setError(null)
        stopAndDelete(request.sessionId).then(() => {
          setBusy(false)
          settleSessionDelete()
        }).catch((reason) => {
          setBusy(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      return h(P.Modal, {
        open: true,
        onClose: close,
        closeLabel: t('close'),
        title: t('confirm.title'),
        description: t('confirm.desc', { title: request.displayTitle }),
        footer: h(React.Fragment, null,
          h(P.Button, { variant: 'outline', disabled: busy, onClick: close }, t('cancel')),
          stage === 'stop'
            ? h(P.Button, { variant: 'outline', className: 'dsm-danger', disabled: busy, onClick: stopDelete }, t('stop.action'))
            : h(P.Button, { variant: 'outline', className: 'dsm-danger', disabled: busy, onClick: confirm }, t('confirm.action'))),
      },
      h('p', { className: 'dsm-note' }, stage === 'stop' ? t('stop.note') : t('confirm.note')),
      busy && h('div', { className: 'dsm-status', role: 'status' }, stage === 'stop' ? t('stop.pending') : t('confirm.pending')),
      error !== null && h('div', { className: 'dsm-error', role: 'alert' }, error))
    }

    // -------------------------------------------------------------- apply

    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (error) {
        console.error('[dsh-session-manager] client apply failed:', error)
      }
    }

    function applyInner(ctx) {
      const styleEl = document.createElement('style')
      styleEl.dataset.pluginCss = 'dsh-session-manager/client'
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-session-manager: css')

      // 待确认删除请求（一次一个，与官方归档确认同款形态）。
      let deleteRequest = null
      const requestListeners = new Set()
      const notifyRequest = () => { for (const listener of requestListeners) listener() }
      const useDeleteRequest = (select) => React.useSyncExternalStore(
        (listener) => { requestListeners.add(listener); return () => { requestListeners.delete(listener) } },
        () => select(deleteRequest),
      )

      // 远程面：host 半未就绪时给出可见错误，绝不 undefined.method 崩溃。
      let mounted = false
      const svc = () => {
        const s = ctx.get('remote.session-manager')
        if (!s) throw new Error('会话管理服务未就绪（插件 host 半未加载），请重启 dsh web 后重试')
        return s
      }
      ctx.effect(async () => {
        const disposer = await ctx.remote.$mount(CLIENT_TYPERT_REMOTE)
        mounted = true
        return disposer
      }, 'dsh-session-manager: typert mount')

      const sessions = () => ctx.get('sessions')
      const refreshList = () => {
        const service = sessions()
        if (service === undefined || typeof service.refresh !== 'function') return
        try { void service.refresh() } catch { /* 刷新失败不影响删除结果本身 */ }
      }

      /** host 拒绝消息里的机器可识别前缀（live 会话两段式流程的判据）。 */
      const isLiveRefusal = (message) => typeof message === 'string' && message.startsWith('[session-live]')

      const callDelete = async (sessionId, wait) => {
        const res = await withTimeout(svc().deleteSession(sessionId, wait === true), wait ? 45_000 : 30_000, '删除会话')
        const value = unwrap(res, null)
        if (value === null) throw new Error(resError(res, '删除会话失败'))
        return value
      }

      const deleteSession = async (sessionId) => {
        const value = await callDelete(sessionId, false)
        refreshList()
        return value
      }

      /**
       * 二段式「停止并删除」：官方 workspaces 通道 `archiveSession(id,
       * {stopActivity:true})` 停掉运行中的工作并归档 —— ui-workspace 监听
       * 归档集自动关闭其主视图，客户端引用归零后 host 侧会话自然离场；
       * 随后以 wait=true 调本插件 host 端点，轮询等待离场后删除磁盘日志；
       * 最后清理归档集合残留（删除失败则回滚归档，保持会话可见可恢复）。
       */
      const stopAndDelete = async (sessionId) => {
        const workspaces = ctx.get('workspaces')
        if (workspaces === undefined || typeof workspaces.archiveSession !== 'function') {
          throw new Error('workspaces 模型不可用，无法执行停止并删除 / workspaces model unavailable')
        }
        await workspaces.archiveSession(sessionId, { stopActivity: true })
        try {
          const value = await callDelete(sessionId, true)
          try { await workspaces.unarchiveSession(sessionId) } catch { /* 会话已删，清理集合残留失败无害 */ }
          refreshList()
          return value
        } catch (error) {
          try { await workspaces.unarchiveSession(sessionId) } catch { /* 回滚尽力而为 */ }
          throw error
        }
      }

      const injected = () => ({
        useDeleteRequest,
        settleSessionDelete: () => {
          if (deleteRequest === null) return
          deleteRequest = null
          notifyRequest()
        },
        requestSessionDelete: (sessionId, displayTitle) => {
          deleteRequest = { sessionId, displayTitle: displayTitle ?? sessionId }
          notifyRequest()
        },
        deleteSession,
        stopAndDelete,
        isLiveRefusal,
      })

      ctx.effect(() => ctx.locale.register('session-manager', {
        zh: {
          'menu.delete': '删除会话…',
          'confirm.title': '删除会话',
          'confirm.desc': '将永久删除「{title}」',
          'confirm.note': '该会话的完整对话记录将从磁盘日志中永久移除（不可恢复，回收站里也没有）。',
          'confirm.action': '永久删除',
          'confirm.pending': '正在删除…',
          'stop.note': '该会话当前处于打开或运行状态。继续将停止其运行中的任务、关闭其打开的视图，然后永久删除磁盘日志（不可恢复）。',
          'stop.action': '停止并永久删除',
          'stop.pending': '正在停止并删除…',
          cancel: '取消',
          close: '关闭',
        },
        en: {
          'menu.delete': 'Delete session…',
          'confirm.title': 'Delete session',
          'confirm.desc': 'Permanently delete "{title}"',
          'confirm.note': 'The full conversation log of this session will be permanently removed from disk (unrecoverable, no trash).',
          'confirm.action': 'Delete permanently',
          'confirm.pending': 'Deleting…',
          'stop.note': 'This session is currently open or running. Continuing will stop its running work, close its open view, then permanently remove the disk log (unrecoverable).',
          'stop.action': 'Stop and delete permanently',
          'stop.pending': 'Stopping and deleting…',
          cancel: 'Cancel',
          close: 'Close',
        },
      }), 'dsh-session-manager: dictionaries')

      // 会话行菜单项（官方项：置顶 100 / 重命名 200 / fork 300 / 归档 400）。
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'delete',
        order: 500,
        locale: 'session-manager',
        inject: injected,
      }, DeleteSessionMenuItem))

      // 确认对话框挂在 shell overlay。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-manager.delete',
        locale: 'session-manager',
        inject: injected,
      }, SessionDeleteConfirmDialog))

      // 挂载状态仅用于错误信息可观测性。
      void mounted
    }

    return { apply, inject: ['slots', 'locale', 'remote', 'sessions'] }
  },
})
