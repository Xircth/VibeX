# Design: Phase 0 — 基线稳定化

## 范围内组件

- `crates/db`（SQLx 离线缓存 / `.env` DATABASE_URL 流程）
- `frontend/src/components/tasks/follow-up/*`（composer 测试簇）
- `frontend/src/components/NormalizedConversation/UserMessage.tsx` 及测试
- 在途修改涉及的 `crates/agents/src/{manager,runtime}.rs`、
  `frontend/src/pages/settings/AgentSettings.tsx`、`frontend/src/lib/tauriApi.ts`、
  `src-tauri/src/commands/agents.rs`

## H1: cargo test db 编译失败

证据：`error: could not compile db (lib): E0282 type annotations needed`
出现在 `sqlx::query!` 宏展开处（约 `crates/db/src/...:711`）。该宏在离线模式下
依赖 `.sqlx/query-*.json` 缓存；最近提交 feab5302 "Set SQLx database URL for
Tauri commands" 只覆盖了 Tauri 命令路径。

处理顺序：
1. 运行 `pnpm run prepare-db`（仓库自有脚本，负责建库+迁移+`cargo sqlx prepare`）。
2. 若缓存更新后仍失败，定位具体查询，检查是否为在途/近期提交新增查询而缓存
   未再生成。
3. 验证 `pnpm run prepare-db:check` 与 `cargo test --workspace`。

不采用的方案：`query_unchecked!`（绕过编译期校验，违反根因修复原则）；在 CI
外要求开发者手工设置 DATABASE_URL（仓库已有 prepare-db 脚本，应让它成为唯一
入口）。

## H2: 4 个前端测试失败

共同模式：均在 composer/会话输入域，失败点涉及 `BaseCodingAgent.CODEX`、文件
引用 chips、斜杠命令与 skills 排序。在途修改恰好动了
`transcript.test.ts`/`tauriApi.ts`/`AgentSettings.tsx`，且历史提交把 executor
概念迁往 agent 概念。判定矩阵：

| 测试 | 若实现变更是有意的 | 若是回归 |
|------|--------------------|----------|
| DraftScratch（期望 scratchExecutorProfile=CODEX） | 更新断言到新的 agent profile 形态 | 修 draft scratch 读取层 |
| sessionComposerSubmit（文件引用序列化） | 同步新序列化格式 | 修 serialize 函数 |
| sessionComposerTypeahead（命令排序） | 同步新排序约定 | 修 typeahead 派生 |
| UserMessage chips | 同步新 token 结构 | 修 chips 渲染 |

判定方法：`git log -p` 追溯每个被测函数最近的有意变更；对照在途 diff；在测试
内打印实际值与期望值差异。先证据后改动。

## H4: 在途工作保存点

提交切分（Lore 风格记录）：
1. `crates/agents` 运行时连接复用加固 + `src-tauri/commands/agents.rs` +
   `tauriApi.ts`（一个行为切片）。
2. `AgentSettings.tsx` 扩展 + 其测试 + transcript 测试对齐。
3. 测试基线修复（H1/H2 涉及文件）。

若 1/2 无法独立通过验证门则合并为一个提交，绝不提交红色状态。

## 验证

- `pnpm run prepare-db:check`
- `cargo test --workspace`
- `cd frontend && pnpm vitest run`
- `pnpm run check && pnpm run lint`

## 执行位置

本阶段直接在主工作树执行（不开 worktree）：在途修改就在主工作树，且本阶段的
目标正是把它们收敛为提交。
