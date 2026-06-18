# Spec: 代码审查报告优化（分阶段治理）

> 状态：进行中 ｜ 创建：2026-06-18 ｜ 来源：[docs/代码审查报告.md](../代码审查报告.md)
> 方法论：spec-driven-development（SPECIFY→PLAN→TASKS→IMPLEMENT）+ ai-slop-cleaner（回归测试先行、单 smell 单遍、安全→风险排序）
> 用户决策：**全部纳入（含 4 项大改），分阶段顺序做，每阶段后报告即继续**

## Objective

把 [代码审查报告](../代码审查报告.md) 的全部发现转化为分阶段、行为保持的优化，提升代码诚实度（消除掩盖型 fallback）、清洁度（删死代码）、一致性（DRY/i18n）与性能。**不改变现有用户可见行为**（除非该行为本身是被修复的 bug），**不做安全报告范畴的优化**（凭据加固、CSP、fs 沙箱等）。

成功 = 报告内全部 §1–§7 发现被处理（修复 / 显式失败 / 删除 / 记录为有依据保留），且每阶段质量门通过。

## Tech Stack

- 后端：Rust（nightly，见 `rust-toolchain.toml`），cargo workspace，sqlx+sqlite（离线查询缓存），tokio。
- 前端：React + TypeScript + Vite，vitest，pnpm workspace。
- 桥接：Tauri IPC + 生成的 `shared/types.ts`（**禁止手改**）。

## Commands

```bash
# 质量门（每阶段后运行相关项）
pnpm run check                 # 前端 tsc --noEmit + cargo check（快速预检）
pnpm run lint                  # eslint(max-warnings 0) + clippy -D warnings --features qa-mode
cargo test --workspace         # 后端全部测试
cargo test -p <crate> <filter> # 单 crate / 单测过滤
cd frontend && pnpm test       # vitest run（全部）
cd frontend && pnpm exec vitest run <file>   # 单文件
pnpm run generate-types        # 改了 #[derive(TS)] 类型后必跑
pnpm run prepare-db            # 改了 sqlx 宏/迁移后必跑（CI 校验）
```

## Project Structure（受影响区域）

```
crates/agents/          → ACP 运行时（幽灵 session、TryFrom、tool 状态）
crates/services/        → worktree/container/git_host/diff_stream/file_search/config（fallback、DRY、性能）
crates/git/             → git CLI（rebase_onto、merge_base、panel_ops、死函数）
crates/db/              → 事件溯源投影、N+1、侧表（fallback、性能大改）
crates/executors/       → BaseCodingAgent（TryFrom 目标）
crates/local-deployment/→ process_completion
src-tauri/src/          → conversation_service / events / commands（error.rs、5xx 分类、性能）
frontend/src/           → 对话渲染（死代码、多重实现、流式性能）、hooks（React bug）、i18n
docs/specs/             → 本规格
```

## Code Style（关键约定，与现有代码库一致）

- **Fallback 诚实化原则**：fallback 分支必须 `warn!`/`console.warn` 留痕；破坏性操作（覆盖文件、rebase、删除）的前置校验失败必须显式 `?`/抛错，**禁止**静默退化为默认值。
- **错误传播**：Rust 用 `Result + ?`，区分"合法空态"与"失败"。前端区分"用户取消"与"真实错误"。
- **注释语言**：与所在文件现有注释语言保持一致（自动检测，中/英不混入新风格）。
- 示例（fallback 诚实化）：
  ```rust
  // ❌ 旧：失败被吞成默认值
  let sid = self.agent_session_for_acp(id).await.unwrap_or_default();
  // ✅ 新：失败显式拒绝并留痕
  let Some(sid) = self.agent_session_for_acp(id).await else {
      tracing::warn!(acp_session = %id, "permission request for unknown session — rejecting");
      return Err(acp::Error::invalid_params());
  };
  ```

## Testing Strategy

- **回归测试先行（ai-slop-cleaner 强制）**：每个 Pass 编辑前，先确认/补齐覆盖该行为的测试；对掩盖型 fallback，必须同时覆盖"主路径"与"原 fallback 现在显式失败"两种情形。
- 后端：`cargo test -p <crate>`，新增针对性单测（如 v6 迁移未知 executor、process_completion 通道关闭、event append 幂等）。
- 前端：`vitest`，针对 hook（useDebouncedCallback/useVideoProgress）与 turn 渲染（messageTurnBlocks 配对）补测。
- 大改（Phase 8/9）：先建端到端/快照测试锁定投影输出与渲染输出，再重构。

