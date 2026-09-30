# dsh-session-manager

DeepSeek Harness (DSH) Web GUI 的 **会话删除**：在侧栏会话行菜单追加「删除会话…」，
确认后永久删除该会话的磁盘日志目录。

## 功能

- 会话行右键/⋯菜单新增 **删除会话…**（官方项之后：置顶 / 重命名 / fork / 归档 / **删除**）。
- 确认弹窗明示不可恢复；确认后：
  1. host 半经 Typert 端点 `session-manager/deleteSession` 定位并删除
     `~/.dsh/sessions/<项目目录>/<会话id>/`；
  2. client 半调 `sessions.refresh()` 重拉基线，行从侧栏消失；
  3. FTS 搜索索引（SQLite）在下次检索 reconcile 时自动清掉该行。

## 安全边界（host 半）

1. **live 会话两段式**：直接删除 live（打开中/运行中）会话会被拒绝（消息带
   `[session-live]` 前缀）；确认弹窗随即进入二段「停止并永久删除」——
   - 先走**官方通道** `workspaces.archiveSession(id, {stopActivity:true})`：停掉
     运行中的任务（turn/subagent/job/schedule），ui-workspace 监听归档集自动
     关闭其主视图，客户端引用归零后 host 侧会话自然离场；
   - 再以 `wait=true` 调删除端点：host 轮询等待会话离开注册表（最长 20s）后落删；
   - 删除失败自动回滚归档，保持会话可见可恢复；
2. 会话必须在持久化盘上存在（`sessionPersistence.list` 定位 header）；
3. 目录路径由持久化层规范转义算法（`projectKey` + `encodeSegment`，与
   `@deepseek-ai/dsh-session-persistence-jsonl` 逐字一致）派生，并做
   「必须位于 sessions root 之内」包含性校验；
4. 只删除该会话自己的目录；fork/子代理等派生会话不受影响（默认仅删选中的那个）。

> 兼容性：已在 dsh **0.1.7-rc.2** 与 **0.2.0-rc.2** 上核对（路径算法、sessions root、
> typert/主题/槽位/原语导出均一致）。本插件未声明 peerDependencies，不走版本门禁。

## 结构

```
lib/index.js     host 半：Typert 端点 + 删除服务（依赖见 node_modules junction）
client/index.js  client 半：菜单项 + 确认弹窗 + 列表刷新
cordis.patch.yml bundle 插入行
```

## 平台支持（Windows / Linux / macOS）

插件代码本身零平台耦合：host 半只用 `node:fs`/`node:path` 与 `@deepseek-ai/dsh-home-paths`
（遵循 `DSH_HOME` 环境变量），会话目录的转义算法（`projectKey` + `encodeSegment`）与官方
持久化层逐字一致——Linux 上 `/home/user/proj` 同样正确产出 `--home-user-proj--`。唯一的
平台差异是 host 半依赖的**布线方式**：

| 平台 | 依赖布线 | 重建命令 |
|---|---|---|
| Windows | `node_modules/@deepseek-ai` **junction** → 本机 dsh 包树 | `powershell -ExecutionPolicy Bypass -File scripts\link-dsh-deps.ps1` |
| Linux / macOS | `node_modules/@deepseek-ai` **symlink** → 本机 dsh 包树 | `bash scripts/link-dsh-deps.sh` |

两个脚本都会自动探测 dsh 安装（npx 缓存 → npm 全局），也可显式指定安装根
（`-DshRoot` / `-d`）。克隆后或 dsh 升级（npx 缓存目录变化）后重跑一次即可。

另一条全平台通用的替代路线：在本仓库内用包管理器真实安装这三个依赖（如
`pnpm add -D @deepseek-ai/cordis @deepseek-ai/dsh-typert-protocol @deepseek-ai/dsh-home-paths`），
克隆即用、无需脚本，代价是与宿主进程各持一份模块实例（dsh-cloud-workspaces 即此模式，已被
验证可用）。

### Linux/macOS 安装进 profile

```bash
# ~/.dsh/profiles/web/package.json
#   dependencies 增加 "dsh-session-manager": "link:/home/<user>/path/to/dsh-session-manager"
#   dsh.profile.bundles 追加 'dsh-session-manager'
cd ~/.dsh/profiles/web && pnpm install   # link: 依赖在 POSIX 上原生 symlink
bash /path/to/dsh-session-manager/scripts/link-dsh-deps.sh
# 重启 dsh web
```

## 安装（link 方式装入 web profile）

```powershell
# 1) profile 依赖 + bundle 名单（~/.dsh/profiles/web/package.json）
#    "dependencies" 增加本项目 link: 路径；"dsh.profile.bundles" 追加 'dsh-session-manager'
# 2) 在 profile 目录 pnpm install
# 3) 重启 dsh web
```

## 已知边界

- 删除进行中/正在运行的会话会被拒绝（错误信息会提示先停止）。
- 工作区 pinned/archived 元数据里可能残留已删会话的 id（无行可指，惰性无害）。
