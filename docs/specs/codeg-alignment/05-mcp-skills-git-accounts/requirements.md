# Requirements: Phase 5 — MCP/Skills/Git 账户管理 (mcp-skills-git-accounts)

## Objective

补齐三块管理面：MCP（本地扫描 + Marketplace 安装）、Skills（全局/项目级
CRUD）、Git 远程账户（多账户 + keyring 安全存储 + 凭证助手）。

对应差距：E4–E10。基础：VibeX 已有 mcp_file.rs 读写、McpSettings/
SkillsSettings UI 骨架、crates/git——扩展为完整闭环。

## Acceptance Criteria (EARS)

### MCP
1. THE SYSTEM SHALL 扫描本地各 Agent 的 MCP 配置（claude_desktop_config.json、
   ~/.codex/config.toml、opencode 配置等，平台路径自适应）并在 UI 聚合展示。
2. THE SYSTEM SHALL 支持 MCP Registry（registry.modelcontextprotocol.io）
   搜索 → 详情 → 参数填写 → 安装到所选 Agent 配置（JSON/TOML 自动格式）。
3. WHERE Agent 无文件配置面（Gemini/OpenClaw/Cline/Hermes 中按 Codeg 策略为
   AgentCommand 的），THE SYSTEM SHALL 按该 Agent 的注入策略处理并在 UI 标注
   能力差异；Hermes 特殊跳过逻辑对齐 Codeg。
4. THE 预配置 MCP 列表（DEFAULT_MCP_JSON）SHALL 在 UI 呈现并支持一键安装。

### Skills
5. THE SYSTEM SHALL 实现 skills 后端命令：list（global/project scope，
   扫描 `~/.claude/skills`、`~/.codex/skills`、`~/.opencode/skills` 与
   `{project}/.claude/skills` 等）、read、save（自动建目录）、delete；支持
   skill_directory（SKILL.md）与 skill_file（xxx.md）两种布局。
6. THE SkillsSettings UI SHALL 支持浏览（按 scope/Agent 过滤、搜索）、查看
   （Markdown 渲染）、新建（模板向导）、编辑、删除。

### Git 账户
7. THE SYSTEM SHALL 支持多 Git 账户（GitHub.com + 企业 server_url）：添加
   （token 输入 + API 验证 + 头像/用户名回显）、列表、删除。
8. THE token SHALL 存储于 OS keyring（Windows Credential Manager），数据库仅
   存账户元数据；keyring 不可用时报错而非明文落库。
9. THE SYSTEM SHALL 生成 git 凭证助手脚本并在 git 操作与 Agent 会话进程中
   注入（GIT_ASKPASS），使 clone/push/fetch 自动使用对应账户 token。
10. 设置页新增「版本控制」分区承载账户管理 + git 路径检测。

## Edge / Error Cases

- token 无效/过期：验证失败给出 GitHub API 原始错误；已存账户标记失效态。
- 多账户同 host：按账户选择器/仓库 remote 匹配选择，无法判定时询问。
- TOML 配置含注释：写回保结构（toml_edit），不得抹掉用户注释。
- registry 网络失败：Marketplace 标签降级提示，本地功能不受影响。

## Boundaries

- Always：凭证不写日志；keyring 操作有集成测试（Windows CI 可跳过但本机验证）。
- Ask first：无。
- Never：token 明文入库/入配置文件；删除用户既有 MCP 配置项。

## Success Criteria

- 10 条验收全过；冒烟：添加 GitHub 账户 → clone 私有仓库 → push；安装一个
  registry MCP 到 Claude Code 配置并被会话使用；新建/编辑/删除一个 skill；
  全门绿。