## Boundaries

- **Always**：每阶段后跑相关质量门；改 TS 导出类型跑 `generate-types`；改 sqlx 跑 `prepare-db`；保持 diff 最小且按阶段分离。
- **Ask first**：引入新依赖（尤其 §7.1 i18n 框架选型）；新增 DB 迁移/改投影 schema（§8）；任何会改变用户可见行为的取舍；删除当前虽未引用但可能是公共/契约 API 的导出。
- **Never**：手改 `shared/types.ts`；删除失败的测试来"通过"门禁；把无关重构混入同一编辑集；做安全报告范畴的改动。

## Phased Plan（安全→风险）

| 阶段 | 内容 | 报告条目 | 风险 |
|---|---|---|---|
| **0** | 绿色基线 + 行为锁定 | — | 无 |
| **1** | 死代码删除 | §2.2 影子开关、§2.3 未消费 API、§2.6 死封装、§3 死函数/stub | 低（零/可逆） |
| **2** | 掩盖型 Fallback 诚实化 | §1.1–§1.10（全部） | 中（行为修正，需测试锁定） |
| **3** | 多重实现/DRY 收敛 | §2.1 useConversationHistory、§2.4 TryFrom、§2.5、§2.6 | 中 |
| **4** | 错误处理一致性 | §4.1 AppError code、§4.2 5xx 分类 | 中（前端契约联动） |
| **5** | React 模式/资源 | §6 hook bug + 监听泄漏 + 无界增长 | 低-中 |
| **6** | 局部性能 | §5.4 spawn_blocking、§5.6 N+1/轮询/coalescer/memo/context 拆分 | 中 |
| **7** | i18n/文案一致性 | §7.2 时间格式化去重、§7.1 i18n 框架（**选型需确认**） | 中-高（面广） |
| **8** | 事件溯源/事件流性能大改 | §5.1 投影快照+增量重放、§5.2 事件流去全局单通道 | 高（DB/协议） |
| **9** | 渲染大改+巨型组件拆分 | §5.3 流式合批/去深拷贝、§5.5 文件树虚拟化、§6 巨型组件 | 高 |

**执行节奏**：每阶段完成 → 跑质量门 → 报告变更+测试结果 → 自动进入下一阶段（测试失败或遇 "Ask first" 边界时暂停）。

## Tasks（逐阶段细化，实施时逐条勾选）

### Phase 1 — 死代码删除
- [ ] T1.1 删 `usesAgentTranscript=false` 影子开关 + 内联 false 分支（VirtualizedList.tsx）｜验证：tsc+vitest｜文件：VirtualizedList.tsx
- [ ] T1.2 删 `useConversationTimeline` 未消费返回 + store 乐观 reducer/协调函数（确认全局零调用后）｜验证：grep 零引用 + vitest｜文件：useConversationTimeline.ts, conversationStore.ts
- [ ] T1.3 删 4 个死 api 封装（agentsApi.conversationDetail/List/resetToCheckpoint, conversationApi.detail/list，确认零引用）｜验证：grep + tsc｜文件：features/agents/api.ts, conversationApi.ts
- [ ] T1.4 删 `merge_ff_or_merge` 死函数（确认零调用）｜验证：cargo check｜文件：crates/git/src/cli.rs
- [ ] T1.5 处理 §3 stub：QuestionResponded/FeedbackSubmitted 投影、Azure list_open_prs、delegation mock 响应——改为显式列出+注释或显式未实现错误（非删除）｜验证：cargo test

### Phase 2 — 掩盖型 Fallback 诚实化（用户最高关注）
- [ ] T2.1 幽灵 session：manager.rs 1570/1739 → warn+拒绝
- [ ] T2.2 config v6 迁移未知 executor → 保留/warn（含新单测）
- [ ] T2.3 backup_existing → 返回 Result，失败拒绝写入（仅错误处理，不含安全加固）
- [ ] T2.4 rebase_onto merge_base 失败 → `?` 传播
- [ ] T2.5 extensions.json 解析失败 → warn+return（不覆盖）
- [ ] T2.6 diff_stream compute_diff_stats → 返回 Result
- [ ] T2.7 §1.8 批量：merge_base 惰性求值、panel_ops numstat warn、container head_info warn、conversation_side_effects rows_affected、process_completion 区分通道关闭、mcp_market Result<Option>
- [ ] T2.8 前端 GitOperations 取消 vs 错误区分
- [ ] T2.9 前端 messageTurnBlocks LIFO 配对校验+warn
- [ ] T2.10 conversation_service event kind → expect 表达不变量

