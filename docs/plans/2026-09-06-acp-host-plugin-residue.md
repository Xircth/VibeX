# ACP / Host+App / 插件残留收口

依据：2026-09-06 全面审查、ADR-0010/0048/0054/0060/0061/0066/0067/0069/0078、maiden-skill。
目标：三个架构面各只留一条活路径。桌面 Host、`vibex-server`、绑定 App 对同一用户动作给出同一结果。不留第二套实现、不留错误安全承诺。

不要手改 `shared/hostCommands.ts` / `shared/types.ts`；改 Rust 描述符后跑 `pnpm run generate-types`。

## 用户可见完成标准

1. Claude/Codex 会话与委派只验证 ACP 启动命令；vendor CLI 指纹变化不能挡住启动。
2. 绑定到远端 Host 时：启停插件立刻改 chrome；供应商绑定确认出现在当前窗口并作用在 Host；CEF/本机对话框不伪装成 Host 能力。
3. Isolated 包与普通包一样以全信任 Worker 运行，不再因缺少 Seatbelt/bwrap 拒绝安装。
4. 插件作者只走产品 Host（`vibex plugin add --dev` / `plugin_control_import`）；不再出现 plugin-dev token 控制面。
5. 打开会话不再为了显示窗口重放整条历史；绑定窗口不再每秒补放。
6. Worker 崩溃后贡献立刻从 chrome 消失。

## 非目标

- ADR-0069 Batch 3–6（Notes/看板下沉、CEF 按需 Runtime）。
- 把九个 patch stream 命令从注册表物理删除（生产者已在 Host；本轮只保证走总线、不双开 watcher）。
- 新建 Isolated sandbox ADR。

## 批次

### B1 — ACP 启动唯一路径

| ID | 根因 | 做法 |
|---|---|---|
| B1.1 | 桌面委派走 LaunchGate SHA，Host 走 ACP 存在性 | `src-tauri/src/delegation/spawner.rs` 改 `conversations::resolve_agent_runtime_launch_settings`。桌面 `agent_runtime_launch_settings_from_pool*` 删除或变成该函数的薄包装。 |
| B1.2 | `ownership` 缺省 `managed` 仍哈希全部组件含 vendor CLI | LaunchGate 只校验 ACP/`combined_runtime` 组件；`agent_runtime` 永不挡会话。新锁只写 `external`。 |
| B1.3 | 启动仍发布 managed shim | `reconcile_managed_cli_exposures` 把现存 `managed` 行迁成 `external` 并不再 publish shim。卸载/回滚不再要求「本地 Runtime」。 |
| B1.4 | probe 仍把 vendor CLI 记进 catalog 指纹 | `runtime_available` 不再进入 capability catalog digest；预检查项保持 ACP-only。 |
| B1.5 | 文档/测试仍写双组件启动门 | 更新 release-evidence、discovery design、AgentSettings `installRuntime` 文案与 `id === 'runtime'` patch。 |

完成门：`cargo test -p agents launch_gate`、`cargo test -p conversations` 中 session launch；委派测试走同一 resolve 函数。

### B2 — Host 推送与插件产品命令

| ID | 根因 | 做法 |
|---|---|---|
| B2.1 | `plugin-contributions-changed` 只 `AppHandle::emit` | HostRuntime 订阅 `catalog_changes`，`HostEventBus::emit("plugin-contributions-changed", generation)`。频道进 `HOST_EVENT_CHANNELS` 与 `BoundHostTransport` 前缀表。删 Tauri-only bridge。 |
| B2.2 | 供应商绑定停在桌面壳 | `plugin_resolve_provider_bind` 进 DomainCommand。Pending map 放到 `crates/plugins` 的 Host-owned `HostProviderPresetHost`。确认事件 `provider-bind-confirm` 走总线。前端所有 environment 用 `backendListen`，不再 `environment === 'desktop'`。`vibex-server` 使用同一 host，禁止 `UnavailableProviderPresetHost`。 |
| B2.3 | CLI 导入是壳命令，打到客户端 PATH | `plugin_control_import_cli` 进 Host 注册表，在 Host 上解析 `codex`/`claude`。流式进度走 Host 事件或既有 stream 接缝。从 `DESKTOP_SHELL_COMMANDS` 与 `invoke_handler` 删除。 |
| B2.4 | 桌面 Host 的 HTTP capabilities 带 `desktop.tauri` | `ServerRuntime::from_host` 从广告的 capabilities 去掉 `desktop.tauri`。`TauriTransport.capabilities()` 仅本机 App 附加该位。前端 CEF / CLI 导入：本机 `environment === 'desktop'`，远程永不因 capabilities 打开本机 CEF。 |
| B2.5 | RemoteProfileHost 在无头 Host 不可用 | 把档案存储从 Tauri `AppHandle` 抽到 Host 可调用的实现；desktop 与 server composition 都注入真实 host，不再 `UnavailableRemoteProfileHost`。 |
| B2.6 | 绑定窗口 1s `eventsSince` | 删除 `useConversationTimeline` 的远程轮询。`host_event` 已是权威。 |

完成门：契约测试含新频道与新命令；`host_parity_contract` 断言 HTTP capabilities 无 `desktop.tauri`；绑定 transport 前缀含插件频道。

### B3 — Agent 管理读 Host 真正预热的那份状态

| ID | 根因 | 做法 |
|---|---|---|
| B3.1 | `AgentManagementRuntimeState` 只在 AppState，Host bar 只读 DB | 状态迁到 `crates/services`（或等价 Host 可见模块），放进 `HostRuntime`。`agent_management_bar` overlay 同一份；`discovery_progress` 读真实进度，不再伪造 Complete。桌面 warmup 写这一份。 |
| B3.2 | warmup mutex 跨整个 probe | `run_warmup_once` 先看 flag 再 await；工作不在持锁期间执行。 |

