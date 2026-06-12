# Spec Program: Codeg 全面对齐计划 (codeg-alignment)

> 基于 2026-06-11 对 `C:/Users/Administrator/Documents/Projects/codeg-main`（Codeg
> v0.15.7，Next.js 16 + React 19 + Tauri 2 多 Agent 编码工作台）的六维度深度对比
> 勘察，制定 VibeX 的完整对齐与升级路线。
>
> 总体原则（来自产品负责人）：
> 1. 绝不回避问题；2. 绝对功能完整；3. 不足之处绝对对齐 Codeg；
> 4. 绝对保证前端页面美观；5. 绝对确保 ClaudeCode、Codex、OpenCode、OpenClaw、
> Hermes、GeminiCli 等所有 Agent 的会话能力；6. 绝对保证代码尽量复用。

## 执行模型

- 每个 Phase 一套 spec（requirements.md / design.md / tasks.md），按编号顺序执行。
- `traceability.md` 是全量差距索引；任何实现任务必须能追溯到该矩阵中的差距、
  Phase 与验收焦点。
- 每个 Phase 在独立 git worktree 中实施（`../VibeX-<phase-slug>`，分支
  `feature/<phase-slug>`），遵循 修改 → 审查（五轴 code review）→ 测试 →
  合并回 master 的循环。
- 验证门：`pnpm run frontend:check`、`pnpm run frontend:lint`、
  `pnpm run backend:check`、`pnpm run backend:lint`、`cargo test --workspace`、
  受影响时 `pnpm run frontend:build` 与 `pnpm run generate-types:check`。
- 既有未提交的在途修改（agents 运行时连接复用 + AgentSettings 扩展）保留在主
  工作树，不得回退；新阶段从 master HEAD 切出。
- Codeg 是参照实现：凡复制/移植 Codeg 源码须保留上游 Apache-2.0 许可与出处
  标注（文件头或 crate NOTICE）。
- 新依赖必须在对应 spec 的 design.md 中记录技术理由（对齐 Codeg 同款能力即为
  本计划批准的理由，但每项仍须逐条列出）。

## 完整差距清单（按维度）

### A. Agent 运行时与会话能力（成熟度约为 Codeg 的 25%）

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| A1 | 会话恢复 session/load + 失败回退 session/new | `src-tauri/src/acp/connection.rs` L1547-1736 | 缺失，中断会话无法恢复 | 致命 | 1 |
| A2 | ACP 事件类型 11 种 vs 31 种（SessionModes、ModeChanged、SessionConfigOptions、AvailableCommands、SessionLoadFailed、ForkSupported、QuestionRequest 等） | `src-tauri/src/acp/types.rs` | `crates/agents/src/events.rs` 仅 11 种 | 致命 | 1 |
| A3 | 权限多选项（PermissionOptionInfo[]）支持任意选项 | `types.rs` L378-382 | 仅 allow/reject 二项 | 高 | 1 |
| A4 | Preflight 环境诊断框架（Node/npm/uv/binary 检查 + FixAction） | `src-tauri/src/acp/preflight.rs` | 完全缺失 | 高 | 1 |
| A5 | 会话模式切换（plan/code 等 SessionModes） | `types.rs` L159-174 | 缺失 | 高 | 1 |
| A6 | 会话配置选项（SessionConfigOptions，模型选择等） | `types.rs` L161-163 | 缺失 | 高 | 1 |
| A7 | Slash 命令面（AvailableCommands 事件 + UI） | `types.rs` L214-215 | 缺失 | 中 | 1+2 |
| A8 | Auto-Approve / YOLO 快速全批准 | `sender_context_service.rs`、`acp_manager.rs` L4617 | 缺失 | 中 | 1 |
| A9 | 待处理权限/反馈/提问持久化（刷新不丢失） | `session_state.rs` PendingPermissionState | 缺失 | 中 | 1 |
| A10 | Spawn 握手超时（60s 可配置）与崩溃恢复 | `acp/manager.rs` L95-131 | 缺失 | 中 | 1 |
| A11 | 并发会话去重（SpawnDedupKey） | `connection.rs` L79-88 | 在途修改部分覆盖 | 低 | 1 |
| A12 | 认证状态检测（auth.json 等读取与提示） | `commands/acp.rs` | 仅路径定义，无检测 | 高 | 1 |
| A13 | NPX/UVX 版本约束（Node 20+/22.19+、uvx --python 3.13） | `acp/registry.rs` | 部分缺失 | 低 | 1 |
| A14 | 运行时 env 合并优先级（registry 默认 → DB 运行时 → proxy） | `connection.rs` L48-73 | 简陋 | 中 | 1 |

