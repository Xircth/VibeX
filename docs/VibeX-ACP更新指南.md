# VibeX ACP 更新指南

更新时间：2026-04-29

本指南说明 VibeX 改用 ACP（Agent Client Protocol）后，用户和维护者应如何跟随官方仓库更新 Codex、Claude Code、OpenCode 相关适配器，并验证更新是否仍与 VibeX 兼容。

## 官方来源

优先以这些来源为准，不要只看本仓库里的历史默认值：

| 组件 | VibeX 启动方式 | 官方来源 |
| --- | --- | --- |
| ACP 协议 | Rust crate `agent-client-protocol` | https://github.com/agentclientprotocol/agent-client-protocol |
| ACP Registry | 官方 agent 版本索引 | https://agentclientprotocol.com/registry |
| Codex ACP | `npx -y @zed-industries/codex-acp` | https://github.com/zed-industries/codex-acp |
| Claude Agent ACP | `npx -y @agentclientprotocol/claude-agent-acp` | https://github.com/agentclientprotocol/claude-agent-acp |
| OpenCode ACP | `opencode acp` | https://opencode.ai/docs/acp/ |
| OpenCode 安装 | `npm install -g opencode-ai` 或官方安装器 | https://opencode.ai/ |

官方 Registry 会变动，本文中的版本号只作为检查方法示例。更新前应打开官方 Registry 或各仓库 Releases 页面确认最新版本、破坏性变更和迁移说明。

## 用户更新步骤

### 1. 更新本机 ACP 代理

在 Windows PowerShell 中：

```powershell
npm install -g @zed-industries/codex-acp
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g opencode-ai
```

在 macOS/Linux 中：

```bash
npm install -g @zed-industries/codex-acp
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g opencode-ai
```

OpenCode 也可以使用官方安装器：

```bash
curl -fsSL https://opencode.ai/install | bash
```

如果你在 VibeX 设置页里使用“Install / Update”按钮，它当前执行的也是这些 npm 全局安装命令。更新后重启 VibeX，避免旧进程继续使用旧 adapter。

### 2. 检查本机版本和命令是否可用

```powershell
npx -y @zed-industries/codex-acp --help
npx -y @agentclientprotocol/claude-agent-acp --help
opencode --version
opencode acp --help
```

重点检查：

- `codex-acp` 是否仍支持 `-c/--config <key=value>`。VibeX 使用它传 `sandbox_mode`、`approval_policy`、`model`、`profile` 和 reasoning 配置。
- `opencode acp` 是否仍是官方 ACP 启动方式。OpenCode 官方文档要求编辑器运行 `opencode acp`，通过 stdio JSON-RPC 通信。
- Claude Agent ACP 是否仍支持 ACP session mode，例如 `plan` 和 `bypassPermissions`。

### 3. 处理认证

Codex ACP 支持 ChatGPT 订阅、`CODEX_API_KEY`、`OPENAI_API_KEY` 等认证方式。Claude 和 OpenCode 使用各自官方登录/配置。更新 adapter 不应删除你的认证文件，但遇到认证异常时先按官方 CLI 重新登录。

常见配置位置：

```text
Codex:    %USERPROFILE%\.codex\config.toml / auth.json
Claude:   %USERPROFILE%\.claude.json
OpenCode: %USERPROFILE%\.config\opencode\opencode.json
```

macOS/Linux 下对应 `$HOME` 路径。

## VibeX 维护者更新步骤

### 1. 更新协议 SDK

当 `agentclientprotocol/agent-client-protocol` 发布新的 Rust SDK 或协议版本时，检查 `crates/executors/Cargo.toml` 中的：

```toml
agent-client-protocol = { version = "0.8", features = ["unstable"] }
```

更新后必须验证：

```bash
cargo test -p executors -- --nocapture
cargo check -p vibex
```

重点看 `crates/executors/src/executors/acp/harness.rs` 中的这些协议调用是否需要跟随变更：

- `initialize`
- `new_session`
- `set_session_model`
- `set_session_mode`
- `prompt`
- `cancel`

### 2. 更新 Codex ACP 集成

Codex ACP 当前原生参数面很窄，VibeX 应通过 `-c key=value` 传 Codex 配置覆盖，不要恢复旧 CLI 参数。

当前 VibeX 映射：

```text
sandbox              -> -c sandbox_mode=...
ask_for_approval     -> -c approval_policy=...
model                -> -c model=...
profile              -> -c profile=...
model_reasoning_effort  -> -c model_reasoning_effort=...
model_reasoning_summary -> -c model_reasoning_summary=...
```