完成门：Host `discovery_progress` 在 warmup 期间 `running=true`；完成后 overlay 与 DB 一致。

### B4 — 插件执行模型与作者路径

| ID | 根因 | 做法 |
|---|---|---|
| B4.1 | Isolated 仍当沙箱类 | Worker 一律全信任 spawn。忽略 `packageClass==isolated` 的 Seatbelt/bwrap/Landlock/AppContainer。导入不再因 `isolated_spawn_supported()` 失败。删除 live spawn 路径与 v5-isolated 作为运行契约（schema 可留只读墓碑说明已忽略）。文档不再声称 OS 沙箱。 |
| B4.2 | plugin-dev HTTP 控制面 | 只保留 federation 产物 HTTP（`start_artifact_http`）。删除 `/api/plugin-dev/v1`、`plugin-dev.json` token、`plugin_dev_link`、CLI `PluginDevHostClient` 安装路径。`vibex plugin run dev` 只走产品 Host import。`plugin_dev_connection` 从壳清单删除，或改为无 token 的产物 origin（若 UI 仍需要）。 |
| B4.3 | grant / Trusted Native UI | 删除 `PluginsSettings` permission delta / Trusted Native。删除或空实现 `plugin_control_grant_permissions` 作为无操作兼容（不展示 UI）。产品只保留 Full Trust 安装弹窗。 |
| B4.4 | Worker 崩溃不撤 generation | 致命 Worker 退出调用与 disable 相同的 `withdraw_live_generation`。 |
| B4.5 | federation 不卸载、无超时 | `loadRemote` 超时（8s）；disable/unmount 时 unregister remote。 |
| B4.6 | 运行时仍认 `depends.kind=plugin` | 删除 `plugin_dependencies` / `require_plugin_dependencies` / `withdraw_with_dependents` 的 plugin-kind 分支。inspect 拒绝保持。 |
| B4.7 | `product: plugin-dev` MCP 映射 | 从 `official_mcp.rs` 与 command 映射删除。 |

完成门：`cargo test -p plugins` Isolated 相关改为全信任 spawn；CLI 测试不再读 `plugin-dev.json`；无特权与 Full Trust 文案一致。

### B5 — 锁、缓冲、打开路径

| ID | 根因 | 做法 |
|---|---|---|
| B5.1 | Turn 锁覆盖 ACP handshake | `start_turn_under_lock` 在写入 active-turn 与 runtime 指针后释放锁，再 `send_turn_to_agent`。发送前/连接后若 turn 已非 in-flight 则停止。`cancel_turn` 持锁只读取/标记，ACP cancel 在锁外。 |
| B5.2 | `conversation_turn_locks` 只增 | `forget_conversation_runtime` 在 guard drop 之后 prune；`EnsureSessionGuard` 模式或 Drop 钩子。 |
| B5.3 | ACP manager pump unbounded | `manager_event_tx` 改为有界 8192，发送方阻塞而非无界堆积。终端 `subscribe_output` 有界，溢出丢最旧。 |
| B5.4 | 打开会话全量投影 | `load_conversation_detail` 使用已有分页/截断读，禁止为截断而先 `project()` 全表。若现有 API 只能先投影，补 `project_tail` / SQL 窗口。 |

完成门：conversations 单测覆盖「handshake 中 cancel 不堵 60s」；agents 单测覆盖有界 channel；打开 detail 测试不要求全 timeline。

### B6 — 残留删除与文档

| ID | 做法 |
|---|---|
| B6.1 | 未注册的 `#[tauri::command]` 产品函数去掉属性；无调用方则删。`plugin_dev_link` 删除。 |
| B6.2 | `DESKTOP_SHELL_COMMANDS` 去掉无 handler 的名字（`create_ssh_tunnel`、`host_client_call`、`open_devtools`、`fixture_*` 若无实现）。 |
| B6.3 | `useTauriPatchStream` 仅保留 deprecated 别名或直接改 import。 |
| B6.4 | 更新 CONTEXT 词条：capability grant 标为已废止；Isolated 不是安全边界。 |
| B6.5 | 插件开发 Skill / developer-guide / implementation-status / PLUGIN_DEV_PROTOCOL 与现行一致。 |
| B6.6 | `plugin_v2_*` 本轮保持只读墓碑（删表需独立迁移窗口）；代码不再把它当运行面。 |

## 顺序

```
B1 → B3
B2 → B4 → B5 → B6
```

B1 与 B2 可并行。B3 依赖 HostRuntime 扩展，可与 B2 同批。B4 不依赖 B1。B5 独立但改 conversations 热路径，放在启动门稳定之后。

## 检验

每批：相关 `cargo test -p …` 与前端 vitest。
全部完成后：

- `pnpm run generate-types` 后无手改 shared
- `cargo test -p agents launch_gate`
- `cargo test -p conversations`
- `cargo test -p plugins`
- `cargo test -p server host_parity`
- `cargo test -p application command_contract`
- 前端：`hostCommandContract`、`boundHostTransport`、`ProductPlugins`、`PluginsSettings`、`onboardingAgentModel`、`useConversationTimeline`、`pluginFederation`、`useProviderBindConfirmations`
- `rg` 对抗性扫描：`CLAUDE_CODE_EXECUTABLE` 注入生产路径、`UnavailableProviderPresetHost` 在 composition、`isolated_spawn_supported` 作为导入门、`plugin-dev.json`、`environment === 'desktop'` 监听插件产品事件、HTTP capabilities 含 `desktop.tauri`

## 回滚

每批一个逻辑提交面。B4 Isolated 删除若需回退，只能回退 spawn，不得恢复「这是沙箱」的 UI 文案。