### B. 历史会话聚合导入（Codeg 核心特性，VibeX 仅有 420 行雏形）

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| B1 | 7 个 Agent 解析器（Claude/Codex/OpenCode/Gemini/Cline/Hermes/OpenClaw，共 10,786 行） | `src-tauri/src/parsers/*` | `crates/agents/src/history/mod.rs` 仅基础 JSONL 雏形 | 致命 | 3 |
| B2 | 统一会话模型（ConversationSummary/Detail/MessageTurn/ContentBlock/SessionStats） | `models/conversation.rs`、`models/message.rs` | 缺失 | 致命 | 3 |
| B3 | conversation/folder 数据库表（external_id 去重、title_locked、pinned_at、软删除、委托关系列） | `db/entities/conversation.rs` | sessions 表无任何导入字段 | 致命 | 3 |
| B4 | 导入服务（增量更新、去重、标题锁保护） | `db/service/import_service.rs`（403 行） | 缺失 | 致命 | 3 |
| B5 | 项目自动发现与路径容错匹配（path_eq_for_matching） | `parsers/mod.rs` | 缺失 | 高 | 3 |
| B6 | 聚合会话列表（按项目/Agent 类型/状态过滤、搜索、固定） | `commands/conversations.rs` | 缺失 | 高 | 3 |
| B7 | 内容规范化（工具调用重建、structuredPatch、孤立 tool_result 重定位） | `parsers/claude.rs` 等 | 缺失 | 高 | 3 |
| B8 | 环境变量覆盖（CLAUDE_CONFIG_DIR 等 7 个） | `parsers/mod.rs` | 部分有 | 中 | 3 |
| B9 | 模型上下文窗口推断（infer_context_window_max_tokens） | `parsers/mod.rs` | 缺失 | 低 | 3 |

### C. 前端会话 UI 与渲染（流式渲染存在代际差距）

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| C1 | 流式 Markdown 渲染（Streamdown 主链路） | `ai-elements/message.tsx` | react-markdown 整块渲染 | 关键 | 2 |
| C2 | Shiki 代码高亮（多主题、token 级样式、未知语言降级） | `ai-elements/code-block.tsx` | Prism.js + dangerouslySetInnerHTML | 关键 | 2 |
| C3 | stick-to-bottom 自动滚动 | `ai-elements/message-thread.tsx` | 完全缺失 | 关键 | 2 |
| C4 | CJK 文本断行与软换行优化 | `@streamdown/cjk` | 无相关优化 | 重要 | 2 |
| C5 | 数学公式（KaTeX） | `@streamdown/math` | 完全缺失 | 重要 | 2 |
| C6 | Mermaid 图表 | `@streamdown/mermaid` | 完全缺失 | 重要 | 2 |
| C7 | 会话消息虚拟滚动为一等公民（virtua/等价实现） | `message/virtualized-message-thread.tsx` | react-virtuoso 未用于会话流 | 重要 | 2 |
| C8 | Thinking 块高级展示（计时、自动收起、流式） | `ai-elements/reasoning.tsx` | 基础折叠卡 | 重要 | 2 |
| C9 | 多类型工具卡片（计划、委托、问答、反馈、goal、生成图片） | `message/agent-tool-call.tsx` 等 | 单一 ToolCallCard | 重要 | 2/6 |
| C10 | Diff 内联预览（消息流中直接展示） | `diff/unified-diff-preview.tsx` | 须切换专用面板 | 重要 | 2 |
| C11 | 消息导航轨（rail 快速跳转） | `message/conversation-message-nav.tsx` | 缺失 | 中 | 2 |
| C12 | Token/耗时/成本统计（turn-stats、live-turn-stats） | `message/turn-stats.tsx` | 缺失 | 中 | 1/2 |
| C13 | @文件引用菜单 + 斜杠命令菜单 + 全局命令面板 | `chat/file-mention-menu.tsx`、`experts-command-menu.tsx`、cmdk | typeahead 雏形，无全局命令面板 | 中 | 2 |
| C14 | 消息队列可视化（重排/编辑/删除） | `chat/message-queue-display.tsx` | 队列逻辑有、UI 弱 | 中 | 2 |
| C15 | 图片内联展示 + 生成图片卡片 | `message/user-image-attachments.tsx`、`generated-images-block.tsx` | 弹窗式预览，无生成图片卡 | 中 | 2 |
| C16 | overlayscrollbars 自定义滚动条 | 全局集成 | 原生滚动条 | 低 | 2 |
| C17 | xterm ligatures | `@xterm/addon-ligatures` | 缺失 | 低 | 4 |

