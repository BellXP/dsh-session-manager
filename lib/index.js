/**
 * dsh-session-manager — host half.
 *
 * 一个 Typert 远程端点（face:'host'）：`session-manager/deleteSession(sessionId)`
 * —— 永久删除一个会话的磁盘日志目录（~/.dsh/sessions/<项目目录>/<会话id>/）。
 *
 * 安全边界：
 * 1. 拒绝删除 live 会话（AgentRegistry 里还挂着的会话必须先停止）；
 * 2. 会话必须在持久化盘上存在（sessionPersistence.list 找到 header）；
 * 3. 目标路径由持久化层的规范转义算法（projectKey + encodeSegment，与
 *    @deepseek-ai/dsh-session-persistence-jsonl 的实现逐字一致）从 header
 *    派生，并做「必须位于 sessions root 之内」的包含性校验；
 * 4. 只删除该会话自己的目录（不做任何通配/递归祖先删除）。
 *
 * 删除后的连锁一致性问题不需要本插件处理：
 * - 会话列表：session.list 每次经 sessionQuery → persistence.list 现扫描磁盘；
 * - FTS 搜索索引（SQLite）：下次检索 reconcile 时自动清掉消失的行；
 * - 工作区 pinned/archived 元数据中的残留 id 无行可指，呈惰性。
 */

import { Service } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** npm 包名（typert 描述符 id 前缀）。 */
const PACKAGE = 'dsh-session-manager'
/** Cordis 服务 key 与 wire 命名空间（client 侧 ctx.get('remote.session-manager')）。 */
const SERVICE = 'session-manager'
const NAMESPACE = 'session-manager'

/** src-json 透传 codec（真实校验在本服务内）。 */
const SRC_JSON = { mode: 'src-json' }

/** ---------------------------------------------------------------- paths */

/**
 * 把任意字符串编码成单个安全路径段（与 dsh-session-persistence-jsonl 的
 * encodeSegment 逐字一致：安全码位原样，其余按码位 ~XXXX 大写十六进制转义；
 * "." 与 ".." 整段特判防穿越）。
 * @param {string} raw - 原始段（非空）。
 * @returns {string} 转义后的单个安全路径段。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 项目路径 → 可读目录键（与 dsh-session-persistence-jsonl 的 projectKey 逐字
 * 一致：分隔符折叠为 '-'，非安全码位同样 ~XXXX，截断到 251，-- 包裹）。
 * @param {string} cwd - 会话的项目目录。
 * @returns {string} 项目目录名。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** ------------------------------------------------------------- typert */

/** 一个 host 半 invocation 描述符（strict local 注册表形状）。 */
function hostInvocation(method, parameters) {
  return {
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: SERVICE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({ name, wire: name, source: 'json', codec: SRC_JSON })),
    result: SRC_JSON,
  }
}

/** host 半贡献（ctx.typert.register 消费；face:'host' + invocations）。 */
const HOST_TYPERT_CONTRIBUTION = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    hostInvocation('deleteSession', ['sessionId', 'wait', 'force']),
  ],
  model: undefined,
}

/** ------------------------------------------------------------- service */

/**
 * 会话删除远程服务。端点返回裸业务值（gateway 已用 {ok, value} 表达成败），
 * 业务失败直接 throw（gateway 捕获转 {ok:false, error:{message}}）。
 */
class SessionManagerService extends Service {
  /** 宿主 ctx（sessions / sessionPersistence 等可选服务经 ctx.get 读取）。 */
  /** 绑定声明——gateway validateBinding 按此反射名检查，不可改名。 */
  typertRemote

  constructor(ctx) {
    super(ctx, SERVICE)
    this.typertRemote = bindTypertRemote(this, SERVICE)
  }

