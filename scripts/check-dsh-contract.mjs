#!/usr/bin/env node
/**
 * dsh-session-manager — dsh 契约探针（升级雷达）。
 *
 * 检查本插件依赖的 dsh 表面：typert 注册面、会话存储布局（projectKey/
 * encodeSegment 与目录名实测锚点）、client 插槽与 sessions 服务面。
 *
 * 用法：
 *   node scripts/check-dsh-contract.mjs                              # 默认本仓库链接的 dsh 树
 *   node scripts/check-dsh-contract.mjs <dsh树/@deepseek-ai目录>      # 升级前预检
 * 退出码：0 = 无断开；1 = 有 FAIL。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const defaultTree = path.join(repo, 'node_modules', '@deepseek-ai')
const tree = path.resolve(process.argv[2] ?? defaultTree)

const results = []
const check = (id, ok, detail = '') => results.push({ id, ok: ok === true, detail })
const skip = (id, detail) => results.push({ id, ok: true, skip: true, detail })

if (!existsSync(tree)) {
  console.error(`dsh tree not found: ${tree}（先跑 scripts/link-dsh-deps.ps1|.sh，或传入 dsh 树路径）`)
  process.exit(1)
}
const pkgDir = (name) => path.join(tree, name)
const distText = (name, ...files) => {
  for (const file of files) {
    try { return readFileSync(path.join(pkgDir(name), file), 'utf8') } catch { /* 下一个 */ }
  }
  return undefined
}
const probe = (name, id, assert) => {
  if (!existsSync(pkgDir(name))) { skip(id, `${name} 不在本树`); return }
  const text = distText(name, 'lib/client.js', 'lib/index.js')
  if (text === undefined) { check(id, false, `${name}: dist 不可读`); return }
  check(id, assert(text))
}

console.log(`dsh-session-manager 契约探针 — 树: ${tree}\n`)

// ------------------------------------------------------------- host 契约

try {
  const anchored = createRequire(path.join(repo, 'scripts', 'check-dsh-contract.mjs'))
  const typert = anchored(path.join(pkgDir('dsh-typert-protocol'), 'lib', 'index.js'))
  check('host/dsh-typert-protocol: bindTypertRemote 导出（client↔host 通道）',
    typeof typert.bindTypertRemote === 'function')
} catch (error) {
  check('host/dsh-typert-protocol: 可加载', false, String(error instanceof Error ? error.message : error))
}

// projectKey 实测锚点：本机磁盘上观察到的真实目录名（Windows 占位 cwd）。
// dsh 若改编码算法，此锚点先红——升级时据此同步 lib/index.js 的重实现。
{
  const libPath = path.join(repo, 'lib', 'index.js')
  const libSrc = readFileSync(libPath, 'utf8')
  const module_ = await import(`file://${libPath.replaceAll('\\', '/')}`).catch(() => undefined)
  const projectKey = module_?.__test?.projectKey
  if (typeof projectKey === 'function') {
    const cases = [
      ['C:\\Users\\x00968307\\.dsh\\remote\\MANote-W8-00\\L2hvbWUvbWEtdXNlci94MDA5NjgzMDc', '--C-Users-x00968307-.dsh-remote-MANote-W8-00-L2hvbWUvbWEtdXNlci94MDA5NjgzMDc--'],
      ['/home/dev/project', '--home-dev-project--'],
    ]
    const bad = cases.filter(([cwd, key]) => projectKey(cwd) !== key)
    check('host/存储编码: projectKey 与实测目录名锚点一致（win+posix cwd）', bad.length === 0,
      bad.map(([cwd]) => `mismatch: ${cwd}`).join('; '))
  } else {
    check('host/存储编码: lib/index.js 暴露 __test.projectKey（探针前置）',
      libSrc.includes('projectKey'), 'lib 未导出 __test 面——请补导出后重跑')
  }
}

// 存储布局指纹：dsh-session-persistence-jsonl 的目录/压缩布局（跨 index.js+worker.cjs）。
{
  const name = 'dsh-session-persistence-jsonl'
  if (!existsSync(pkgDir(name))) {
    skip('host/persistence: jsonl.zstd 分段布局（session.vN.jsonl.zstd）', `${name} 不在本树`)
  } else {
    const text = [distText(name, 'lib/index.js'), distText(name, 'lib/worker.cjs')].filter((t) => t !== undefined).join('\n')
    check('host/persistence: jsonl.zstd 分段布局（session.vN.jsonl.zstd）',
      text.includes('jsonl.zstd') && text.includes('session.v'))
  }
}

// ------------------------------------------------------------ client 契约

const runnerContracts = [
  ['sidebar.workspaces.session.menu.item', '会话 ⋯ 菜单项（删除入口）'],
  ['shell.overlay', '确认弹窗宿主'],
]
for (const [key, note] of runnerContracts) {
  probe('dsh-cordis-client-runner', `client/slot: ${key}（${note}）`,
    (t) => t.includes(key))
}
probe('dsh-api-session-controller', 'client/sessions: handleSessionRemoved（幽灵行摘除）',
  (t) => t.includes('handleSessionRemoved'))
probe('dsh-api-session-controller', 'client/sessions: refresh（删除后列表刷新）',
  (t) => t.includes('refresh'))
probe('dsh-client-ui-workspace', 'client/workspaces: archiveSession + stopActivity（停并删通道）',
  (t) => t.includes('archiveSession') && t.includes('stopActivity'))

// ------------------------------------------------------------------ 报告

let failed = 0
let skipped = 0
for (const { id, ok, skip: isSkip, detail } of results) {
  if (isSkip === true) skipped += 1
  if (!ok) failed += 1
  const tag = isSkip === true ? '[skip]' : ok ? '[ ok ]' : '[FAIL]'
  console.log(`${tag} ${id}${detail === '' || detail === undefined ? '' : ` — ${detail}`}`)
}
console.log(`\n${results.length - failed}/${results.length} 契约通过（${skipped} 条 SKIP）${failed === 0 ? '' : `，${failed} 条断开`}`)
process.exit(failed === 0 ? 0 : 1)