### Phase 3 — 多重实现/DRY 收敛
- [ ] T3.1 `BaseCodingAgent: TryFrom<AgentType>` 收敛字符串匹配 + round-trip 测试
- [ ] T3.2 github/azure CLI 抽 `run_host_cli` + 统一错误类型
- [ ] T3.3 workspace/worktree manager 的 canonicalize_for_safety 去重
- [ ] T3.4 merge_changes CLI/git2 前置校验对称化
- [ ] T3.5 前端聚合/折叠逻辑抽共享纯函数；tool 状态三态→补 denied/timed_out
- [ ] T3.6 useConversationHistory 收敛为脚本进程语义，删 agent 专用死分支

### Phase 4 — 错误处理一致性
- [ ] T4.1 AppError 增 `code`，序列化为 `{kind,message,code}`（前端联动消费）
- [ ] T4.2 model_provider 上游 5xx→Internal；Codex render 对齐 ok_or_else

### Phase 5 — React 模式/资源
- [ ] T5.1 useDebouncedCallback delay 入 ref
- [ ] T5.2 useVideoProgress 改 callback ref
- [ ] T5.3 拖拽监听用 AbortController + 卸载兜底
- [ ] T5.4 useLogStream 滚动窗口上限
- [ ] T5.5 useUiPreferencesScratch setTimeout 清理

### Phase 6 — 局部性能
- [ ] T6.1 file_search 两处同步 git2/整仓遍历 → spawn_blocking
- [ ] T6.2 event append 去预查 + ON CONFLICT；文件变更批量 insert
- [ ] T6.3 diff_stream 1Hz 轮询 → 事件驱动/拉长
- [ ] T6.4 ToolCall/Usage 纳入 coalescer
- [ ] T6.5 broadcast lag N+1 → 单条聚合 SQL
- [ ] T6.6 前端 messageTurnTool JSON.parse memo；EntriesContext 拆 entries/tokenUsage
- [ ] T6.7 async fs 同步写 → tokio::fs/spawn_blocking（image/history import）

### Phase 7 — i18n/文案一致性
- [ ] T7.1 时间格式化三函数统一到 utils/date.ts
- [ ] T7.2 i18n 框架选型（**Ask first**）+ 文案集中 + 统一语言基线

### Phase 8 — 事件溯源/事件流性能大改
- [ ] T8.1 投影快照表 + 增量重放 + rebuild_projection（先建快照测试锁定输出）
- [ ] T8.2 事件流去全局单通道双扇出 + 进程更新重算 workspace 去抖

### Phase 9 — 渲染大改+巨型组件拆分
- [ ] T9.1 前端流式合批 + 去 structuredClone + DisplayConversationEntry memo
- [ ] T9.2 文件树虚拟化
- [ ] T9.3 巨型组件抽 hook/子组件（FileTreePanel/McpSettings/SessionComposerInput/IDELayout）

## Success Criteria

- [ ] §1–§7 全部发现：已修复 / 已显式失败 / 已删除 / 已记录为有依据保留（逐条对照报告）。
- [ ] `pnpm run check`、`pnpm run lint`、`cargo test --workspace`、`vitest` 全绿。
- [ ] 无新增掩盖型 fallback；新增的显式失败路径有测试覆盖。
- [ ] `shared/types.ts` 经 `generate-types` 同步；`.sqlx` 经 `prepare-db` 同步（如涉及）。
- [ ] 每阶段 diff 最小、按阶段分离，无无关重构混入。

## Open Questions

1. **§7.1 i18n 框架选型**（react-i18next / @lingui / 轻量自研常量表）+ 统一语言基线（中文 or 英文）——进入 Phase 7 前确认。
2. **§8 投影快照**是否新增 DB 迁移与 schema——进入 Phase 8 前确认迁移策略（CI 会校验 `.sqlx`）。
3. 部分"未消费 API/导出"删除前需确认非外部契约（Phase 1 内逐项 grep 验证）。
