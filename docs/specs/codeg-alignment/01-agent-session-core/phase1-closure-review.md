# Phase 1 T1.10 收口审查

日期：2026-06-13

比较范围：`5a66e59...HEAD`（Phase 1 T1.1 起至 T1.9）。

## 五轴审查结论

### Correctness

- 已修复：全量 `cargo test --workspace` 首次失败，根因是 `crates/local-deployment/src/container.rs` 的测试专用 `sessions` schema 未同步 Phase 1 新增的 `external_session_id`、`agent_type` nullable 列，导致 `Session::find_by_id` 在 local-deployment 测试库中读取失败。已补测试 schema，`cargo test -p local-deployment --lib` 与全量 workspace 测试均恢复通过。
- 已验证：A1-A14 对应的 session/load、事件面、权限、多选项、auto-approve、preflight、握手超时、env 合并、spawn 去重均有单元或集成覆盖；T1.9 七类 Agent fixture gate 通过。

### Readability

- 事件、权限、preflight、runtime 输入结构均保持显式类型；新增 fixture gate 只挂在 in-memory driver 的专用 prompt 上，不影响真实 ACP runner 路径。
- 无必须修复的命名或控制流问题。

### Architecture

- 核心行为留在 `crates/agents` runtime/manager/permissions/preflight，Tauri 命令层只做解析和调用；符合“业务逻辑在拥有边界内”的项目标准。
- DB 迁移与模型变更在 `crates/db` 内完成，前端 store 只消费事件和 snapshot，不以 UI guard 掩盖 runtime 状态。

### Security

- `env_json` 只接受 JSON object 中的 string/number/bool/null 标量；数组/对象值被拒绝，避免把结构化不可信输入直接传给进程环境。
- 权限自动批准仍通过 `AgentAutoApproveMode` 决策器，reject-only 请求不会被自动允许。

### Performance

- spawn 去重用 `(agent_type, working_dir, session_id)` 锁避免并发首发 prompt 建重复连接。
- preflight 与 fixture gate 均为表驱动/测试路径；未向真实 prompt 热路径加入轮询或重 tokenizer 类成本。

## 残余风险

- T1.9 的可重复通过证据是 fixture integration gate。ClaudeCode 与 Codex 在本机探测到命令和认证痕迹，但真实 LLM/tool 全链路未自动执行，因为会消耗外部服务且工具/权限行为不稳定。当前记录见 `agent-gate-results.md`；若产品负责人要求 live smoke，后续应把对应行升级为 `Live gate passed`。
- 浏览器/Tauri shell 手动 UI 冒烟仍不属于 Phase 1 自动门；Phase 2/7 的可视 UI 验证会继续补。

## 验证

- `pnpm run check`：通过。
- `pnpm run lint`：通过。
- `cargo test -p local-deployment --lib`：通过。
- `cargo test --workspace`：通过。
- `cd frontend && pnpm vitest run`：126 files / 689 tests 通过。
- `pnpm run prepare-db:check`：通过。
- `pnpm run generate-types:check`：通过。
- `pnpm run backend:check`：通过。
- `pnpm run backend:lint`：通过。
