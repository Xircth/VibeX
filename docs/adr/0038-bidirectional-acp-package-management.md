---
status: accepted
date: 2026-08-06
decision-makers:
  - VibeX maintainers
---

# ACP 组件双向管理：平台托管更新与外部变更自动采纳

## Context

2026-08-05 用户机器上出现一次 Launch Gate 拦截：Codex 的 `acp_adapter` 组件
（`@agentclientprotocol/codex-acp`）从 1.1.4 被 npm 全局更新到 1.1.9，文件内容
变化导致 SHA-256 校验失败（expected 7534a0ad…，found c4fdf929…），Codex 会话
无法启动，安装进入 `needs_repair`。该行为是 TOFU fail-closed 的设计意图（见
ADR-0017 与 ADR-0034），但暴露了双向管理缺口：

1. **托管方向**：VibeX 已有完整更新链路（`agent_management_apply_update` →
   `AgentOperationKind::Update` → 新 Installation lock，旧 lock 转
   `rollback_lock_id`），但内置 Agent 的更新目标是 Built-in Profile 编译期锁定的
   版本（`profiles.rs` 中 `codex-acp@1.1.9`）——`check_update` 能看到 Registry
   新版本，`apply_update` 却仍安装锁版本；`agent_management_install_version` 的
   版本覆盖又明确排除了 `acp_adapter`（`apply_custom_version_override` 只处理
   `agent_runtime`/`combined_runtime`）。平台无法把内置 Agent 的 ACP 包升到比
   Profile 锁版本更新的版本。
2. **外部方向**：`refresh_component_integrity` 只在启动 warm、用户手动刷新与
   preflight 时运行，检测到哈希不匹配仅置 `needs_repair`；已安装的外部组件在
   启动探测中被跳过，指纹只在 install/repair/update 时经 `persist_installed_lock`
   重写。外部包被 npm 自动更新后，平台不会自动识别新版本，也不会拉取官方指纹
   追平锁记录，只会等到下次启动被 Launch Gate 拦下。

本 ADR 决定引入双向管理：平台可以托管更新内置 Agent 的 ACP 组件；外部组件内容
被其所有者更新后，平台自动识别版本、以官方指纹验证，并在验证通过时自动更新
Installation lock 指纹放行。它细化 ADR-0011、ADR-0017 与 ADR-0034，并对
ADR-0016 的落地语义做一处受控修订，不改变既有 ADR 的产品方向。

## Assumptions and boundaries

1. VibeX 仍不修改、删除或升级外部安装的文件（ADR-0011 不变）；外部组件内容变化
   由外部所有者（用户、npm、系统包管理器）负责。
2. Agent 来源仍只有 Built-in Agent Profile 与 ACP 官方 Registry（ADR-0034 不变）。
3. 主动升级永远需要用户确认（ADR-0016 不变）；本 ADR 引入的自动采纳只响应
   **已经发生**的、可被官方指纹验证的外部内容变更，不是主动升级。
4. 内置 Agent 只安装已验证版本组合的确定性（ADR-0027）保留：Profile 锁版本仍是
   初始安装与离线/无 Registry 时的回退目标。
5. 能力与不变量优先于保留当前代码；若现有模块边界妨碍正确实现，应替换或删除。

## 现状盘点（决策依据）

| 能力 | 现状 | 关键位置 |
| ---- | ---- | -------- |
| 托管更新链路 | 完整：apply update → Update 操作 → 预检 + ACP 握手 → 新 lock + 回滚 | `agent_management_apply_update`（agent_management.rs:3536）、`run_install_operation`（:3869）、`persist_installed_lock`（:5739） |
| 内置 Agent 更新目标 | Profile 编译期锁版本；与 check_update 读到的 Registry 新版本无关 | `resolve_install_plan` BuiltInProfile 分支（:4328-4329, :4358） |
| 指定版本覆盖 | 仅 `agent_runtime`/`combined_runtime`；`acp_adapter` 被跳过 | `apply_custom_version_override`（:3802-3848） |
| Registry 指纹 | binary 分发有 `sha256`；npx/uvx 分发无 integrity 字段，靠下载时生态校验 | `RegistryBinaryTarget.sha256`、`RegistryPackageDistribution`（registry_client.rs:24-42）；`ArtifactTrust::EcosystemIntegrityRequired`（install_planner.rs:385） |
| 外部变更识别 | 启动 warm / 手动刷新 / preflight 时哈希比对，不匹配置 `needs_repair`；已安装 external 跳过自动重探 | `refresh_component_integrity`（services/agent_management.rs:256）、`should_probe_built_in`（agent_management.rs:1918-1924） |
| 指纹写入 | 仅 install/repair/update 成功路径经 `persist_installed_lock` 重写，无静默更新 | agent_management.rs:5793-5811 |
| 启动校验 | LaunchGate 对当前 lock 每个组件重算 SHA-256，不匹配禁止启动 | `launch_gate.rs`；agents.rs:1243 |

## 决策

### 方向 A：平台托管更新

1. **内置 Agent 的组件更新目标可消费 Registry 最新版本。** `resolve_install_plan`
   的 BuiltInProfile 分支在存在 fresh（24h 内）Registry snapshot、且该 Agent 有
   Registry binding 时，从 snapshot 解析组件目标版本；Profile 锁版本退化为初始
   安装与离线回退目标。agent_runtime 与 acp_adapter 的目标必须来自同一 snapshot，
   禁止混搭（防止未验证的组合）。无 snapshot 或离线时保持现状（锁版本）。
