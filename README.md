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

1. **live 会话拒绝删除**（AgentRegistry 仍挂载的会话需先停止）；
2. 会话必须在持久化盘上存在（`sessionPersistence.list` 定位 header）；
3. 目录路径由持久化层规范转义算法（`projectKey` + `encodeSegment`，与
   `@deepseek-ai/dsh-session-persistence-jsonl` 逐字一致）派生，并做
   「必须位于 sessions root 之内」包含性校验；
4. 只删除该会话自己的目录；fork/子代理等派生会话不受影响（默认仅删选中的那个）。

## 结构

```
lib/index.js     host 半：Typert 端点 + 删除服务（依赖见 node_modules junction）
client/index.js  client 半：菜单项 + 确认弹窗 + 列表刷新
cordis.patch.yml bundle 插入行
```

host 半的运行时依赖（`@deepseek-ai/cordis`、`dsh-typert-protocol`、`dsh-home-paths`）
通过 `node_modules/@deepseek-ai` junction 指向本机 dsh 安装的包树解析——与宿主进程
共享同一份模块实例。克隆本仓库后，或 dsh 升级（npx 缓存目录变化）后，运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\link-dsh-deps.ps1
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
