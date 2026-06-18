# Spec：VibeX 架构债全盘根治（A-1 ～ A-10）

> 来源：`docs/架构审查报告.md`（2026-06-18）｜ 工作分支：`refactor/arch-remediation` ｜ worktree：`../VibeX-arch-remediation`
> 关联：`docs/代码审查报告.md`（§5.1 读放大、§1.x 掩盖型 fallback）、`docs/安全审查报告.md`
> 原则：不回避问题、不用次等方案、追求根治、追求完美。每批次独立可验证。

---

## 1. Objective（目标与成败标准）

把架构审查报告判定的三类系统性债**根治**到位，使 VibeX 架构质量从 6.5/10 上探到 8/10：

1. **恢复"薄命令层"契约**：`src-tauri` 命令文件退回"解析→调 `deployment.service`→序列化"，纯业务逻辑全部下沉到 `crates/services` / 新 crate，可被复用、可脱离 Tauri 单测。
2. **兑现事件溯源核心保证**：事件 append 与投影 apply 同事务；提供从权威事件流 `rebuild_projection` 的重建路径；`projection_version` 成为有重放支撑的活字段。
3. **让 DI 抽象真正可替换**：`Deployment` trait 改造为对象安全，`AppState` 持 `Arc<dyn Deployment>`，命令层可注入 mock。
4. **消除靠纪律维持的并发风险**：对话运行时态聚合为专用管理器，用方法封装锁顺序。
5. **收口过渡债**：桥接 wrapper 单一化、冗余字段标记弃用、共享类型下沉 `api-types`、拆 `ContainerService` God trait、补完委派子系统。

**用户**：VibeX 维护者 / 未来贡献者（架构可演进性是直接受益方）。
**成功定义**：见 §8 Success Criteria（逐项可测）。

---

## 2. Tech Stack

- 后端：Rust（nightly，`rust-toolchain.toml` 锁定），cargo workspace，`async-trait`、`thiserror`、`sqlx`(SQLite, offline)、`tokio`、`git2`、`ts-rs`。
- 前端：React + TypeScript + Vite + Vitest（本轮架构整改以后端为主，前端仅在类型再生成时受影响）。
- 壳层：Tauri（IPC `invoke` + 事件订阅）。

---

## 3. Commands（全用于每批次验证）

```bash
pnpm run check                 # 前端 tsc --noEmit + cargo check（快速预检）
pnpm run lint                  # eslint(max-warnings 0) + clippy -D warnings --features qa-mode
pnpm run format                # cargo fmt + prettier
cargo test --workspace         # 全部 Rust 测试
cargo test -p <crate>          # 单 crate（如 db / services / conversation）
cd frontend && pnpm test       # vitest run（仅类型/契约受影响时）
pnpm run generate-types        # 改了 #[derive(TS)] 导出后必跑
pnpm run generate-types:check  # CI 等价校验（不得 stale）
pnpm run prepare-db            # 改了 sqlx::query! 或 migration 后必跑
pnpm run prepare-db:check      # CI 等价校验（不得 stale）
```

每批次"完成"的硬门槛：`pnpm run check` + `pnpm run lint` + 相关 `cargo test` 全绿；若触及 TS 导出或 sqlx/migration，对应 `:check` 必须通过。

---

## 4. Project Structure（落点）

```
crates/
  services/src/services/
    mcp/                 → 新增：MCP 市场逻辑（A-1，承接 mcp_market.rs）
    provider_config/     → 新增：per-agent 配置渲染（纯函数）+ secrets + 备份（A-1）
    notification.rs      → 扩充：IM 通道发送逻辑（A-1，原为空置）
    usage_scanner.rs     → 新增：本地用量扫描（A-1，承接 local_usage.rs）
    container/           → 拆分 ContainerService God trait（A-10）
  conversation/          → 新 crate：turn 生命周期 + agent 事件映射（A-4）
  db/                    → A-3 事务化 + rebuild_projection；A-6 migration
  api-types/             → A-9 共享纯类型下沉落点（零依赖底座）
  agents/ executors/     → A-5 桥接导出；A-6 字段弃用；A-8 委派补完
  delegation/ vibex-mcp/ → A-8 委派功能补完
src-tauri/src/
  commands/              → 各文件回归 <50 行薄适配
  bridge.rs              → 新增：唯一的 executor↔agent_type 桥接 wrapper（A-5）
  state.rs               → AppState 持 Arc<dyn Deployment>（A-2）；聚合 ConversationRuntime（A-7）
docs/specs/arch-remediation/
  spec.md                → 本文件
  tasks.md               → Phase 3 逐批任务清单（实施时产出）
```

---

## 5. Code Style（与现有库一致）