### D. 工程闭环（后端较全、前端 UI 落后）

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| D1 | Worktree 管理 UI（创建/删除/列表/合并对话框） | `layout/branch-dropdown.tsx` | 仅 WorktreeSelector 切换，后端完整 | 关键 | 4 |
| D2 | 多终端标签栏 + 终端上下文 | `terminal/terminal-tab-bar.tsx`、`contexts/terminal-context.tsx` | 后端支持，前端无标签 | 关键 | 4 |
| D3 | Diff 变更导航（上/下差异、统计） | `diff/diff-viewer.tsx` L147-169 | 基础对比视图 | 关键 | 4 |
| D4 | 文件树增量 delta 推送（防抖、批处理） | `workspace_state/mod.rs` L39-65 | 全量刷新 | 高 | 4 |
| D5 | Git 变更树形展示（目录计数） | `aux-panel-git-changes-tab.tsx` L97-120 | 平面列表 | 高 | 4 |
| D6 | Monaco 编辑器面板（编辑/保存/外部修改检测） | `files/file-workspace-panel.tsx` | 仅只读 diff | 高 | 4 |
| D7 | 冲突解决 UI | `layout/conflict-dialog.tsx` | 后端有 conflict_ops，前端缺 | 中 | 4 |
| D8 | 统一分支管理下拉（新建/合并/变基/删除/远程删除） | `layout/branch-dropdown.tsx` | 分散实现 | 中 | 4 |
| D9 | 独立 Git 操作窗口（commit/push/stash/merge） | `/commit`、`/push`、`/stash`、`/merge` 路由 | 缺失（内嵌实现部分有） | 低 | 4 |

VibeX 反超项（保留勿动）：AI commit 消息生成、文件树拖拽/内联编辑、后端 worktree_manager。

### E. 多 Agent 协作 + MCP/Skills/Git 账户

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| E1 | 多 Agent 委托框架（DelegationBroker、ConnectionSpawner、深度限制、取消级联） | `acp/delegation/*`（8 模块） | 完全缺失 | 致命 | 6 |
| E2 | MCP 伴生进程（vibex-mcp sidecar，delegate_to_agent 工具） | `bin/codeg_mcp.rs`、`scripts/prepare-sidecars.mjs` | 完全缺失 | 致命 | 6 |
| E3 | 委托 UI（DelegatedSubThread、SubAgentSessionDialog） | `message/delegated-sub-thread.tsx` | 缺失 | 高 | 6 |
| E4 | Git 远程账户管理（多账户、企业 GitHub、token 验证） | `commands/version_control.rs` | 完全缺失 | 致命 | 5 |
| E5 | Keyring 安全存储（OS keyring + server 模式文件回退） | `keyring_store.rs` | 缺失 | 高 | 5 |
| E6 | Git 凭证助手（GIT_ASKPASS 注入） | `git_credential.rs` | 缺失 | 高 | 5 |
| E7 | MCP 本地扫描（claude_desktop_config.json 等） | `commands/mcp.rs` mcp_scan_local | 读写有、扫描缺失 | 高 | 5 |
| E8 | MCP Marketplace（registry.modelcontextprotocol.io + Smithery） | `commands/mcp.rs` | 完全缺失 | 高 | 5 |
| E9 | Skills CRUD 后端（list/read/save/delete + 全局/项目 scope） | `commands/acp.rs` | UI 框架有、后端缺失 | 高 | 5 |
| E10 | 预配置 Skills/MCP 安装 | `project_boot.rs` install_hyperframes_skills | DEFAULT_MCP_JSON 未呈现 | 中 | 5 |

### F. 设置体系、国际化与产品完成度

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| F1 | 国际化（next-intl，10 语言，约 2,893 条目） | `src/i18n/*` | 0，全部中文硬编码 | P0 | 7 |
| F2 | 网络代理配置（6 种 env 形式 + UI + 验证） | `network/proxy.rs`、`system-network-settings.tsx` | 完全缺失 | P0 | 7 |
| F3 | 设置分区 7 vs 13（缺 模型提供商/版本控制/聊天频道/Web服务/快速消息/专家） | `src/app/settings/*` | 缺 6 个分区 | P0 | 5/7/8/9 |
| F4 | 外观深度（主题色预设、缩放 75-175%、可变字体管理） | `appearance-settings.tsx` | 仅 light/dark/system | P1 | 7 |
| F5 | 启动前偏好（preferences.json，硬件加速开关） | `preferences.rs` | 依赖后端 API | P1 | 7 |
| F6 | 备份/恢复 | `backup-settings.tsx` | 仅清除本地数据 | P2 | 7 |
| F7 | 多语言 README/文档 | `docs/readme/*`（10 份） | 仅中文 | P2 | 7 |
| F8 | 快速消息库 / 专家配置 | `settings/quick-messages`、`settings/experts` | 缺失 | P3 | 10 |

### G. 部署形态与附加特性（差距最大维度）

