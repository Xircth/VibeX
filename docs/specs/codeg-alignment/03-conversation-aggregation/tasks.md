# Tasks: Phase 3 — 历史会话聚合导入

执行环境：worktree `../VibeX-conversation-aggregation`，分支
`feature/conversation-aggregation`。

- [ ] T3.1 统一模型与类型边界
  - Acceptance: 定义 `AgentType`、`ConversationSummary`、`ConversationDetail`、
    `MessageTurn`、`ContentBlock`、`SessionStats`、`TurnUsage`，能表达 Codeg
    `models/conversation.rs` 与 `models/message.rs` 的字段；前端类型生成通过。
  - Verify: `cargo test -p agents history_models`; `pnpm run generate-types:check`
  - Files: `crates/agents/src/history/mod.rs`, `crates/agents/src/history/types.rs`

- [ ] T3.2 路径与数据源解析
  - Acceptance: 实现 `external_transcript_sources()`、env 覆盖、home fallback、
    `normalize_path_for_matching()`、`path_eq_for_matching()`；覆盖 Windows
    `\\?\`、UNC、大小写、尾斜杠、中文/空格路径。
  - Verify: `cargo test -p agents history_paths`
  - Files: `crates/agents/src/history/paths.rs`

- [ ] T3.3 Fixture 体系与脱敏样本
  - Acceptance: 每类 Agent 至少有 list/detail 正常样本；包含损坏 JSONL、空目录、
    locked SQLite、中文路径样本；所有 fixture 可公开提交或已脱敏。
  - Verify: `rg -n "sk-|AKIA|BEGIN.*PRIVATE|Authorization" crates/agents/fixtures` 无命中
  - Files: `crates/agents/fixtures/history/**`

- [ ] T3.4 第一批 parser：Claude Code + Codex
  - Acceptance: Claude 解析 JSONL、ai-title、slash command、thinking、tool use/result、
    structuredPatch、子代理统计；Codex 解析 session_meta、turn_context、
    event_msg、response_item、usage。
  - Verify: `cargo test -p agents history_claude history_codex`
  - Files: `crates/agents/src/history/parsers/{claude,codex}.rs`

- [ ] T3.5 第二批 parser：OpenCode + Gemini
  - Acceptance: OpenCode 只读打开 SQLite 并解析 session/message；Gemini 支持
    tmp/history JSON/JSONL 与增量合并；模型、cwd、时间、标题可提取。
  - Verify: `cargo test -p agents history_opencode history_gemini`
  - Files: `crates/agents/src/history/parsers/{opencode,gemini}.rs`

- [ ] T3.6 第三批 parser：Cline + Hermes + OpenClaw
  - Acceptance: Cline 解析 taskHistory/api_conversation_history；Hermes 解析
    state.db；OpenClaw 解析 agents 目录；未知字段宽容、损坏单会话跳过。
  - Verify: `cargo test -p agents history_cline history_hermes history_openclaw`
  - Files: `crates/agents/src/history/parsers/{cline,hermes,openclaw}.rs`

- [ ] T3.7 内容规范化后处理
  - Acceptance: 实现 tool_result 重定位、Read 输出结构化、patch hunk 行号补全、
    apply_patch/structuredPatch → unified diff、模型上下文窗口推断。
  - Verify: `cargo test -p agents history_normalize`
  - Files: `crates/agents/src/history/normalize.rs`

- [ ] T3.8 数据库迁移与 import service
  - Acceptance: 新增 `imported_conversations`（或最终命名）表；支持
    `(agent_type, external_id)` 去重、title_locked、pinned_at、deleted_at、
    raw_source_path；导入三连导幂等。
  - Verify: `pnpm run prepare-db:check`; `cargo test -p db imported_conversations`
  - Files: `crates/db/migrations/*`, `crates/db/src/models/*`,
    `crates/db/src/services/imported_conversation_service.rs`

- [ ] T3.9 导入命令面
  - Acceptance: Tauri commands 覆盖 `import_project_conversations`、
    `list_imported_conversations`、`get_imported_conversation_detail`、`rename`、
    `pin/unpin`、`soft_delete`；错误返回结构化 message。
  - Verify: `cargo test -p vibex-tauri conversations_commands` 或对应 crate 测试
  - Files: `src-tauri/src/commands/conversations.rs`, command registry

- [ ] T3.10 项目打开自动导入 + 手动刷新
  - Acceptance: 项目打开时后台导入，失败不阻塞页面；项目页提供刷新按钮、导入
    统计 toast；200 会话目录 5s 内完成粗性能门。
  - Verify: Rust 性能 fixture + 桌面手动冒烟。
  - Files: project open flow、frontend API hooks

- [ ] T3.11 聚合会话列表 UI
  - Acceptance: 列表支持按项目、Agent 类型、状态、搜索、pin 分区；Agent 图标与
    message_count/model/git_branch 显示；软删除隐藏。
  - Verify: frontend component tests + 手动 UI 冒烟。
  - Files: `frontend/src/components/conversations/*`, project/session list routes

- [ ] T3.12 导入会话详情接 Phase 2 渲染层
  - Acceptance: 打开导入会话时按需重读源文件并渲染完整 detail；文本、thinking、
    工具、diff、图片、stats 都通过 Phase 2 `AdaptedContentPart`。
  - Verify: fixture detail snapshot + 桌面打开 7 类 Agent 各一条会话。
  - Files: `frontend/src/lib/api/conversations.ts`,
    `NormalizedConversation` adapter 接线

- [ ] T3.13 文件监听/mtime 增量同步（可裁剪优化）
  - Acceptance: 记录每个 source mtime；手动刷新时跳过未变化 source；若实现文件
    watcher，新增/变化会话可增量导入。
  - Verify: 临时目录新增 JSONL 测试；若裁剪，记录后续 Phase。
  - Files: `crates/agents/src/history/source_index.rs`

- [ ] T3.14 全量回归与追踪矩阵更新
  - Acceptance: `traceability.md` 中 B 类差距标记完成/裁剪；7 parser fixture、
    导入幂等、UI 聚合全绿。
  - Verify: `pnpm run check`, `pnpm run lint`, `cargo test --workspace`,
    `cd frontend && pnpm vitest run`
