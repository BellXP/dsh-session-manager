#!/usr/bin/env bash
# link-dsh-deps.sh —— 重建 host 半的 @deepseek-ai 运行时依赖符号链接（Linux / macOS）。
#
# dsh-session-manager 的 host 半（lib/index.js）静态导入三个包：
#   @deepseek-ai/cordis / @deepseek-ai/dsh-typert-protocol / @deepseek-ai/dsh-home-paths
# 它们不随本仓库分发，而是通过 node_modules/@deepseek-ai 符号链接指向本机
# dsh 安装的包树（与宿主进程共享同一份模块实例）。克隆后或 dsh 升级
# （npx 缓存目录变化）后运行本脚本即可重建。Windows 请用同目录的
# link-dsh-deps.ps1。
#
# 用法：
#   bash scripts/link-dsh-deps.sh             # 自动探测（npx 缓存 → npm 全局）
#   bash scripts/link-dsh-deps.sh -d <dsh根>  # 显式指定（其下须有 node_modules/@deepseek-ai）
set -euo pipefail

DSH_ROOT=""
while getopts "d:" opt; do
  case "$opt" in
    d) DSH_ROOT="$OPTARG" ;;
    *) echo "usage: $0 [-d <dshRoot>]" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
link_dir="$here/../node_modules/@deepseek-ai"

need_pkg="dsh-typert-protocol"

resolve_target() {
  if [ -n "$DSH_ROOT" ]; then
    local t="$DSH_ROOT/node_modules/@deepseek-ai"
    if [ ! -d "$t/$need_pkg" ]; then
      echo "指定的 -d 路径下找不到 @deepseek-ai/$need_pkg：$t" >&2
      exit 1
    fi
    (cd "$t" && pwd)
    return
  fi
  # 1) npx 缓存：取修改时间最新且含完整 @deepseek-ai 树的一份
  local npx_root="$HOME/.npm/_npx"
  if [ -d "$npx_root" ]; then
    local entry best=""
    for entry in $(ls -1t "$npx_root" 2>/dev/null); do
      if [ -d "$npx_root/$entry/node_modules/@deepseek-ai/$need_pkg" ]; then
        best="$npx_root/$entry/node_modules/@deepseek-ai"
        break
      fi
    done
    if [ -n "$best" ]; then
      (cd "$best" && pwd)
      return
    fi
  fi
  # 2) npm 全局安装
  if command -v npm >/dev/null 2>&1; then
    local global_root
    global_root="$(npm root -g 2>/dev/null || true)/@deepseek-ai"
    if [ -d "$global_root/$need_pkg" ]; then
      (cd "$global_root" && pwd)
      return
    fi
  fi
  echo "找不到本机 dsh 安装（探测过：$npx_root 与 npm 全局）。请用 -d 显式指定。" >&2
  exit 1
}

target="$(resolve_target)"
mkdir -p "$(dirname "$link_dir")"
if [ -e "$link_dir" ] || [ -L "$link_dir" ]; then
  rm -rf "$link_dir"
fi
ln -s "$target" "$link_dir"
echo "符号链接已重建：$link_dir -> $target"