- 错误类型用 `thiserror`，service 层返回领域 `*Error`，命令层 `From` 到 `AppError`。
- **fallback 必须 fail-loud**：禁止 `unwrap_or_default()` / `.ok()?` 把真实错误悄悄吞成默认值；破坏性操作（写配置/覆盖/删除）前置校验失败必须显式返回 `Err`（同步根治 §代码报告 1.2/1.3/1.5）。
- 渲染器写成**无 I/O 纯函数**：`fn render(agent, record) -> Result<String, _>`，便于单测。
- 注释语言跟随所在文件既有风格（自动检测），不擅自切换中英。
- `async-trait` 用于异步 trait；trait 对象安全是 A-2 的硬约束。
- 示例（纯函数渲染器 + fail-loud 备份）：
  ```rust
  /// 把 provider 记录渲染为 Codex CLI 的 config.toml 片段（无 I/O，可单测）。
  pub fn render_codex(record: &ProviderRecord) -> Result<String, ProviderConfigError> {
      let root = toml::Value::try_from(record)
          .map_err(ProviderConfigError::Serialize)?;
      let table = root.as_table()
          .ok_or(ProviderConfigError::NotATable)?; // 不再 expect panic
      Ok(toml::to_string_pretty(table)?)
  }

  /// 备份失败必须可上报；调用方据此拒绝覆盖用户真实 CLI 配置。
  fn backup_existing(path: &Path, agent: &str) -> Result<(), ProviderConfigError> {
      std::fs::create_dir_all(backup_dir(agent)?)?;
      std::fs::copy(path, backup_dest(agent, path)?)?;
      Ok(())
  }
  ```

---

## 6. Testing Strategy

- **后端单测优先**：下沉后的纯逻辑（渲染器、canonicalize、事件折叠、桥接、rebuild）必须带 `#[cfg(test)]` 单测；A-2 完成后用 mock `Deployment` 覆盖至少一个命令路径，证明 DI 真正可注入。
- **事务正确性**：A-3 增加"append 后崩溃 / apply 失败"的事务回滚测试，以及 `rebuild_projection` 与增量 apply 结果一致性测试。
- **回归**：`cargo test --workspace` 在每批次结束保持全绿；db 改动跑 `cargo test -p db`，services 跑 `cargo test -p services`。
- **契约**：触及 `#[derive(TS)]` 导出后 `pnpm run generate-types` 并提交，`generate-types:check` 必过；触及 sqlx/migration 跑 `prepare-db`。
- **前端**：仅当 `shared/types.ts` 变更影响前端时跑 `cd frontend && pnpm test` + `pnpm run check`。

---

## 7. Boundaries

- **Always（始终）**：
  - 每批次结束跑 `pnpm run check` + `pnpm run lint` + 相关 `cargo test`，全绿才算完成。
  - 触及 TS 导出/sqlx/migration 立即再生成并跑 `:check`。
  - 命令层只保留薄适配；纯逻辑一律下沉。
  - 先读后改；保持注释语言一致。
- **Ask first（先问）**：
  - 任何**数据库 migration**（A-3 投影快照表、A-6 回填）落地前先告知方案。
  - 删除/重命名对外公共 API、删除现有测试。
  - 偏离本 spec 既定批次范围的扩张。
- **Never（禁止）**：
  - 不提交密钥；不手改生成物（`shared/types.ts`、`crates/db/.sqlx`）。
  - 不为通过编译/测试而删测试或加掩盖型 fallback。
  - **不主动 git commit / push**——除非用户明确要求（本轮在 worktree 内修改，提交时机交回用户）。

---

## 8. Success Criteria（逐项可测）

