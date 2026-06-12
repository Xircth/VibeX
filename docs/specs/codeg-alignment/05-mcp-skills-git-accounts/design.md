# Design: Phase 5 — MCP/Skills/Git 账户管理

## 所属层

- 后端：`crates/agents/src/mcp*.rs`（扫描/registry 客户端扩展）、新
  `crates/agents/src/skills.rs`、新 `crates/services/src/services/
  git_accounts.rs` + `keyring_store.rs` + `git_credential.rs`、
  `src-tauri/src/commands/{mcp,skills,version_control}.rs`
- 前端：`McpSettings.tsx`、`SkillsSettings.tsx` 扩展、新
  `VersionControlSettings.tsx`、`AddGitAccountDialog.tsx`

## 参照实现（Codeg）

| 能力 | Codeg 文件 | 策略 |
|------|-----------|------|
| MCP 扫描 | `commands/mcp.rs` mcp_scan_local | 移植扫描位置表 + 平台分支 |
| Marketplace | `commands/mcp.rs` registry/Smithery 客户端 | 移植 registry.modelcontextprotocol.io 客户端；Smithery 可裁剪（记录） |
| 注入策略 | `acp/connection.rs` load_mcp_servers_for_agent | 对齐 per-agent 策略表（VibeX mcp.rs 已有雏形，补 Hermes skip） |
| Skills CRUD | `commands/acp.rs` acp*AgentSkill* | 行为对齐重写（两种布局、scope 扫描） |
| Git 账户 | `commands/version_control.rs` | 行为对齐重写 |
| keyring | `keyring_store.rs` | 移植（tauri 模式 keyring crate；server 模式文件回退留 Phase 8 复用） |
| 凭证助手 | `git_credential.rs` | 移植脚本生成（.bat/.sh）+ env 注入点：crates/git 操作与 agents spawn |

## 数据模型

- `git_accounts` 表：`id, server_url, username, avatar_url, scopes,
  created_at`（无 token 列）。
- MCP/Skills 无新表（文件系统即真相）。

## 新依赖

- `keyring`（Rust，OS 凭证库访问；Codeg 同款，安全要求不可自研）。
- `toml_edit`（保结构 TOML 写回；若 workspace 已有 toml 仅读则新增，理由：
  验收「不抹注释」）。

## 测试策略

- 扫描：fixture 配置目录表驱动测试（三平台路径分支用 cfg 测试覆盖 win）。
- registry 客户端：wiremock/手写 stub HTTP 测试（不打真网）。
- skills：临时目录 CRUD 往返 + 两种布局 + scope 过滤测试。
- 凭证助手：脚本生成内容快照 + env 注入单元测试。
- keyring：本机集成测试（标记 ignored，可手动跑）。

## 风险

- registry API 形状变动：客户端薄、响应宽容解析。
- keyring 在无桌面会话环境失败：明确错误信息（验收 8 拒绝明文回退）。
