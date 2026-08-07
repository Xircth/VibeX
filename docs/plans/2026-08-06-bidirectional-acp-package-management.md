# ACP 组件双向管理落地计划

**状态：** 规划完成，尚未实施。

**日期：** 2026-08-06。

**决策依据：**
[ADR-0038：ACP 组件双向管理](../adr/0038-bidirectional-acp-package-management.md)。

**目标：** 让 VibeX 既能在平台内托管更新内置 Agent 的 ACP 组件（方向 A），也能在
外部组件被 npm 等包管理工具更新后自动识别版本、以官方指纹验证并自动更新
Installation lock 指纹放行（方向 B），同时保持既有安全边界：TOFU 组件永不自动
采纳、VibeX 永不修改外部文件、主动升级永远需要用户确认。

**交付原则：** 纵向 TDD；每个提交只有一个可观察行为变化；每个提交结束时
`cargo test --workspace` 与前端检查可编译、已有测试通过。方向 A 与方向 B 可以
分批独立落地，但每个提交不得破坏既有 LaunchGate 的 fail-closed 语义。

## 1. Problem statement

2026-08-05 一次 npm 全局更新（`@agentclientprotocol/codex-acp` 1.1.4 → 1.1.9）
导致 Codex 启动被 LaunchGate 拦截（expected 7534a0ad…，found c4fdf929…）。
调查确认（全部为代码事实）：

- 托管更新链路完备（`agent_management_apply_update` → Update 操作 → 新 lock +
  回滚），但内置 Agent 的更新目标被 `profiles.rs` 编译期锁死，`check_update`
  看到的 Registry 新版本不会被 `apply_update` 采用；
- `apply_custom_version_override` 明确跳过 `acp_adapter`；
- Registry 的 npx/uvx 分发没有官方完整性字段，只有 binary 有 `sha256`；
- 外部组件内容变化只会在启动 warm/手动刷新/preflight 时被识别为
  `needs_repair`，已安装 external 在启动探测中被跳过，指纹仅由
  `persist_installed_lock` 在 install/repair/update 时重写。

## 2. Scope

### In scope

- 内置 Agent 更新计划消费 fresh Registry snapshot 的组件版本（含
  `acp_adapter`），组件版本组合一致性校验；Profile 锁版本保留为初始与回退目标；
- `apply_custom_version_override` 覆盖 `acp_adapter`；
- Registry 分发增加官方完整性字段（npx/uvx 的包生态 `dist.integrity` 等），
  二进制分发沿用 `sha256`；
- 外部组件后台重探（定时 + 事件）与版本/哈希变化识别；
- 官方指纹验证通过后的自动采纳（更新 lock 指纹并放行）与审计/回滚记录；
- TOFU 组件保持 fail-closed：`needs_repair` + 诊断 + 用户确认采纳；
- 托管安装落位作用域内私有目录（ADR-0011 的"未来实现"），可作为独立批次；
- 相关 CONTEXT、ADR traceability、generated types 与 SQLx metadata 更新。

### Out of scope

- 改变 LaunchGate 的启动校验语义（当前 lock 与磁盘不一致仍禁止启动）；
- 修改、删除或升级外部安装的文件；
- 内置 Profile 完全动态解析 `latest`（ADR-0027 确定性保留）；
- 自动升级普通 Registry Agent（仍须用户确认，ADR-0016）；
- 增加新的 Agent 来源或自定义 Registry。

## 3. 分阶段任务

每个任务遵循一个行为测试的 Red → 最小 Green。测试 seam 与 ADR-0034 一致：
domain planner/reducer、SQLite repository、application service、ACP fixture
process、Tauri IPC 与 React。

### Phase 0 — 现状固定

- [x] 为「内置 Agent 更新目标 = Profile 锁版本」与「`acp_adapter` 被
      `install_version` 排除」各补一个表征测试。
  - RED：无测试覆盖当前行为。
  - GREEN：仅增加测试，不改变产品行为。
  - Verify：`cargo test -p vibex install_version_override` /
      `cargo test -p vibex builtin_update_target`.

### Phase 1 — Registry 官方完整性字段（方向 A 与 B 的共同地基）

- [x] `RegistryPackageDistribution` 增加官方完整性字段（如
      `npm_dist_integrity` / `package_integrity`），Registry snapshot 持久化并
      在 generated types 中导出。
  - RED：Registry fixture 含官方完整性时被丢弃。
  - GREEN：字段进入 snapshot 模型与 DB 投影。
  - Verify：`cargo test -p agents registry_distribution_integrity`；
      `pnpm run generate-types:check`；`pnpm run prepare-db:check`.

### Phase 2 — 方向 A：内置 Agent 更新消费 Registry

- [x] `resolve_install_plan` 的 BuiltInProfile 分支：存在 fresh snapshot 且
      Agent 有 Registry binding 时解析组件版本；离线/过期回退 Profile 锁版本。
  - RED：fresh snapshot 有新版本时 apply_update 仍装锁版本。
  - GREEN：更新计划来自 snapshot；无 snapshot 时行为不变。
  - Verify：`cargo test -p vibex builtin_update_uses_registry`.
