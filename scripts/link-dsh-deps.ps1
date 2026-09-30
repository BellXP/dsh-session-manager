# link-dsh-deps.ps1 —— 重建 host 半的 @deepseek-ai 运行时依赖 junction。
#
# dsh-session-manager 的 host 半（lib/index.js）静态导入三个包：
#   @deepseek-ai/cordis / @deepseek-ai/dsh-typert-protocol / @deepseek-ai/dsh-home-paths
# 它们不随本仓库分发，而是通过 node_modules\@deepseek-ai junction 指向本机
# dsh 安装的包树（与宿主进程共享同一份模块实例）。克隆后或 dsh 升级
# （npx 缓存目录变化）后运行本脚本即可重建。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\link-dsh-deps.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\link-dsh-deps.ps1 -DshRoot "D:\somewhere\dsh"
param(
  # 可选：dsh 安装根（其下须有 node_modules\@deepseek-ai）。缺省时自动探测
  # npx 缓存（最新一份）与 npm 全局安装。
  [string]$DshRoot = ""
)
$ErrorActionPreference = 'Stop'

function Find-DshPackageTree {
  if ($DshRoot -ne "") {
    $target = Join-Path $DshRoot "node_modules\@deepseek-ai"
    if (-not (Test-Path (Join-Path $target "dsh-typert-protocol"))) {
      throw "指定的 -DshRoot 下找不到 @deepseek-ai/dsh-typert-protocol：$target"
    }
    return (Resolve-Path $target).Path
  }
  # 1) npx 缓存：取含完整 @deepseek-ai 树的最新一份
  $npxCache = Join-Path $env:LOCALAPPDATA "npm-cache\_npx"
  if (Test-Path $npxCache) {
    $hit = Get-ChildItem $npxCache -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName "node_modules\@deepseek-ai\dsh-typert-protocol") } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit) { return (Resolve-Path (Join-Path $hit.FullName "node_modules\@deepseek-ai")).Path }
  }
  # 2) npm 全局
  $globalRoot = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai"
  if (Test-Path (Join-Path $globalRoot "dsh-typert-protocol")) { return (Resolve-Path $globalRoot).Path }
  throw "找不到本机 dsh 安装（探测过：$npxCache 与 npm 全局）。请用 -DshRoot 显式指定。"
}

$target = Find-DshPackageTree
$link = Join-Path $PSScriptRoot "..\node_modules\@deepseek-ai"
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "junction 已重建：$link -> $target"