| 编号 | 完成判定（可测） |
|---|---|
| A-1 | `mcp_market.rs`/`model_provider.rs`/`chat_channel.rs`/`local_usage.rs`/`prompt_enhancement.rs` 各文件行数显著下降（命令体 <50 行/命令）；新 service 模块带单测；`crates/services` 承接全部 HTTP/IO/渲染逻辑；`cargo test -p services` 覆盖渲染器与 canonicalize。同步：备份失败拒绝覆盖（修 §代码报告 1.3）、未知 executor 不静默改写（1.2）。 |
| A-2 | `Deployment` trait 对象安全；`AppState.deployment: Arc<dyn Deployment>`；存在 `MockDeployment` 且至少 1 个命令用它单测通过；`cargo check` 全绿。 |
| A-3 | `ConversationEventAppender::append` 在**单一事务**内完成 append+apply；`rebuild_projection(conversation_id)` 存在并有"重建结果==增量结果"一致性测试；崩溃/apply 失败时投影不出现脏写（回滚测试）；`QuestionResponded`/`FeedbackSubmitted` 不再被 `_ => {}` 丢弃。 |
| A-4 | 新 `crates/conversation` 承接 turn 生命周期 + 事件映射，依赖 `Deployment`+`AgentRuntime` 而非 `AppState`；`src-tauri/conversation_service.rs`/`events.rs` 瘦身为壳层接线；`cargo test -p conversation` 通过。 |
| A-5 | `agent_type_from_executor` 薄包装仅存于单一模块（`src-tauri/bridge.rs` 或 agents 导出）；原 5 处重复删除；round-trip 测试保留。 |
| A-6 | `sessions.executor` 标注 deprecated 只读 + 写入处加 `warn!`；`run_reason='CodingAgent'` 语义澄清（重命名或文档+常量）；历史 process 回填 `agent_type` 的 migration 存在且幂等。 |
| A-7 | 新 `ConversationRuntime` 管理器持有 turn_locks + runtime_states（+ streams），仅暴露方法，锁顺序在内部强制；`AppState` 不再裸暴露这些字段；评估并记录 runtime_states 是否从投影派生的结论。 |
| A-8 | 非 ClaudeCode agent 也能注入 companion；steering（feedback/ask）与 meta 持久化不再是 stub/mock（`NoopMetaWriter` 被真实实现替换，listener 不再返回 mock 占位）；硬编码上限（`STATUS_WAIT_MAX_MS`/`COMPLETED_TEXT_CAP`/`MAX_FRAME_BYTES`）提为配置。 |
| A-9 | 跨层共享纯类型（`BaseCodingAgent`/`AgentType`/`ConversationEvent` 等）下沉 `api-types`；`crates/db/Cargo.toml` 不再依赖 `agents`/`executors`（改依赖 `api-types`）；`cargo tree -p db` 验证。 |
| A-10 | `ContainerService` 按领域拆为多个聚焦 trait（ExecutionLifecycle/LogStreaming/Checkpointing/Archiving）；`Deployment::container()` 返回对象安全类型，服务于 A-2。 |

全局：`pnpm run check` + `pnpm run lint` + `cargo test --workspace` + `generate-types:check` + `prepare-db:check` 全绿。

---

## 9. 分批计划（Plan：批次、依赖、顺序、风险）

> 依据报告 §五路线图 + 依赖关系排序。每批次独立编译/测试通过后再进下一批。提交时机交回用户。

### 依赖关系（关键）
- **A-10 → A-2**：`Deployment::container()` 要从 `&impl ContainerService` 改为对象安全返回，须先保证 `ContainerService` 对象安全（拆分/收敛）。故 A-10 排在 A-2 前或同批。
- **A-9 ↔ A-3/A-4**：A-9 重新安置 `ConversationEvent` 落点；若先做 A-9，可减少 A-3/A-4 churn，但 A-9 移动量大、风险高。决策：A-9 用**再导出（re-export）**策略放在后段，A-3/A-4 先按现位置实现，A-9 完成后通过 re-export 不破坏调用方。
- **A-7 ↔ A-4**：对话运行时管理器与 conversation crate 抽取强相关，**合并为同一批**实施更稳。

### 批次定义

| 批次 | 覆盖 | 优先级 | 风险 | 依赖 |
|---|---|---|---|---|
| **B1** 事件溯源事务化 | A-3 | P0 | 中（事务+migration） | 无 |
| **B2** 桥接收敛 | A-5 | P2→提前 | 低（机械去重） | 无（先做练手、立即收益） |
| **B3** 命令层下沉·MCP | A-1（mcp_market） | P0 | 中（量大） | 无 |
| **B4** 命令层下沉·Provider | A-1（model_provider）+ §代码报告 1.2/1.3 fail-loud | P0 | 中（量大+安全相关） | 无 |
| **B5** 命令层下沉·通知/用量/增强 | A-1（chat_channel/local_usage/prompt_enhancement） | P0 | 中 | 无 |
| **B6** ContainerService 拆分 | A-10 | P1 | 中（God trait） | 无（为 B7 铺路） |
| **B7** DI dyn-safe 化 | A-2 | P1 | **高**（trait 改造+228 点） | B6 |
| **B8** conversation crate + 运行时管理器 | A-4 + A-7 | P0/P1 | **高**（抽 crate+锁封装） | B7（依赖 `Arc<dyn Deployment>`）|
| **B9** 共享类型下沉 | A-9 | P2 | 中（移动 ConversationEvent） | B8 后更稳 |
| **B10** 过渡债收尾 | A-6 | P2 | 低（弃用+migration） | 无 |
| **B11** 委派补完（新功能） | A-8 | 末位 | 中（功能开发） | 独立 |

### 推荐执行顺序
`B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 → B11`