- [x] 组件版本组合一致性：agent_runtime 与 acp_adapter 目标必须来自同一
      snapshot，禁止混搭。
  - RED：构造 snapshot 内 runtime 与 adapter 版本不匹配时计划被接受。
  - GREEN：planning 拒绝不一致组合。
  - Verify：`cargo test -p vibex builtin_update_component_pairing`.
- [x] `apply_custom_version_override` 纳入 `acp_adapter`（npx/binary 规则与
      runtime 一致），并保留组件组合一致性校验。
  - RED：指定 acp_adapter 版本返回"没有可替换的 Runtime 组件"。
  - GREEN：acp_adapter 被替换且组合仍一致。
  - Verify：`cargo test -p vibex install_version_override_acp_adapter`.

### Phase 3 — 方向 B：外部组件后台重探与自动采纳

- [x] 已安装 external 组件事件只读重探（`--version` + 内容哈希）——已完成事件
     驱动路径（warm / 手动刷新 / preflight）；周期性定时调度尚未实现。
      遵守超时与资源释放。
  - RED：安装后 external 文件被替换，warm 重探不报告变化。
  - GREEN：重探识别版本与哈希变化并写入待处理证据。
  - Verify：`cargo test -p agents external_reprobe_detects_change`.
- [x] 官方指纹验证：变化时按分发类型拉取官方指纹（npx → npm
      `dist.integrity`，binary → Registry `sha256`），与磁盘内容比对。
  - RED：磁盘内容与官方指纹一致仍被标记 needs_repair。
  - GREEN：验证通过进入自动采纳候选；不符保持拦截。
  - Verify：`cargo test -p agents external_change_official_fingerprint`.
- [x] 自动采纳：官方指纹验证通过 → 生成新 lock（旧 lock 转 rollback）并更新
      `agent_install_component.sha256`，记录采纳来源/时间/旧指纹；LaunchGate
      随后放行。
  - RED：验证通过后 lock 仍指向旧指纹，下次启动被拦截。
  - GREEN：lock 追平磁盘官方内容，启动通过；审计记录完整。
  - Verify：`cargo test -p agents external_auto_adopt_lock` +
      `cargo test -p agents launch_gate_integrity`.
- [x] TOFU 组件（无官方指纹）保持 fail-closed：变化 → `needs_repair` + 诊断
      已完成（后端）；前端"确认采纳"入口尚未实现。
  - RED：TOFU 变化被自动采纳。
  - GREEN：仅用户确认后采纳；诊断与 UI 文案齐备。
  - Verify：`cargo test -p agents tofu_change_requires_confirmation` +
      `AgentSettings` Vitest.

### Phase 4 — 托管落位作用域内目录（独立批次）

- [ ] 内置 Agent 组件安装到版本锁定私有目录，shim 所有权标记与原子切换保留；
      现有全局 npm 场景不受影响。
  - RED：托管安装仍写入全局 npm 目录。
  - GREEN：安装落位私有目录且 shim 指向正确；更新/回滚原子切换。
  - Verify：`cargo test -p vibex managed_install_scoped_dir`.

### Phase 5 — 收尾与发布门禁

- [ ] 更新 CONTEXT.md 术语（如"双向管理"、"自动采纳"）与 ADR traceability。
- [ ] 删除为表征测试保留的临时特判与死代码；确认无并行旧路径残留。
- [ ] 更新 generated types、SQLx metadata 与 release evidence。

最终验证：

```text
cargo fmt --all --check
pnpm run generate-types && pnpm run generate-types:check
pnpm run prepare-db && pnpm run prepare-db:check
cargo test -p api-types
cargo test -p db
cargo test -p agents
cargo test -p vibex
pnpm --dir frontend exec vitest run
pnpm run check
pnpm run lint
cargo test --workspace
```

真实 Agent smoke gate 至少覆盖：

- Codex：外部 npm 全局升级 1.1.x → 1.1.y 后自动采纳并可启动；TOFU 场景保持
  needs-repair；
- 内置 Agent：fresh Registry 下 apply_update 安装 snapshot 版本；离线回退锁版本；
- 供应链污染模拟：磁盘内容与官方指纹不符 → 拦截 + 诊断，不自动放行；
- 重探在应用退出/超时后无残留连接、子进程与临时目录。

## 4. Traceability

| ADR-0038 决策 | 落地阶段 |
| ------------- | -------- |
| 内置 Agent 更新消费 Registry 最新版本（同 snapshot 组合） | Phase 2 |
| `acp_adapter` 纳入指定版本覆盖 | Phase 2 |
| Registry 分发官方完整性字段 | Phase 1 |
| 托管安装落位作用域内目录 | Phase 4 |
| 外部组件后台重探 | Phase 3 |
| 官方指纹验证通过自动采纳 | Phase 3 |
| TOFU 保持 fail-closed | Phase 3 |
| 采纳审计与回滚 | Phase 3 |