| # | 差距 | Codeg 参照 | VibeX 现状 | 严重度 | Phase |
|---|------|-----------|-----------|--------|-------|
| G1 | 独立 Web 服务器（Axum HTTP+WS、token 鉴权、静态资源） | `bin/codeg_server.rs`（419 行）、`web/*` | 完全缺失 | 核心 | 8 |
| G2 | 前端传输层抽象（Tauri IPC / HTTP+WS / Remote 三模式） | `src/lib/transport/*` | 直接 invoke()，无抽象 | 核心 | 8 |
| G3 | Supervisor + 原地自更新 + 回滚 | `supervise.rs`、`update/*` | 完全缺失 | 核心 | 8 |
| G4 | Docker 部署（多阶段构建 + compose） | `Dockerfile`、`docker-compose.yml` | 完全缺失 | 核心 | 8 |
| G5 | 安装脚本（install.sh / install.ps1） | 根目录 | 仅 npx-cli | 高 | 8 |
| G6 | Chat Channels（Telegram/Lark/iLink：远程任务、审批、日报） | `chat_channel/*`（20+ 文件） | 完全缺失 | 核心 | 9 |
| G7 | Project Boot 可视化建项（shadcn init、实时预览、包管理器检测） | `app/project-boot/*`、`commands/project_boot.rs` | 完全缺失 | 重要 | 10 |
| G8 | 系统托盘、窗口状态、缩放持久化 | `commands/windows.rs` | 基础 | 中 | 10 |
| G9 | 上传配额与隔离（quota + jail） | `web/handlers/upload_jail.rs` | 缺失 | 中 | 8 |
| G10 | Pets 桌面宠物 | `pets/*`、`app/pet/*` | 缺失 | 可选 | 10（可裁剪） |

### H. 基线健康问题（本仓库自身，先于一切修复）

| # | 问题 | 证据 | Phase |
|---|------|------|-------|
| H1 | `cargo test --workspace` 编译失败：`db` crate SQLx `query!` E0282（DATABASE_URL/离线缓存配置） | 基线运行输出 | 0 |
| H2 | 前端 4 个测试失败（含 `UseSessionComposerDraftScratch.test.tsx`，疑与在途 AgentSettings/runtime 修改相关） | 基线 vitest 输出 | 0 |
| H3 | `CLAUDE.md`/`AGENTS.md` 在工作树中被删除（未提交），项目契约缺失 | git status | 0（需产品负责人确认意图） |
| H4 | 在途未提交修改（agents 运行时 + AgentSettings 约 1,284 行新增）未形成提交保存点 | git status | 0 |

## Phase 地图与顺序

| Phase | Slug | 内容 | 前置 |
|-------|------|------|------|
| 0 | `00-baseline-stabilization` | 修复 H1-H4：测试基线全绿、在途工作形成保存点 | 无 |
| 1 | `01-agent-session-core` | A1-A14：会话恢复、31 种事件、模式/配置/命令、权限体系、Preflight、认证检测 | 0 |
| 2 | `02-conversation-rendering` | C1-C16：流式渲染、Shiki、stick-to-bottom、工具卡片体系、输入增强 | 1 |
| 3 | `03-conversation-aggregation` | B1-B9：7 解析器、统一会话模型、导入服务、聚合 UI | 1 |
| 4 | `04-workbench-engineering-loop` | D1-D9 + C17：worktree UI、多终端、diff 导航、编辑器面板、delta 推送 | 0 |
| 5 | `05-mcp-skills-git-accounts` | E4-E10：Git 账户/keyring/凭证助手、MCP 扫描+市场、Skills CRUD | 1 |
| 6 | `06-multi-agent-delegation` | E1-E3：vibex-mcp sidecar、DelegationBroker、委托 UI | 1, 5 |
| 7 | `07-settings-i18n` | F1-F7：i18n 框架与 10 语言、代理、外观深度、preferences、备份 | 2 |
| 8 | `08-server-deployment` | G1-G5, G9：vibex-server、传输抽象、Docker、安装脚本、自更新 | 1 |
| 9 | `09-chat-channels` | G6：Telegram/Lark/iLink 接入 | 8 |
| 10 | `10-project-boot-extras` | G7-G8, F8, G10：Project Boot、托盘/窗口、快速消息、宠物（可选） | 7 |

依赖说明：2/3/5/8 可在 1 完成后并行（各自 worktree）；7 依赖 2 的 UI 稳定以减少
翻译返工；9 依赖 8 的事件总线；6 依赖 5 的 MCP 写入面。

## 不在范围内（明确排除）

- Codeg 的赞助商/社区内容、品牌资产。
- `code-reference/`、`code-referance/` 目录不动。
- Next.js 迁移：VibeX 保持 Vite + React 架构，对齐的是能力而非框架（传输抽象
  层为此专门设计）。