2. **`acp_adapter` 纳入指定版本覆盖。** `apply_custom_version_override` 对
   `acp_adapter` 采用与 `agent_runtime` 相同的规则（npx 替换 package@version 并
   声明生态完整性；binary 替换 URL 并声明 TOFU）。组件级版本组合仍由
   `resolve_install_plan` 的同一 snapshot 规则约束。
3. **Registry 分发补充官方完整性字段。** npx/uvx 分发记录对应包生态的官方校验和
   （npm `dist.integrity` sha512 等），使托管安装获得可持久化的官方指纹，供后续
   校验与方向 B 的自动采纳使用；binary 分发继续使用现有 `sha256`。
4. **托管安装落位到作用域内目录。** 内置 Agent 的 ACP 适配器与 Runtime 安装到
   版本锁定的 Agent 私有目录（落实 ADR-0011 的"未来实现"），用户级稳定 shim
   继续带所有权标记并原子切换；不再依赖全局 npm 包目录，避免与外部包管理互相
   干扰。
5. **更新仍须用户确认。** check 只返回比较结果，apply 才生成 update plan；
   失败/取消/中断不改变当前 lock，回滚机制不变（ADR-0016、ADR-0034 保留）。

### 方向 B：外部组件变更的自动识别与采纳

1. **新增后台重探。** 对已安装的外部组件周期性（定时）与事件触发的只读重探：
   探测 `--version` 与内容哈希，遵守 ADR-0034 的无副作用、有界、超时与资源释放
   原则；不下载、不修改、不删除外部文件。启动 warm 对已安装 external 的跳过
   逻辑（`should_probe_built_in`）改为"跳过仅当上次重探新鲜"，不再永久跳过。
2. **官方指纹验证。** 版本/哈希变化时，从官方来源拉取该版本指纹：
   - npx/uvx 分发 → npm 等包生态的 `dist.integrity`（sha512）；
   - binary 分发 → ACP Registry 对应版本的 `sha256`。
3. **验证通过 → 自动采纳并放行。** 官方指纹与磁盘内容一致时，自动更新
   Installation lock 的组件指纹（`persist_installed_lock` 语义，生成新 lock，
   旧 lock 转 rollback）并放行；无需用户干预。这是 ADR-0016"发现版本变化后只
   重新校验，不主动修改"的落地修订：VibeX 仍不修改外部文件，只更新自己的锁
   记录，信任依据从 TOFU 首次指纹升级为官方 Verified 指纹（ADR-0017 两级信任
   中的第一级）。
4. **无官方指纹 → 保持 fail-closed。** TOFU 组件（官方来源未提供校验和）内容
   变化时维持现状：`needs_repair` + 诊断 + 提示用户确认采纳，绝不自动放行。
5. **采纳可审计、可回滚。** lock 记录采纳来源（registry/npm）、采纳时间与旧
   指纹；复用既有 rollback 机制，用户可回退到采纳前的锁。
6. **LaunchGate 语义不变。** 启动仍校验当前 lock 与磁盘一致；自动采纳只是让
   lock 追平磁盘上可验证的官方变更。官方指纹与磁盘不符（供应链污染场景）时
   拦截并置 `needs_repair`，与现在一致。

### 安全不变式

- VibeX 永不修改外部安装的文件。
- 自动采纳仅限官方指纹可验证的组件；TOFU 永不自动采纳。
- 自动采纳不是主动升级：VibeX 不因"有新版"而改动外部文件，只响应已发生的、
  可验证的内容变更。
- 主动升级永远需要用户确认。
- 官方指纹与磁盘不符时始终拦截。

## Considered options

- **维持现状 fail-closed，只靠手动 repair。** 否决：每次 npm 升级后用户都要手动
  修复，与"双向管理"目标不符；本 ADR 正是该事故的直接后续。
- **任何内容变化都自动采纳。** 否决：把信任完全委托给磁盘当前状态，供应链污染
  会被自动放行，破坏 ADR-0017 的安全边界。
- **官方指纹验证通过仍需用户确认。** 部分采纳：作为 TOFU 组件的策略保留；对
  官方指纹组件，用户已明确选择自动放行（本 ADR 决策点）。
- **内置 Profile 完全动态解析 `latest`。** 否决：破坏 ADR-0027 的确定性；锁版本
  保留为初始与回退目标，只允许 fresh snapshot 明确覆盖。
- **只做识别不做采纳（展示"有更新，可一键修复"）。** 否决：识别后仍被 Launch
  Gate 拦截，用户路径与手动 repair 重叠；本 ADR 以官方指纹为边界自动采纳。

## Consequences

- Registry 分发需增加官方完整性字段：涉及 `registry_client.rs`、Registry
  snapshot 的 DB 与 generated types，需重跑 `prepare-db` 与 `generate-types`。
- 内置 Agent 更新计划消费 Registry：`resolve_install_plan` BuiltInProfile 分支、
  `apply_custom_version_override` 扩展，并新增组件版本组合一致性校验。
- 新增后台重探与自动采纳流程：新 service 方法、重探调度（定时/事件）、采纳
  审计记录；`should_probe_built_in` 对已安装 external 的跳过语义调整。
- 托管安装落位到作用域内目录是独立推进项，可与本 ADR 的其余部分分批落地；
  落位前，方向 B 已能覆盖用户当前的 npm 全局场景。
- 安全边界明确：自动采纳仅限官方指纹，TOFU 保持人工确认；文档、诊断文案与
  UI（needs-repair 提示）相应更新。
- 需要为每个变更点补充保留的行为回归测试（见计划文档），并纳入 CI：
  `prepare-db:check`、`generate-types:check`、`cargo test`、前端 Vitest。
