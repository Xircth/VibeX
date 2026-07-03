# Agent 身份收敛为单一枚举 AgentKind，住在 api-types，serde 用既有 snake_case 键

历史上 agent 身份有三套并行概念（`AgentType`、`BaseCodingAgent`、`CodingAgent`），因 `agents` 与 `executors` 互不依赖而只能靠六处字符串 match 桥接，新增 agent 漏改任何一处都不会编译报错。我们决定：单一枚举 `AgentKind` 放进 `crates/api-types`（两者共同的叶子依赖，同时清除其中零引用的 issue-tracker 死模块），serde 采用 DB 已持久化的 snake_case 键（`claude_code` 等）实现零数据迁移，读边界保留对历史杂拼写（SCREAMING/Pascal）的宽容解析。

## Considered Options

- 新建专用叶子 crate —— 被否决：为一个枚举增加 workspace 成员，且 api-types 的垃圾抽屉问题仍悬置。
- 让 executors 依赖 agents 复用 AgentType —— 被否决：与 executor 退役方向相反，legacy crate 反而与目标 crate 绑得更紧，并把 agents 的重依赖拖进所有 executors 依赖方。

## Consequences

- QaMock 作为枚举的常驻第 8 个变体：`qa-mode` 特性门控的是 mock 执行器的**可用性**，不是身份本身——特性门控枚举变体会给 serde/TS 导出带来无谓麻烦。
- `registry_id`（如 `claude-acp`）是注册表条目的元数据，与身份枚举是两个概念，保留在 registry 层，不参与统一。
- `agent_runtime` 表群（第一代 ACP 表）在迁走三处活跃用途后 DROP：只写不读的影子事件槽直接删除；`agent_permissions` 快照合并在启动恢复（ADR-0001）落地后失去存在理由随之删除；`agent_history_imports` 的存量数据 INSERT SELECT 迁入 `conversation_imports`，导入功能保留。
