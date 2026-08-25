# VibeX 插件系统优化方案

对照 VS Code 扩展生命周期与 DeepSeek Harness `dsh plugin add`，把 VibeX
Plugin 做成一条可开发、可测试、可打包、可锁定、可装卸的闭环。控制面仍是
ADR-0046 / 0047 / 0048：一个产品包、Full Trust、候选代发布、失败保留上一完整代。

本方案分阶段。P0–P3 均已落地。

## 目标

用户能用同一套 CLI 对正在跑的 Desktop 或 `vibex-server` 完成：

```text
add → list → 使用 → remove
```

`--web` 可以钉到 Git tag / commit，安装物是不可变 snapshot，而不是跟着默认分支漂。
开发目录继续走 linked development：源码变化发布新候选代，Host 永不删除该目录。

## 现状与缺口

| 环节 | 现在 | 目标 |
| --- | --- | --- |
| 安装 | `add --web/--profile/--dev`，无钉版本 | `--web url#tag` 锁 ref，snapshot digest 为内容锁 |
| 发现 | 只有 UI 目录 | `plugin list` 读同一 catalog |
| 卸载 | 只有 UI；Server 无 uninstall 命令 | `plugin remove`；内置包只能禁用 |
| 开发 | CLI watch + Host 800ms digest 轮询 | 文件系统事件；候选代失败保留上一代（已有） |
| 测试 | `vibex-plugin test` harness | 真 Host 装/开/用/卸一条回归 |
| 发布 | 本机 official index 全是 builtin | GitHub Release `.vxp` + SHA；市场后补 |
| 干净 | 卸 membership；Runtime 引用仍在 | `--delete-data` 清 snapshot/config；Runtime 引用归零才能回收 |

## P0 — CLI 对称与锁定（本变更）

1. `vibex plugin list [--json]`  
   读取 Host `plugin_control_catalog`。列 ID、版本、来源（builtin / linked / installed）、启停。Host 未运行则失败，不伪造目录。
2. `vibex plugin remove <id> [--yes] [--delete-data]`  
   走 `plugin_control_uninstall`。内置包拒绝。默认保留用户 `config.json` / snapshot；`--delete-data` 删除 Host 管理的 snapshot。链接开发只拆引用，不删源码目录。
3. `--web` 的 `#tag` / `#commit` / `github:owner/repo#v1.2.0`  
   clone 或 GitHub tarball 使用该 ref，不再默认 `HEAD`。装上后内容由 package digest 锁定。日志写出 ref 与解析到的 git SHA（若可得）。
4. Server Application Core 增加 `plugin_control_uninstall`（`plugin.write`），与 import/list 同一 HTTP 面。Desktop Web 与 `vibex-server` 都能被 CLI 卸载。

## P1 — 开发闭环与证据

- Host 对 DeveloperLink 改为文件系统事件 + debounce，替代固定 800ms 轮询。
- 安装审计写入 git ref、SHA、package digest。`plugin list --json` 可回显锁定证据。
- `vibex plugin update <id>` 只对 snapshot 有效：按原锁定源拉新 tag，走候选代；linked 包用目录变化刷新，不走 update。
- CLI 与 Host 不要各 watch 一遍。`--dev` 负责 build；Host 只在 digest 变化时发布候选代。

## P2 — 测试、打包、发布

- `vibex-plugin test --host`：对着真 Host 装、启用、打开一条贡献、卸载，断言 catalog 与数据目录。
- Skill 热更新回归：改 `contents/**/SKILL.md` 后下一回合读到新正文。
- `.vxp` 继续确定性 pack。拒绝包内 symlink。`--web` 未带 ref 时仍允许，但审计标记为 unlocked。
- 公共市场未上线前，GitHub Release 的 `.vxp` + SHA-256 作为官方分发。publisher + plugin id 仍是身份；换 publisher 不能继承数据。

## P3 — 装卸干净

- Runtime inventory 标明引用插件；引用归零才允许回收。
- `remove --delete-data` 的范围写进确认文案：snapshot/config 删除；全局 Runtime、会话、产物默认保留。
- 链接开发：remove 永不 `rm -rf` 用户目录。inbox `links.jsonl` 中对应行一并去掉。

## 非目标

- 不恢复逐 capability 授权弹窗（ADR-0048）。
- 不把 Agent 原生插件（Codex / Claude / Grok / DSH）并进 `/plugins` 或 `vibex plugin list`。
- 不为了热更新绕过候选代或跳过 digest。

## 验收

- `plugin add --web <repo>#vX.Y.Z -y` 装到的内容与该 tag 的 tree 一致，重复安装同一 tag digest 不变。
- `plugin list` 与 UI 目录同一事实。
- `plugin remove id` 之后 list 不再出现；内置 id 报错且仍在 catalog。
- `--dev` 目录在 remove 后仍在磁盘上。
- `--delete-data` 删除 Host snapshot；默认 remove 留下 config，同一 id 再装可恢复用户配置。