- 先 **B1**（高价值、自包含、立刻兑现事件溯源保证）与 **B2**（零风险去重、建立节奏）。
- 中段 **B3~B5** 清空命令层（src-tauri 瘦身的主体收益）。
- 后段 **B6→B7→B8** 是地基改造链（容器拆分→DI dyn 化→对话 crate/锁封装），风险最高、放在已有充分回归基础之后。
- 收尾 **B9/B10/B11** 解耦数据层、清过渡债、补委派功能。

### 风险与缓解
- **B7（DI 改造）**：trait 去 `Clone`/移 `new()`/`container()→&dyn` 可能引发广播式编译错误。缓解：先在 B6 确保 `ContainerService` 对象安全；B7 内先改 trait 定义跑 `cargo check` 收敛错误，再逐 crate 修复；保留 `LocalDeployment::new()` 为关联函数（不在 trait 上）。
- **B8（抽 crate）**：循环依赖与 `AppState` 耦合。缓解：新 crate 只依赖 `Deployment`+`AgentRuntime`+`db`；`AppState` 注入依赖而非被依赖。
- **B9（移类型）**：`ConversationEvent` 若依赖 `agents` 内 ACP 类型则无法直接下沉。缓解：先核对其依赖闭包；必要时连同最小依赖一起下沉或用 newtype 适配。
- **migration（B1/B10）**：落地前按 Boundaries"Ask first"先报方案。

---

## 10. Open Questions（实施中确认）

1. **B1 投影快照表**：A-3 仅要求"同事务 + rebuild"；是否一并落地 §代码报告 5.1 的**投影快照表**（持久化 `last_sequence`+折叠结果）以根治读放大？→ 倾向"一并做"，但属 migration，落地前确认。
2. **A-6 `run_reason` 重命名**：重命名 enum 值会触及历史数据与序列化；倾向"保留值 + 文档/常量澄清"而非破坏式重命名，落地前确认。
3. **B9 范围**：`ConversationEvent` 下沉的依赖闭包大小决定是否本轮全量下沉，B8 完成后据实评估。

---

## 12. 进度日志

> 每批次均过门槛：`pnpm run check` + `pnpm run lint`（clippy `--features qa-mode -D warnings`）+ 相关 `cargo test`。未提交（交回用户）。

- **B1 ✅ A-3**：`ConversationEventAppender::append` 单 `BEGIN IMMEDIATE` 事务包住 insert+apply+快照刷新；11 个投影写方法 + `events_since` 泛型化 `E: Executor`；新增 `rebuild_projection` + `conversation_projection_snapshots`（migration 20260618000000），读路径"快照+尾部增量"根治读放大；时间线 `QuestionRequest`/`FeedbackRequest` 加可选 `response`，折叠 `QuestionResponded`/`FeedbackSubmitted`。db 34/34 测试通过（含 4 新测试）。
- **B2 ✅ A-5**：5 处重复 `agent_type_from_executor` 收敛至 `src-tauri/src/bridge.rs`，统一错误文案，清理失效导入。
- **B3 ✅ A-1**：`mcp_market.rs`（2550 行）整体下移 `crates/services/src/services/mcp/`；`McpError` + `From`；config.rs 薄命令 + 类型 re-export；services 加 reqwest/toml/serde_yaml；6 测试通过。
- **B4 ✅ A-1+fail-loud**：`model_provider.rs`（1332 行）下移 `services/provider_config/`；命令缩为 8 个薄包装；4 处根治：备份失败拒写（1.3/H-3）、render_codex expect→ok_or_else（4.2a）、5xx→Internal（4.2b）、v6 静默改写→响亮 warn（1.2）。
- **B5 ⏳ 已测绘未实施**：3 文件部分抽取。prompt_enhancement（最净，services 需加 `which`）、local_usage（缓存/DB 耦合，扫描纯）、chat_channel（入站 WebSocket/runtime 交织，抽纯发送器到 notification.rs）。
- **B6–B11 ⏳ 待实施**：拆 ContainerService（A-10）→ DI dyn-safe（A-2，~228 调用点，高风险，依赖 B6）→ conversation crate + 锁封装（A-4+A-7，高风险）→ api-types 下沉（A-9）→ 过渡债（A-6）→ 委派补完（A-8）。

**当前状态**：worktree 在 B4 边界干净全绿，无半成品。

## 11. 验证清单（每批次收尾）

- [ ] `pnpm run check` 全绿
- [ ] `pnpm run lint`（--features qa-mode）零告警
- [ ] 相关 `cargo test -p <crate>` / `cargo test --workspace` 全绿
- [ ] 新逻辑带单测（渲染器/事务/折叠/桥接）
- [ ] 触及 TS 导出 → `generate-types:check` 过；触及 sqlx/migration → `prepare-db:check` 过
- [ ] 不引入掩盖型 fallback；破坏性操作前置校验 fail-loud
- [ ] 不擅自 git commit
```
