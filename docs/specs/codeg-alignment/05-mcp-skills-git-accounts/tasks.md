# Tasks: Phase 5 — MCP/Skills/Git 账户管理

执行环境：worktree `../VibeX-mcp-skills-git`，分支 `feature/mcp-skills-git`。

- [ ] T5.1 MCP 本地扫描
  - Acceptance: 扫描 Claude Desktop、Claude Code、Codex、OpenCode 等本地 MCP
    配置位置；合并展示 server 名称、command、args、env、来源、是否可导入。
  - Verify: 平台路径表驱动测试 + fixture config 聚合测试。
  - Files: `crates/agents/src/mcp/scan.rs`, `src-tauri/src/commands/mcp.rs`

- [ ] T5.2 MCP Registry / Marketplace 客户端
  - Acceptance: 支持 registry.modelcontextprotocol.io 与 Smithery 搜索/详情/安装；
    网络失败/限流有友好错误；安装前预览写入配置。
  - Verify: stub HTTP 测试；MCP 安装 UI mock 测试。
  - Files: MCP client/service, `frontend/src/pages/settings/McpSettings.tsx`

- [ ] T5.3 Per-agent MCP 注入策略
  - Acceptance: 形成 Agent 类型到配置写入策略表；保留用户原配置格式与注释；
    Hermes/OpenClaw 等不支持路径有明确 skip/提示。
  - Verify: snapshot 测试覆盖每类 Agent 配置写回。
  - Files: `crates/agents/src/mcp/injection.rs`

- [ ] T5.4 Skills 后端 CRUD
  - Acceptance: 支持 global/project scope；list/read/save/delete；兼容 `.codex/skills`
    与 VibeX 项目级布局；路径 jail 防止越界。
  - Verify: 临时目录 CRUD 测试 + 越界拒绝测试。
  - Files: `src-tauri/src/commands/skills.rs`, service modules

- [ ] T5.5 SkillsSettings UI
  - Acceptance: 浏览、查看 README/SKILL.md、新建向导、编辑、删除、启用/禁用；
    project/global 分区清晰；错误 toast 国际化预留。
  - Verify: component tests + 手动创建/编辑/删除冒烟。
  - Files: `frontend/src/pages/settings/SkillsSettings.tsx`, skill components

- [ ] T5.6 Keyring 与 Git 账户模型
  - Acceptance: git_accounts 表只存元数据；token/secret 存 OS keyring；server 模式
    有加密/文件回退策略并记录风险；支持 GitHub/GHE/Gitea。
  - Verify: keyring mock 测试 + DB migration check。
  - Files: `crates/db/migrations/*`, `src-tauri/src/keyring_store.rs`,
    `src-tauri/src/commands/version_control.rs`

- [ ] T5.7 Git token 验证与账户 CRUD
  - Acceptance: 添加、编辑、删除、设默认；token 验证用户/权限；企业 GitHub URL
    可配置；错误可操作。
  - Verify: mocked HTTP tests + UI form tests。
  - Files: version control commands, frontend dialogs

- [ ] T5.8 GIT_ASKPASS 凭证助手
  - Acceptance: git 操作与 Agent spawn 可注入临时 askpass；凭证不落日志；多账户按
    remote host/owner 选择。
  - Verify: 临时 git repo clone/push mock 或 fixture 测试。
  - Files: `src-tauri/src/git_credential.rs`, git command wrappers

- [ ] T5.9 VersionControlSettings 分区
  - Acceptance: 账户列表、添加 GitHub/Gitea、token 状态、默认账户、删除确认；
    与 Phase 7 settings nav 深链兼容。
  - Verify: component tests + 手动添加 mock 账户。
  - Files: `frontend/src/components/settings/version-control-settings.tsx`,
    AddGitAccount dialogs

- [ ] T5.10 预配置 Skills/MCP 安装
  - Acceptance: Project Boot/设置页可安装推荐 MCP 与 Skills；安装前展示文件变更；
    重复安装幂等。
  - Verify: fixture install test。
  - Files: installers, defaults registry

- [ ] T5.11 冒烟与全门
  - Acceptance: 私库 clone/push、registry MCP 安装、skill CRUD、per-agent 注入均有
    真实或 stub 冒烟记录。
  - Verify: `pnpm run check`, `pnpm run lint`, `cargo test --workspace`,
    `cd frontend && pnpm vitest run`

- [ ] T5.12 五轴审查 → 修复 → 合并回 master
  - Acceptance: E4-E10 traceability 项完成/裁剪记录齐全。
  - Verify: review findings 关闭；根目录全门复跑通过。