  /**
   * 永久删除一个会话的磁盘日志目录。
   *
   * live 会话分两段：首次调用不带 `wait` 直接拒绝（消息带 `[session-live]`
   * 前缀，client 据此进入「停止并删除」二段流程：先经官方 workspaces 模型
   * `archiveSession(id, {stopActivity:true})` 停掉运行中的工作并让
   * ui-workspace 自动关闭其主视图，引用归零后 host 侧会话自然离场）；随后
   * client 以 `wait=true` 重发，本端点轮询等待其离开注册表再落删。
   *
   * 二段超时且会话**空闲**时，client 可进入三段「强制删除」：`force=true`
   * 跳过 live 门（删除前复查 agent 确非 running）。磁盘日志照删；仍在注册
   * 表里的内存 agent 成为幽灵——列表行由 client 侧 handleSessionRemoved
   * 即时摘除，进程重启后彻底消失。运行中的会话一律拒绝 force。
   *
   * @param {string} sessionId - 要删除的 Session 标识。
   * @param {boolean} [wait] - live 时轮询等待其离场（最长 60s）而不是立刻拒绝。
   * @param {boolean} [force] - 空闲但无法离场的会话跳过 live 门强制删除。
   * @returns {{ sessionId: string, path: string, forced?: boolean }} 删除结果（JSON-safe）。
   */
  async deleteSession(sessionId, wait, force) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId 必须是非空字符串 / sessionId must be a non-empty string')
    }

    // 1) live 会话：立刻拒绝（带机器可识别前缀）或按 wait 轮询等待离场。
    //    等待上限 60s：stopActivity 的停止是后台收敛的，慢速/挂起的远程任务
    //    （如 SSH 上的长命令）可能需要可观时间才让 Agent 退出。
    let forced = false
    const registry = this.ctx.get('sessions')
    if (registry !== undefined && registry.get(sessionId) !== undefined) {
      const agentStatus = () => {
        const agents = this.ctx.get('agents')
        return agents?.get?.(sessionId)?.status
      }
      if (force === true) {
        // 三段强制：仅空闲会话放行（运行中一律拒绝，防删到写入中的日志）。
        const status = agentStatus()
        if (status === 'running') {
          throw new Error(`[session-live] 强制删除被拒绝：会话正在运行，须先停止 / session "${sessionId}" is running; force delete refused`)
        }
        forced = true
      } else if (wait !== true) {
        throw new Error(`[session-live] 会话正在运行或已打开，需先停止 / session "${sessionId}" is live; stop it before deleting`)
      } else {
        const deadline = Date.now() + 60_000
        while (registry.get(sessionId) !== undefined) {
          if (Date.now() >= deadline) {
            // 超时成因判别：running = 停止尚未收敛（慢任务）；否则 = 空闲但仍被
            // 某个连接持有（最常见：别的浏览器标签页 / 桌面端窗口开着这个会话）。
            const status = agentStatus()
            const cause = status === 'running'
              ? '其运行中的任务尚未停止完毕（可能有慢速或挂起的远程命令）——稍后重试通常即可'
              : '它处于空闲但仍有别的连接/机制持有它（请检查是否在其他浏览器标签页或桌面端窗口打开着该会话；若都关了仍超时，可在本弹窗选择强制删除）'
            throw new Error(`[session-live] 等待超时（60s）：${cause} / session "${sessionId}" is still live (agent status: ${String(status)})`)
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    }

    // 2) 在持久化盘上定位 header（拿 cwd 才能算出目录）。
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('sessionPersistence 服务不可用 / session persistence is unavailable')
    }
    const snapshots = await persistence.list()
    const snapshot = snapshots.find((candidate) => candidate.header.id === sessionId)
    if (snapshot === undefined) {
      throw new Error(`磁盘上找不到该会话 / session "${sessionId}" is not persisted`)
    }
    const header = snapshot.header

    // 3) 规范转义派生目录 + 包含性校验。
    const sessionsRoot = resolve(dshHomePath('sessions'))
    const project = header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd)
    const dir = resolve(join(sessionsRoot, project, encodeSegment(sessionId)))
    if (!dir.startsWith(sessionsRoot + sep)) {
      throw new Error('派生路径越界，拒绝删除 / derived path escapes the sessions root; refusing')
    }

    // 4) 存在性检查 + 删除。
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) {
        throw new Error(`目标不是目录 / "${dir}" is not a session directory`)
      }
    } catch (error) {
      if (error !== undefined && error !== null && error.code === 'ENOENT') {
        throw new Error(`会话日志目录不存在 / session directory "${dir}" does not exist`)
      }
      throw error
    }
    await rm(dir, { recursive: true, force: false })

    return { sessionId, path: dir, ...(forced ? { forced: true } : {}) }
  }
}

/** -------------------------------------------------------------- plugin */

/** Stable cordis plugin name. */
export const name = 'session-manager'

/** 端点挂载延迟到 typert 可用（无 typert 的组合静默跳过）。 */
export const inject = []

/**
 * Host plugin body：注册 typert 贡献并启动远程服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['typert'], (scope) => {
    scope.typert.register(HOST_TYPERT_CONTRIBUTION)
    // eslint-disable-next-line no-new -- cordis Service 随 fiber 生命周期管理
    new SessionManagerService(scope)
    scope.logger?.info?.('[dsh-session-manager] typert remote session-manager registered')
    console.log('[dsh-session-manager] host half loaded (typert endpoint ready)')
  })
}
