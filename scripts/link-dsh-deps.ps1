# link-dsh-deps.ps1 - rebuild the host-half @deepseek-ai dependency junction.
# lib/index.js statically imports @deepseek-ai packages that are not shipped with
# this repo; node_modules/@deepseek-ai is a junction to the local dsh install's
# package tree. Re-run after cloning or after a dsh upgrade moves the npx cache.
param(
  [string]$DshRoot = ""
)
$ErrorActionPreference = 'Stop'

function Find-DshPackageTree {
  if ($DshRoot -ne "") {
    $target = Join-Path $DshRoot "node_modules\@deepseek-ai"
    if (-not (Test-Path (Join-Path $target "dsh-typert-protocol"))) {
      throw "dsh-typert-protocol not found under -DshRoot: $target"
    }
    return (Resolve-Path $target).Path
  }
  $npxCache = Join-Path $env:LOCALAPPDATA "npm-cache\_npx"
  if (Test-Path $npxCache) {
    $hit = Get-ChildItem $npxCache -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName "node_modules\@deepseek-ai\dsh-typert-protocol") } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit) { return (Resolve-Path (Join-Path $hit.FullName "node_modules\@deepseek-ai")).Path }
  }
  $globalRoot = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai"
  if (Test-Path (Join-Path $globalRoot "dsh-typert-protocol")) { return (Resolve-Path $globalRoot).Path }
  throw "No local dsh install found (probed: $npxCache and npm global). Pass -DshRoot explicitly."
}

$target = Find-DshPackageTree
$link = Join-Path $PSScriptRoot "..\node_modules\@deepseek-ai"
$linkDir = Split-Path $link -Parent
if (-not (Test-Path $linkDir)) { New-Item -ItemType Directory -Path $linkDir -Force | Out-Null }
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "junction rebuilt: $link -> $target"
