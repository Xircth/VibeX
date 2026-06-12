# Requirements: Phase 3 — 历史会话聚合导入 (conversation-aggregation)

## Objective

实现 Codeg 的标志性能力「Conversation Aggregation」：从七类 Agent CLI 的本地
存储导入历史会话到统一工作区，支持增量更新、去重、按项目/Agent 过滤的聚合
列表，并能在 VibeX 会话视图中查看导入会话的完整内容。

对应差距：B1–B9。基础：`crates/agents/src/history/mod.rs` 既有 421 行框架
（AgentType 源定义、ImportedAgentSession 模型、Claude/Codex JSONL 雏形）——
在其上扩展，不重起炉灶。

## User Stories

- 作为用户，打开某个项目时，我能看到该项目目录下所有 Agent CLI 的历史会话
  （Claude Code、Codex、OpenCode、Gemini、OpenClaw、Cline、Hermes）。
- 作为用户，我能按 Agent 类型/状态过滤、按标题搜索、固定（pin）重要会话。
- 作为用户，我重命名过的会话标题不会被重新导入覆盖。
- 作为用户，我能打开导入的会话查看完整对话（文本、思考块、工具调用、diff）。

## Acceptance Criteria (EARS)

1. THE SYSTEM SHALL 为 7 类 Agent 各实现一个解析器，把外部存储归一化为统一
   会话模型（summary + turns + blocks + stats），数据源与默认路径对齐 Codeg
   README 表格（env 覆盖优先）：
   - Claude Code `$CLAUDE_CONFIG_DIR/projects`（JSONL）
   - Codex `$CODEX_HOME/sessions`（JSONL）
   - OpenCode `$XDG_DATA_HOME/opencode/opencode.db`（SQLite）
   - Gemini `$GEMINI_CLI_HOME/.gemini`（JSON/JSONL）
   - OpenClaw `~/.openclaw/agents`
   - Cline `$CLINE_DIR/data/tasks`（JSON）
   - Hermes `$HERMES_HOME/state.db`（SQLite）
2. WHEN 导入执行，THE SYSTEM SHALL 以 `(external_id, agent_type)` 去重：新会
   话插入；已存在且标题未锁定→仅更新自动标题；已软删除→永不复活；重复导入
   SHALL NOT 改变 updated_at 排序。
3. WHEN 用户手动重命名会话，THE SYSTEM SHALL 置 title_locked，后续导入不覆盖。
4. THE 聚合列表 SHALL 支持：按项目（路径容错匹配：分隔符/大小写/尾斜杠/UNC
   前缀）、按 agent_type、按状态过滤；标题搜索；pin/unpin（pinned_at 排序，
   不影响 recent 排序）。
5. WHEN 打开导入会话，THE SYSTEM SHALL 渲染完整内容（复用 Phase 2 渲染层）：
   文本/思考/工具调用/diff（structuredPatch 重建）/孤立 tool_result 已重定位。
6. IF 单个文件解析失败，THEN THE SYSTEM SHALL 跳过该会话并记录告警，导入
   流程继续（不因单点损坏中断）。
7. THE 导入 SHALL 可由用户手动触发（项目页刷新按钮）并在项目打开时自动执行；
   全量扫描一个含 200 个会话的目录 SHALL 在 5s 内完成（性能门）。

## Parser Detail Requirements

| Agent | 必须支持的数据形态 | 必须提取字段 | 特殊处理 |
|---|---|---|---|
| Claude Code | JSONL transcript、`projects/*/*.jsonl` | cwd、session id、ai-title、model、usage、tool use/result、thinking | slash command 展开、structuredPatch 重建、孤立 tool_result 重定位、子代理统计 |
| Codex | `~/.codex/sessions/**/*.jsonl` | session_meta、turn_context、event_msg、response_item、model、usage | response item 多类型归一、turn 顺序稳定、goal/update 事件保留 |
| OpenCode | SQLite `opencode.db` | session、message、model、project path、timestamps | 只读打开，被锁定时重试后跳过 |
| Gemini | tmp/history JSON/JSONL | cwd、title、model、message turns、usage | tmp 与 history 增量合并，重复 turn 去重 |
| Cline | `taskHistory.json`、`api_conversation_history.json` | task id、title、messages、tool calls、结果 | attempt_completion/task_progress 专门归一 |
| Hermes | SQLite `state.db` | conversation/session/message | schema 漂移宽容，未知列忽略 |
| OpenClaw | `~/.openclaw/agents` 目录 | agent/session/message/tool metadata | 嵌套文件结构扫描，损坏单文件隔离 |

## Import Semantics

- Summary 入库，detail 默认按需从源文件现读；如执行中发现源文件会被清理，可在
  design.md 追加 detail 缓存方案后再实现。
- `updated_at` 表示源会话最近活动时间，不因 pin/unpin、重复导入、用户改名而改变。
- `pinned_at` 只影响 pin 分区排序，不改变 recent 排序。
- `title_locked=true` 后，导入服务只更新 message_count/model/status 等非标题字段。
- `deleted_at` 非空的导入会话不再被自动复活；用户需显式恢复（本阶段可不提供恢复 UI）。
- 子代理/委托子会话默认不进入主 sidebar 顶层列表，但 detail 中必须可被父会话引用。

## Edge / Error Cases

- 损坏 JSONL 行：跳过行，会话仍导入（fixture: corrupt-jsonl 已存在）。
- SQLite 数据库被 Agent 进程锁定：以只读+重试打开，失败则跳过并提示。
- 路径包含中文/空格/UNC：归一化匹配（Codeg path_eq_for_matching 行为）。
- 同一会话被两个项目路径前缀匹配：按 cwd 精确匹配优先。

## Boundaries

- Always：每个解析器配 fixture 测试（真实样本脱敏）；迁移后 prepare-db。
- Ask first：无。
- Never：把解析逻辑放进前端；手改 shared/types.ts。

## Success Criteria

- 7 个解析器 fixture 测试全绿；导入幂等性测试（连导三次结果一致）通过；
  聚合 UI 可过滤/搜索/固定；全门绿。

## Open Questions

- OpenClaw 的会话存储格式版本差异（执行时以本机样本 + Codeg parser 为准）。