每次升级 `@zed-industries/codex-acp` 后都要重新跑：

```bash
npx -y @zed-industries/codex-acp --help
cargo test -p executors codex_ -- --nocapture
cargo check -p vibex
```

如果官方新增正式参数，也只有在 help 或 README 明确支持后再接入。不要传 `--sandbox`、`--ask-for-approval`、`--profile` 这类 Codex CLI 旧参数给 `codex-acp`。

### 3. 更新 Claude Agent ACP 集成

VibeX 当前不向 `@agentclientprotocol/claude-agent-acp` 追加自定义 CLI 参数，而是通过 ACP 协议设置：

```text
model                         -> set_session_model
plan=true                     -> set_session_mode("plan")
dangerously_skip_permissions  -> set_session_mode("bypassPermissions")
approvals=true                -> VibeX approval bridge
```

升级后检查官方 README、CHANGELOG 和源码中 session mode 名称是否变化。尤其关注：

- `plan`
- `bypassPermissions`
- permission request / approval request payload
- terminal events
- slash command events

验证：

```bash
npx -y @agentclientprotocol/claude-agent-acp --help
cargo test -p executors claude_ -- --nocapture
cargo check -p vibex
```

### 4. 更新 OpenCode ACP 集成

OpenCode 官方 ACP 文档要求编辑器运行：

```bash
opencode acp
```

VibeX 当前通过 ACP 协议设置：

```text
model -> set_session_model
agent / mode alias -> set_session_mode
variant -> 保留为旧配置字段，不发送为 ACP mode
```

不要把 `--model`、`--agent` 直接追加到 `opencode acp` 子命令上；本机 `opencode acp --help` 显示该子命令主要接受服务端参数，如 `--cwd`、`--port`、`--hostname`。

验证：

```bash
opencode --version
opencode acp --help
opencode agent list
cargo test -p executors opencode_ -- --nocapture
cargo check -p vibex
```

### 5. 更新安装/预检逻辑

VibeX 的安装和版本检测入口在：

```text
src-tauri/src/commands/agent_settings.rs
```

更新 adapter 包名、安装命令或 version 命令时，同步检查：

- `install_source_label`
- `install_command_for_agent`
- `uninstall_command_for_agent`
- `version_command_for_agent`
- `agent_preflight`
- `run_agent_fix`

当前包名：

```text
ClaudeCode: @agentclientprotocol/claude-agent-acp
Codex:      @zed-industries/codex-acp
OpenCode:   opencode-ai
```

## 兼容性检查清单

每次跟随官方仓库升级后，至少完成以下检查：

```bash
cargo fmt -p executors
cargo test -p executors -- --nocapture
cargo check -p vibex
```

再手工 smoke test：

- 用 Codex 新建一个会话，确认默认 `danger-full-access` 不再触发 Windows sandbox 错误。
- 用 ClaudeCode 新建普通会话、Plan 会话、跳过权限会话。
- 用 OpenCode 新建普通会话和 `agent=plan` 会话。
- 在会话中触发一次文件修改和一次命令执行，确认 permission request、tool update、日志归一化都能显示。
- 做一次 follow-up，确认 VibeX 的 ACP fork snapshot 会话续接仍工作。

## 回滚

如果更新后 ACP 会话无法启动，先回滚 adapter，不要先改 VibeX 配置：

```bash
npm install -g @zed-industries/codex-acp@<known-good-version>
npm install -g @agentclientprotocol/claude-agent-acp@<known-good-version>
npm install -g opencode-ai@<known-good-version>
```

然后重启 VibeX 并重新运行设置页的 Agent Preflight。

如果是 VibeX 协议层升级导致的问题，优先回滚 `agent-client-protocol` crate 版本，并保留失败版本的 help 输出、stderr 日志和 ACP raw session 日志用于定位。

## 当前设计原则

- VibeX 只把 provider 的启动命令当作 ACP server，不再使用旧 SDK 私有协议。
- CLI 参数只传官方 adapter 明确支持的参数。
- 模型、模式、权限优先走 ACP `set_session_model`、`set_session_mode` 和 permission request。
- provider 特有配置必须有回归测试，避免官方 adapter 参数变化后静默失效。
- 更新前先查官方 Registry / Releases；更新后必须跑单测、编译和至少一次真实会话 smoke test。
