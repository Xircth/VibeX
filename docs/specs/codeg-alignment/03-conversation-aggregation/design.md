# Design: Phase 3 — 历史会话聚合导入

## 所属层

- 解析器：`crates/agents/src/history/`（扩展既有模块：mod.rs 拆分为
  `mod.rs` + `parsers/{claude,codex,opencode,gemini,openclaw,cline,hermes}.rs`
  + `normalize.rs` + `paths.rs`）
- 存储：`crates/db` 新增 `imported_conversations` 与
  `imported_conversation_turns` 表 + import service
- 命令面：`src-tauri/src/commands/`（新增 conversations 命令组）
- 前端：项目页会话列表（聚合视图）、会话详情复用 Phase 2 渲染层

## 参照实现（Codeg）

逐文件对照移植（保留 Apache-2.0 出处标注）：
`parsers/mod.rs`（ExternalSource、path_eq_for_matching、
infer_context_window_max_tokens）、`parsers/claude.rs`（JSONL、ai-title、
structuredPatch 重建、relocate_orphaned_tool_results）、`parsers/codex.rs`、
`parsers/opencode.rs`（SQLite 查询）、`parsers/gemini.rs`、`parsers/cline.rs`、
`parsers/hermes.rs`、`parsers/openclaw.rs`、
`db/service/import_service.rs`（去重/标题锁/软删除规则）。

移植原则：解析逻辑可大段移植（纯函数为主），但落库层重写为 SQLx（Codeg 用
SeaORM，VibeX 用 SQLx——不引入 SeaORM）。

## 数据模型

```sql
CREATE TABLE imported_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  project_path TEXT,            -- 归一化后的项目根
  title TEXT, title_locked INTEGER NOT NULL DEFAULT 0,
  status TEXT, model TEXT, git_branch TEXT,
  parent_external_id TEXT,
  parent_tool_use_id TEXT,
  delegation_call_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, ended_at TEXT,
  raw_source_path TEXT,
  raw_source_mtime TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, pinned_at TEXT,
  UNIQUE(agent_type, external_id)
);
-- turns 全量内容不入库（体量大、源文件即真相）：
-- 详情按需从源文件解析（与 Codeg 一致：summary 入库、detail 现读）
```

设计决策：会话详情**现读**（打开时解析源文件），只有 summary 入库。理由：
Codeg 同策略，避免数据库膨胀与双写一致性问题。Rejected: 全量入库（同步复杂、
收益低）。

## 模块要点

- `paths.rs`：normalize_path_for_matching / path_eq_for_matching（Windows
  小写、分隔符统一、去尾斜杠、剥 `\\?\` 前缀）+ env 覆盖解析。
- `normalize.rs`：ContentBlock 归一化（Text/Thinking/ToolUse/ToolResult/
  Image）、structuredPatch→unified diff 重建、孤立 tool_result 重定位、Read
  工具输出结构化。
- `parsers/*`：每个 parser 暴露 `list_summaries(source)` 与
  `load_detail(summary)`；list 阶段绝不加载不必要的大正文，detail 阶段可按需重读
  源文件。
- import service：`import_for_project(project_path) -> ImportResult
  {imported, updated, skipped}`；幂等规则见 requirements 验收 2。
- 命令面：`list_imported_conversations(filter)`、`get_imported_conversation_detail(id)`、
  `import_project_conversations(project_id)`、`pin/unpin`、`rename(title)`、
  `soft_delete`。
- 前端：项目会话列表加「导入的会话」聚合区（按 agent_type 图标分组、搜索框、
  pin 区），详情页走 NormalizedConversation 渲染。

## Import Service 决策表

| 状态 | 动作 | updated_at |
|---|---|---|
| `(agent_type, external_id)` 不存在 | 插入 summary | 使用源会话 ended/updated/start 时间 |
| 已存在，`deleted_at IS NOT NULL` | 跳过，不复活 | 不变 |
| 已存在，title 未锁且新 title 更好 | 更新 title、message_count、model、status | 不变，除非源会话活动时间更新 |
| 已存在，title 已锁 | 更新非标题字段 | 不变，除非源会话活动时间更新 |
| source mtime 未变 | 跳过 detail 级扫描 | 不变 |
| parent/delegation 字段变化 | 更新关系字段 | 不变 |

“新 title 更好”的定义：非空、不同于首条用户消息截断标题、来自 Agent 原生 ai-title
或等价高置信字段。

## 新依赖

- `rusqlite`（只读打开 OpenCode/Hermes 的 SQLite；SQLx 不适合 attach 外部任意
  库文件的只读即席查询）。理由记录：Codeg 同等需求。备选：`sqlx` 动态连接
  （拒绝：连接池/迁移语义多余，且无法方便地 immutable+readonly 打开）。

## 测试策略

- 每解析器一组 fixture（`crates/agents/fixtures/history/` 既有目录扩展），
  覆盖正常/损坏/空目录。
- import service：幂等三连导测试、标题锁测试、软删除不复活测试。
- paths：表驱动跨平台匹配测试。
- 性能：200 会话 fixture 目录导入计时断言（粗门 5s）。

## 风险

- 各 CLI 存储格式随版本漂移：解析器对未知字段宽容（serde deny_unknown 关闭），
  以 fixture 锁已知格式。
- Windows 路径匹配是高发 bug 区：表驱动测试先行。
