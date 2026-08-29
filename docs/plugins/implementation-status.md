# Plugin Platform Implementation Status

本文档按 2026-08-18 方案
[`docs/plans/2026-08-18-plugin-platform-complete.md`](../plans/2026-08-18-plugin-platform-complete.md)
对照当前 worktree `feat/plugin-platform-complete` 的可重复证据。

## 交付结论

平台主路径已经可交付：v4 产品包、协议 1.1、四语言写作面、官方 MCP Registry 注入、App 孔、开发 Skill/CLI、Isolated 在 macOS（及 Linux bwrap）上可 spawn、Marketplace 本机 index + TOFU、Remote install 命令、doctor 崩溃记录。

下列方案项**未按字面 38-PR 全量关闭**，交付时必须当作已知边界，而不是「以后默认会有」：

| 方案项 | 边界 |
| --- | --- |
| P20 公共类型名 | 会话协议类型已是 `ConversationWorkflowRef.workflowId`；serde 仍可读旧 JSON `pluginActions` / `actionId`。Automation `TurnLaunchSpec.plugin_actions` 保持 `PluginActionRef`。 |
| P27b Windows Isolated | `CreateProcessW` + AppContainer（默认无 `internetClient`）+ Job Object（KILL_ON_JOB_CLOSE + 256MiB）。需在 Windows 上实测。 |
| P27b Linux Isolated | `bwrap --unshare-net --seccomp` 或 Landlock + `PR_SET_SECCOMP`；allowlist 来自 `packages/plugin-contract/isolated/*.linux.syscalls`。需在 Linux 上实测。 |
| P29 registry 发布 | Host 发行物会打包 `sdk/`；npm/PyPI/crates.io 上传仍属发行账号操作。 |
| P32 三 OS E2E | `scripts/plugin-platform-e2e.sh` 本机门禁；未在外发 Windows/Linux runner 上签核。 |

## 墓碑（已删除，不得回潮）

- `OfficialProductMcpGate` 按插件 ID 注入
- `project_official_product_mcp` upsert 本机 native MCP
- `extra_stdio_servers` 二次拼接
- `infer_product` 按插件 ID 猜 session/delegation
- inspect 把 `format=javascript-esm` 编译成 node
- `--template agent`
- 产品路径 `VIBEX_PLUGIN_DEV_TOKEN` / 开发 MCP `plugin_dev_link_*`
- `plugin_grants_v4` 表（迁移 `20260818010000`）
- `agentDefaults` 配置特判
- Workflow gateway token 注入每个 managed MCP

## 已落地（有测试或命令证据）

- 协议 1.1 initialize→activate；作者只写 `runtime`
- Office / workflow-creator / session-enhance / multi-agent / plugin-development 走公共契约
- `OfficialMcpRuntime` + `hostFamilyBinary`；`injected_stdio_servers` 一份列表
- Composer/Toolbar/Status/Palette/timeline/settings 孔
- CPython 3.12.11 lock；Worker 按 node/python/native 启动
- Isolated allowlist 文件 + macOS seatbelt + Linux bwrap/Landlock + seccomp-bpf + Windows AppContainer
- CLI 10 模板、`toolchain`、OS watch、pack `signature.json`
- 链接开发走 `vibex plugin add --dev` / `plugin_control_import`
- doctor：无 grants 字段；`recentCrashes`；`mcpRebindingRequired`
- `depends.kind=plugin` 启用时校验，不自动拉包
- Remote：`plugin_install` / `plugin_update` / `plugin_uninstall`
- Marketplace：`assets/plugins/index/official.v1.json` + `/plugins` 目录 UI
- `host.service` supervisor：启用后按 `intervalSeconds`（最小 5s）tick，上一次未完成则跳过
- Isolated Linux：bwrap + seccomp-bpf，或 Landlock + seccomp-bpf；Windows：AppContainer + Job Object
- 激活代撤出：禁用/卸载按反序停 host.service、dispose Worker、收回 contribution；依赖插件退出就绪但保留启用意图，依赖恢复后自动重挂
- Host 发行物 `scripts/package-host-family.js` 打包 `sdk/` 与 official index

## 验证

```bash
cargo test -p plugins --offline
cargo test -p automation spec --offline
pnpm --filter @vibex/plugin-cli test
cd frontend && pnpm exec vitest run src/pages/plugins/ProductPlugins.test.tsx src/lib/conversation-rendering/commandSources.test.ts
pnpm run generate-types
pnpm run prepare-db
bash scripts/plugin-platform-e2e.sh
```

本页只随可重复运行的证据更新。
