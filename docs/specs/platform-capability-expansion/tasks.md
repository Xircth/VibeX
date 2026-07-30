# Tasks：TDD 纵向实施计划

> 状态：待评审。只有 T0.1 的测试缝与需求验收获确认后才能开始功能实现。
>
> 每项任务是一轮或少量连续的 RED → GREEN → REVIEW，不允许把一个里程碑全部测试
> 预先写完。`Files` 是责任范围提示；实现时每个提交尽量控制在约 5 个文件内。

## 0. 依赖与并行规则

```text
M0 契约与归属
 ├─ M1 Plugin/Tool/Artifact/Office ─────────────┐
 ├─ M2 Delegation/&Mention ────────────────────┤
 └─ M3 TurnLaunchSpec/Automation backend ──────┤
                                               ▼
                                  M4 Application/Transport
                                               ▼
                                         M5 Web Server
                                               ▼
                                   M6 移动端协议准备
                                               ▼
                                         M7 收口验收
```

- M1、M2 和 M3 在 M0 后可由不同工作树并行，但共享 PromptBlock/Agent capability 的
  schema 改动必须串行合并。
- M3 的 Automation UI 等待 M1 PluginAction 和 M4 BackendTransport 的前端接口稳定。
- M5 不得在 M4 前批量复制 HTTP handlers。
- 每个里程碑必须达到 gate 后再依赖它；局部测试全绿不等于 gate 通过。

## M0 — 规格、测试缝与第三方归属

### T0.1 确认规格与公共测试缝

- **Depends**：无。
- **RED**：用评审清单逐项检查 `requirements.md` 中 PLG/ART/DEL/AUT/WEB/MOB 是否都在
  `design.md` 有公共 seam 和可观察结果；缺项即评审失败。
- **GREEN**：由维护者确认或修订假设、非目标、TDD seam 和成功标准；把状态改为
  `approved-for-implementation`。
- **Acceptance**：实现者不需要猜测“Mention 是否直接派发”“错过 tick 是否补跑”
  “OfficeCLI 何时自动安装”等关键语义。
- **Verify**：
  `rg -n "PLG-|ART-|DEL-|AUT-|WEB-|MOB-" docs/specs/platform-capability-expansion`
- **Files**：本目录三份规格、必要时 `CONTEXT.md`。

### T0.2 建立 Codeg 复用与 Apache-2.0 归属清单

- **Depends**：T0.1。
- **RED**：新增文档测试/CI 检查 fixture，输入一个标为 `adapted-from-codeg` 但缺
  commit/source/license 的条目应失败。
- **GREEN**：建立 `docs/third-party/codeg-adoption.md` 与最小校验脚本/测试；登记已有
  Office watch 移植来源。
- **Acceptance**：任何直接 copy/adapt 都能追溯到固定 commit 和源文件；发布归属要求
  明确。
- **Verify**：`node --test scripts/check-third-party-adoption.test.js`
- **Files**：`docs/third-party/codeg-adoption.md`、`scripts/check-third-party-adoption.*`、
  根许可证/NOTICE 文件（如法律审查要求）。

### T0.3 固定跨域稳定标识与错误信封

- **Depends**：T0.1。
- **RED**：`remote-protocol` 测试对给定 command error fixture 断言稳定
  `code/message/retryable/operation_id/details`；crate 尚不存在或类型缺失而失败。
- **GREEN**：创建最小 `remote-protocol` crate，定义版本、id newtypes、error envelope
  与 serde fixtures，不加入 HTTP。
- **Acceptance**：Plugin、Tool、Artifact、Delegation、Automation 与远程层能共享稳定
  operation/error 表达，且错误详情不包含 secret。
- **Verify**：`cargo test -p remote-protocol`
- **Files**：workspace `Cargo.toml`、`crates/remote-protocol/Cargo.toml`、
  `crates/remote-protocol/src/{lib,error}.rs`、fixture。

**M0 Gate**

```bash
cargo test -p remote-protocol
node --test scripts/check-third-party-adoption.test.js
```

评审者确认 [design.md](design.md#8-tdd-测试缝实施前评审门) 后才进入 M1–M3。

## M1 — Plugin v2、Tool Runtime、Artifact 与 Office

### T1.1 Plugin v2 manifest：最小可解析动作

- **Depends**：M0。
- **RED**：通过 `PluginService.import_manifest` 输入一个内置“创建 PPT”fixture，断言
  得到稳定 plugin id、一个 tool dependency、一个 skill 和结构化 action；当前服务
  不支持 v2 而失败。
- **GREEN**：建立 `plugins` crate、v2 schema/领域类型与 import service，仅支持该
  fixture 所需字段；未知 major fail closed。
- **Acceptance**：PLG-001/002 的第一个 tracer bullet 成立；不执行任何安装。
- **Verify**：`cargo test -p plugins import_office_action_manifest`
- **Files**：`crates/plugins/{Cargo.toml,src/lib.rs,src/manifest.rs}`、fixture、workspace。

### T1.2 Platform distribution 的确定性解析

- **Depends**：T1.1。
- **RED**：给定多平台 OfficeCLI distributions，断言 macOS arm64 只解析到精确版本和
  哈希；缺平台返回 `tool_platform_unsupported`。
- **GREEN**：添加 `ToolDependencyResolver` 与平台 triple 归一化，不下载文件。
- **Acceptance**：相同输入和平台总是得到相同锁定候选，不解析 `latest`。
- **Verify**：`cargo test -p plugins resolves_exact_tool_distribution`
- **Files**：`crates/plugins/src/{manifest,resolver,error}.rs`、tests。

### T1.3 Tool Runtime：校验后首次安装

- **Depends**：T1.2。
- **RED**：通过 `ToolRuntime.ensure` + fake downloader/fs/process，断言字节哈希不匹配
  时 binary 从未 probe/execute，current lock 不存在。
- **GREEN**：建立 `tool-runtime` crate，完成 staging download、SHA-256、绝对路径 probe
  和 lock persistence port 的最小流程。
- **Acceptance**：PLG-004 与 NFR-001；不调用 shell，不改 PATH/global package。
- **Verify**：`cargo test -p tool-runtime rejects_digest_mismatch_before_probe`
- **Files**：`crates/tool-runtime/{Cargo.toml,src/lib.rs,src/ports.rs,src/install.rs}`、
  workspace。

### T1.4 Tool upgrade、取消与原子切换

- **Depends**：T1.3。
- **RED**：当前 v1 可用时升级 v2，分别模拟取消、probe 失败和成功；前两者仍解析 v1，
  成功才切 v2。
- **GREEN**：增加 installation attempt、取消 token、atomic current pointer 和旧版本
  保留逻辑。
- **Acceptance**：PLG-005；中断不破坏当前工具。
- **Verify**：`cargo test -p tool-runtime upgrade_is_atomic`
- **Files**：`crates/tool-runtime/src/{install,lock_store,types}.rs`、tests。

### T1.5 Plugin readiness 与启用时自动安装

- **Depends**：T1.1、T1.4。
- **RED**：调用 `PluginService.enable(office)`，fake tool missing 时应产生 Installing
  operation；成功后 readiness 为 ready，失败时 plugin 仍 enabled 但明确 dependency
  failed。
- **GREEN**：连接 PluginService 与 ToolRuntime port，分离 membership/activation/
  dependency/skill/provider 状态。
- **Acceptance**：PLG-003/006；启用是安装授权，但状态不被压成一个字符串。
- **Verify**：`cargo test -p plugins enabling_builtin_resolves_dependencies`
- **Files**：`crates/plugins/src/{service,readiness,ports}.rs`、tests。

### T1.6 旧插件 v1 安全迁移

- **Depends**：T1.1。
- **RED**：迁移含 `install_command` 的现有 fixture，断言 fake process 未被调用，结果为
  `migration_required` 并保存原 manifest evidence。
- **GREEN**：增加数据库迁移/adapter；只自动映射已知内置 stable ids。
- **Acceptance**：PLG-007；升级应用不会执行旧任意命令。
- **Verify**：`cargo test -p db plugin_v1_migration_never_executes_command`
- **Files**：DB migration、`crates/db/src/models/plugin*.rs`、migration integration test、
  plugin DB adapter。

### T1.7 PluginAction 进入 Composer canonical input

- **Depends**：T1.5。
- **RED**：前端用户点击“创建 PPT”，mock Transport 返回 action；断言编辑器出现可编辑
  prompt/skill/tool chips，发送 payload 是结构化 blocks 而非拼接 hook string。
- **GREEN**：新增 PluginAction API facade、action-to-composer adapter 和最小 UI；不
  自动发送。
- **Acceptance**：PLG-008；同一个 action ref 可被 Automation editor 序列化。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/features/plugins/PluginAction.test.tsx`
- **Files**：`frontend/src/features/plugins/*`、Composer integration、API facade、locale。

### T1.8 Artifact Service：记录文件修订

- **Depends**：T1.5、Conversation event API 可用。
- **RED**：对同一路径依次记录 hash A、A、B，断言只产生 revision 1/2 两次事件，并
  保留 producer plugin/tool evidence。
- **GREEN**：建立 `artifacts` crate、repository/event ports 和 record service；文件
  字节不进入事件。
- **Acceptance**：ART-001/002/003。
- **Verify**：`cargo test -p artifacts records_only_content_changes`
- **Files**：`crates/artifacts/{Cargo.toml,src/lib.rs,src/service.rs,src/ports.rs}`、workspace。

### T1.9 OfficeCLI Provider 使用已解析工具与 preview lease

- **Depends**：T1.4、T1.8。
- **RED**：通过 `ArtifactService.open_preview` 使用 fake OfficeCLI，连续打开同一文件
  只 spawn 一次，关闭最后 lease 后进入可回收；未解析工具时不查 PATH。
- **GREEN**：把现有 `office_watch` 行为迁到 Office provider adapter，工具路径来自
  ToolInstallationLock，保留进程上限/ready/回收。
- **Acceptance**：ART-004；现有 OfficePreview 的公开行为保持。
- **Verify**：`cargo test -p artifacts office_preview_reuses_watch_process`
- **Files**：Office provider、watch adapter、Artifact registry、迁移后的命令 adapter、
  tests。

### T1.10 内置 Office 插件完整旅程

- **Depends**：T1.7、T1.9。
- **RED**：桌面集成测试从禁用/未安装状态点击“分析 Excel”，断言安装 operation、
  安装完成后 action 仍在 Composer，fake Agent 生成 XLSX 后出现 Artifact preview。
- **GREEN**：打包 Office manifests/skills/actions，连接安装进度、发送和 Artifact
  discovery；至少落实 PPTX/DOCX/XLSX 三类动作。
- **Acceptance**：ART-005/006/007 的桌面部分。
- **Verify**：目标 Rust integration + 前端 Vitest；随后
  `pnpm run tauri:dev:desktop` 按验收脚本手验。
- **Files**：bundled manifests/skills、Office action UI、install progress adapter、
  Artifact event adapter、acceptance doc。

### T1.11 插件设置页 v2

- **Depends**：T1.5、T1.10。
- **RED**：用户打开插件详情能分别看到 dependency/skill/provider 状态；哈希失败时
  显示具体诊断和重试，不能显示“已安装”。
- **GREEN**：设置页改用 PluginReadiness projection，删除对单一
  `install_status/install_command` 的编辑依赖。
- **Acceptance**：内置/第三方同页面骨架；旧插件迁移提示可操作。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/pages/settings/PluginsSettings.test.tsx`
- **Files**：Plugins settings、readiness components、API facade、locales、tests。

**M1 Gate**

```bash
cargo test -p plugins
cargo test -p tool-runtime
cargo test -p artifacts
cd frontend && pnpm exec vitest run src/features/plugins src/pages/settings/PluginsSettings.test.tsx
pnpm run generate-types:check
pnpm run prepare-db:check
```

验收：从全新数据目录完成一个 Office action；网络/哈希/probe 任一失败都不会执行未验证
binary，也不会丢失 Composer 输入。

## M2 — Codeg parity Delegation 与 `&Agent`

### T2.1 能力驱动的 companion 注入

- **Depends**：M0。
- **RED**：对 fake Agent capabilities 构造支持/不支持 `session/new.mcp_servers` 两例，
  断言前者收到 vibex-mcp，后者返回 `delegation_parent_unsupported`；测试不检查
  AgentKind。
- **GREEN**：把现有 Claude-only injection 改为 capability policy，继续使用 per-session
  token。
- **Acceptance**：DEL-001/002；OpenClaw 等拒绝 MCP list 时如实降级。
- **Verify**：`cargo test -p agents companion_injection_follows_capability`
- **Files**：Agent capability 类型、delegation injection、manager adapter、tests。

### T2.2 `&Agent` Mention 的编辑器往返

- **Depends**：稳定 AgentKind catalog。
- **RED**：用户在 token 边界键入 `&Co`、选择 Codex、复制/粘贴并发送，断言得到稳定
  AgentMention；`A&B`、代码块、URL 均保持文本。
- **GREEN**：实现 Mention node、selector 与 canonical PromptBlock serialization。
- **Acceptance**：DEL-006；显示名变化不改变 agent kind。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/components/tasks/follow-up/AgentMention.test.tsx`
- **Files**：Mention node/plugin、SessionComposerInput integration、serializer、tests、
  locale。

### T2.3 Mention 语义进入 companion tool schema

- **Depends**：T2.1、T2.2。
- **RED**：MCP `tools/list` contract fixture 断言工具描述包含全部 AgentMention 是显式
  委派请求、稳定 URI 示例和异步用法；当前 schema 不满足而失败。
- **GREEN**：更新 schema 与 companion 输出；不在前端直接派发。
- **Acceptance**：DEL-007；Mention 与真实 delegation 的边界清楚。
- **Verify**：`cargo test -p vibex-mcp tool_schema_explains_agent_mentions`
- **Files**：tool schema、companion schema loader、contract test。

### T2.4 Broker 并发、竞态、深度与缓存 parity

- **Depends**：T2.1。
- **RED/GREEN 子循环**：依次只做一个 tracer bullet：
  1. 两个相同 Agent/任务并行不串 parent tool call；
  2. setup 中 child complete 与 cancel 竞争只产生一个终态；
  3. parent close 级联取消；
  4. 深度 1–8；
  5. 单结果 256 KiB 截断、per-parent cache 驱逐与 DB fallback。
- **Acceptance**：DEL-004/005；每个 bullet 都保留独立测试名。
- **Verify**：`cargo test -p delegation`
- **Files**：每轮只改 broker 相关 1–3 个模块和对应 tests；需要时从大文件拆模块。

### T2.5 子 Conversation 链与事件持久化

- **Depends**：T2.4、conversations crate。
- **RED**：通过真实临时 SQLite + fake child launcher 发起 delegation，断言 child link
  持久化，父时间线出现 Requested/Started/Completed，重建 projection 后状态一致。
- **GREEN**：Delegation spawner 调用 Conversation service；新增缺失事件/投影，内存
  emitter 不再是唯一事实。
- **Acceptance**：DEL-003/008 的持久化部分。
- **Verify**：`cargo test -p conversations delegation_events_rebuild_child_binding`
- **Files**：Conversation events/projection、delegation adapter、DB migration/model、
  integration test。

### T2.6 委派卡片与子会话导航

- **Depends**：T2.5、T2.2。
- **RED**：mock timeline projection 依次提供 running/completed/cancelled；用户看到准确
  状态并可打开 child；只有 Mention 没有事件时不显示 running 卡。
- **GREEN**：卡片只消费 timeline row/projection，移除对瞬时 event map 的权威依赖。
- **Acceptance**：DEL-008；刷新与冷启动一致。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/features/delegation/DelegateToAgentToolCard.test.tsx`
- **Files**：delegation card、timeline adapter、navigation、tests、locale。

### T2.7 Steering feature capabilities

- **Depends**：T2.1、T2.4。
- **RED/GREEN 子循环**：分别为 feedback 至少一次读取/commit、ask 阻塞后结构化回答、
  session info 添加 companion seam 测试和最小实现；任一关闭时不出现在 tools/list。
- **Acceptance**：DEL-009；某附加 feature 失败不关闭 delegation。
- **Verify**：`cargo test -p vibex-mcp && cargo test -p delegation`
- **Files**：proto、listener feature module、companion、tests。

### T2.8 多 Agent 桌面端到端

- **Depends**：T2.3–T2.7。
- **RED**：fake MCP-capable parent 的 E2E 脚本无法完成“输入两个 `&Agent` → 两个真实子
  Conversation → 一成功一取消 → 刷新恢复”。
- **GREEN**：只补端到端暴露的 wiring/packaging 问题。
- **Acceptance**：DEL 全部；Windows named pipe 与 Unix UDS 至少各有 CI integration。
- **Verify**：`cargo test --workspace` + 前端 delegation tests + 平台 E2E。
- **Files**：E2E fixture/driver、sidecar packaging config、必要 wiring、acceptance record。

**M2 Gate**：上述 E2E 通过；不支持父级 delegation 的 Agent 有明确 capability UI。

## M3 — Automation v2 Backend 与设置

### T3.1 Canonical TurnLaunchSpec

- **Depends**：M0；若引用 PluginAction 则依赖 T1.7。
- **RED**：同一 fixture 分别从正常 Composer 和 Automation draft 归一化，断言得到相同
  prompt blocks/Agent mode/config/plugin refs；无效引用返回稳定错误。
- **GREEN**：在 `automation` 或共享 prompt crate 定义 versioned TurnLaunchSpec 和
  validator，正常发送与 Automation 共用。
- **Acceptance**：AUT-001；不再复制一份“automation prompt”规则。
- **Verify**：`cargo test -p automation turn_launch_spec_matches_composer_input`
- **Files**：automation crate skeleton、TurnLaunchSpec、Composer backend adapter、tests。

### T3.2 Automation/Run v2 持久模型与旧数据迁移

- **Depends**：T3.1。
- **RED**：迁移旧 `cron+prompt+executor+in_place` fixture，断言 spec version、IANA
  timezone 和 disabled `shared_in_root` draft；running 旧 Run 成为 Interrupted。
- **GREEN**：新迁移、models/repository；保留原始字段证据直到迁移确认。
- **Acceptance**：AUT-001/003/006 的数据基础；不静默重新启用旧 in-place。
- **Verify**：`cargo test -p db automation_v2_migration_preserves_intent_safely`
- **Files**：migration、Automation model/repository、integration test、type export。

### T3.3 Cron + IANA timezone + 下一次运行预览

- **Depends**：T3.2。
- **RED/GREEN 子循环**：固定 clock 下覆盖普通时间、DST spring gap、fall ambiguity、
  disabled/manual 和 invalid zone；preview 与 scheduler 返回同一 UTC。
- **Acceptance**：AUT-002；前端不自算 cron。
- **Verify**：`cargo test -p automation schedule`
- **Files**：schedule module、clock port、tests。

### T3.4 Engine owner lock 与原子 due claim

- **Depends**：T3.2、T3.3。
- **RED**：两个 Engine 指向同一 temp DB/data dir，只有一个获得 owner；两个并发 tick
  对同一 due Automation 只产生一个 running Run，并先推进 next_run。
- **GREEN**：实现 advisory lock、transactional claim 和 per-automation lock。
- **Acceptance**：AUT-005/006/009。
- **Verify**：`cargo test -p automation engine_claim`
- **Files**：engine、owner lock port/adapter、repository claim、tests。

### T3.5 默认 worktree-per-run 与 shared-root 防护

- **Depends**：T3.4。
- **RED**：fake Git adapter 验证默认创建 `automation/<id>/run-<run_id>`；shared root
  dirty/wrong branch 被拒并产生 failed Run，不 spawn Agent。
- **GREEN**：WorkspacePreparer port 和 Git adapter；持久化 worktree workspace id。
- **Acceptance**：AUT-004。
- **Verify**：`cargo test -p automation workspace_isolation`
- **Files**：isolation service/port、git adapter、tests、run model。

### T3.6 Run 创建真实 Conversation/Turn 并跟随终态

- **Depends**：T3.1、T3.5、conversations crate。
- **RED/GREEN 子循环**：Completed、Failed、Cancelled、Interrupted 四个真实 terminal
  fixture 依次驱动 Run 状态；“start_turn 返回成功”时 Run 仍为 running。
- **GREEN**：TurnLauncher adapter 调用 conversations；以 conversation/turn id 关联，
  监听事件并用持久投影 reconcile。
- **Acceptance**：AUT-003/007；每个 Run 保存 resolved version evidence。
- **Verify**：`cargo test -p automation run_tracks_turn_terminal_state`
- **Files**：engine runner、Conversation adapter、run projection/repository、tests。

### T3.7 取消窗口与启动恢复

- **Depends**：T3.6。
- **RED/GREEN 子循环**：在 claim 后、worktree 后、connection 后、send 前分别取消，
  断言后续副作用未发生；模拟宿主死亡后 running→Interrupted，不重发；due 项至多
  catch-up 一次。
- **Acceptance**：AUT-006/008。
- **Verify**：`cargo test -p automation cancellation_and_recovery`
- **Files**：engine cancellation/recovery、tests、必要 repository method。

### T3.8 模板是普通 Automation draft

- **Depends**：T3.1。
- **RED**：七个模板都能通过同一 validator，创建后可任意编辑，运行路径没有 template
  分支。
- **GREEN**：打包模板数据与 catalog service。
- **Acceptance**：AUT-011/012。
- **Verify**：`cargo test -p automation all_builtin_templates_are_valid_drafts`
- **Files**：template catalog、bundled fixtures、tests。

### T3.9 自动化设置页：首个可运行垂直切片

- **Depends**：T3.1–T3.8、T1.7。
- **RED/GREEN 子循环**：
  1. 创建 manual + worktree automation；
  2. schedule + timezone/cron preview；
  3. Agent mode/config + PluginAction；
  4. run now + 历史/失败；
  5. template → editable draft。
- **Acceptance**：AUT-010；每轮使用 mocked BackendTransport，通过用户操作断言。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/pages/settings/AutomationsSettings.test.tsx`
- **Files**：每轮一个 editor section、API facade、test、locale，避免一次重写全部页面。

### T3.10 Automation 桌面 E2E

- **Depends**：T3.9。
- **RED**：从设置创建含 Office PluginAction 的定时 Automation，fake clock 触发，无法
  完成独立 worktree → Conversation/Turn → Artifact → succeeded 的完整路径。
- **GREEN**：只补跨层 wiring；不得在 E2E 中新增业务特判。
- **Acceptance**：AUT 全部；脏 shared root、重叠 skip、重启 Interrupted 作为负路径。
- **Verify**：Automation E2E + `cargo test --workspace`。
- **Files**：E2E harness、fixtures、acceptance record、必要 wiring。

**M3 Gate**：旧 scheduler 已停用；同一数据目录不存在双 Engine；Run 状态不再表示
“仅启动成功”。

## M4 — Application Core 与 BackendTransport

### T4.1 第一个 transport-neutral Conversation use case

- **Depends**：M0。
- **RED**：`application` crate 通过 temp DB 调用 `list_conversations`，不构造 AppHandle；
  crate 不存在/现逻辑在 command 中而失败。
- **GREEN**：创建 Application service facade，复用 conversations/db service；Tauri
  command 只转换输入输出。
- **Acceptance**：WEB-001 的第一个 tracer bullet。
- **Verify**：`cargo test -p application list_conversations_without_tauri`
- **Files**：application crate skeleton、conversation use case、Tauri adapter、tests。

### T4.2 前端 BackendTransport + TauriTransport

- **Depends**：T4.1。
- **RED**：现有 conversation API facade 在 fake BackendTransport 下完成 list 调用，
  且测试环境不 import `@tauri-apps/api`。
- **GREEN**：定义 Transport、provider/factory 和 TauriTransport；迁移一个 API facade。
- **Acceptance**：WEB-002 的第一个切片；桌面行为不变。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/lib/transport/BackendTransport.test.ts`
- **Files**：transport types/provider/Tauri implementation、一个 API facade、tests。

### T4.3 Command contract registry 与生成类型

- **Depends**：T0.3、T4.1。
- **RED**：同一 command fixture 经过 local adapter 与 serde round-trip 得到相同规范化
  result/error；漏注册 command 时 schema check 失败。
- **GREEN**：建立 typed command descriptors/exports；避免任意字符串反射调用未授权
  command。
- **Acceptance**：后续 Tauri/HTTP adapter 共用契约，但保持逐操作 authorization。
- **Verify**：`cargo test -p application command_contract`、
  `pnpm run generate-types:check`
- **Files**：application contracts、remote-protocol DTO、type generator、tests。

### T4.4 按领域迁移前端 API facade

- **Depends**：T4.2、对应领域 gate。
- **RED/GREEN 子循环**：conversations → delegation → plugins/artifacts → automations →
  settings；每轮让一个现有 API 测试在 fake transport 下 RED，再移除其直接
  `tauriInvoke/listen`。
- **Acceptance**：业务 feature 不直接 import Tauri；桌面全套前端测试保持绿。
- **Verify**：
  `rg -n \"@tauri-apps/api|tauriInvoke|tauriListen\" frontend/src/lib/api frontend/src/features`
  只剩允许的 TauriTransport/desktop adapters。
- **Files**：每轮一个 facade、相关 feature test、transport mapping。

### T4.5 持久事件 attach/replay contract

- **Depends**：T0.3、conversations event sequence。
- **RED/GREEN 子循环**：
  1. after_sequence=0 返回 snapshot/replay/high-water；
  2. after_sequence 在保留范围内只返回增量；
  3. attach ready 与并发 start_turn 不丢事件；
  4. 重复事件由 sequence 幂等去重；
  5. 未知事件安全保留/忽略。
- **GREEN**：在 application/remote-protocol 定义 subscription bootstrap 与 event
  cursor；数据来自持久事件日志。
- **Acceptance**：WEB-004/005/006 的核心协议。
- **Verify**：`cargo test -p remote-protocol && cargo test -p application replay`
- **Files**：subscription DTO、application attach use case、conversation adapter、tests。

**M4 Gate**

- 核心 feature facade 不直接依赖 Tauri；
- 同一 command/replay fixture 的 local adapter 与协议序列化结果一致；
- 桌面回归测试全绿。

## M5 — vibex-server、WebTransport 与 Web 功能

### T5.1 Headless Server：capabilities 与认证

- **Depends**：M4。
- **RED**：Axum test client 对 `/api/v1/capabilities`：无 token 为 401，合法 token 返回
  协议/Server/最低客户端版本；Server 初始化不需要 Tauri。
- **GREEN**：建立 server crate/binary、composition root、token hash store、默认
  loopback router 和静态 health/capabilities。
- **Acceptance**：WEB-003/004/008 的最小运行体。
- **Verify**：`cargo test -p server capabilities_require_auth`
- **Files**：server crate skeleton/main/router/auth、tests、workspace。

### T5.2 WebTransport 的 call 与 WebSocket attach

- **Depends**：T5.1、T4.5。
- **RED**：浏览器 transport 对 test Server 完成 authenticated call、WS attach、ready、
  event apply；断开后用 last sequence 重连。
- **GREEN**：实现 WebTransport、指数退避、single socket subscription multiplex；
  token 不进入 query/log。
- **Acceptance**：WEB-002/005/006。
- **Verify**：
  `cd frontend && pnpm exec vitest run src/lib/transport/WebTransport.test.ts`
  加 server WS integration test。
- **Files**：WebTransport/socket manager/tests、server WS route/protocol adapter。

### T5.3 Web 会话关键旅程

- **Depends**：T5.2。
- **RED/GREEN 子循环**：项目/会话列表 → 创建会话 → start Turn/stream → permission
  response → cancel；每轮添加一个 HTTP/Application adapter contract 和一个 UI 行为
  test。
- **Acceptance**：WEB-007 的 Conversation 基础；结果与 Tauri adapter 等价。
- **Verify**：server contract tests + 对应 frontend feature tests。
- **Files**：每轮一个 application use case、server adapter、API facade mapping、tests。

### T5.4 Web Delegation、Plugin/Artifact、Automation

- **Depends**：M1、M2、M3、T5.3。
- **RED/GREEN 子循环**：
  1. Web 查看/取消 delegation 并打开 child；
  2. Plugin enable/install operation stream；
  3. Artifact list/preview；
  4. Automation CRUD/run/history；
  5. Settings capability gating。
- **Acceptance**：WEB-007；所有领域继续使用同一 Application Core。
- **Verify**：按领域 server contract + frontend tests。
- **Files**：每轮 application adapter、server route/registry、transport mapping、UI test。

### T5.5 Office/Plugin preview capability proxy

- **Depends**：T1.9、T5.1。
- **RED/GREEN 子循环**：
  1. 无/错/过期 cap 拒绝；
  2. 未注册端口拒绝，防 SSRF；
  3. cap 不转发给 upstream；
  4. HTML/事件 URL 经代理正确工作；
  5. iframe 无 same-origin 且拿不到主 token。
- **GREEN**：适配 Codeg proxy 到 ArtifactPreviewLease；所有行为从公开 HTTP seam 测试。
- **Acceptance**：ART-007、WEB-009。
- **Verify**：`cargo test -p server preview_proxy`
- **Files**：proxy handler/service、preview capability DTO/registry、integration tests。

### T5.6 Automation Engine owner 在桌面/Server 间互斥

- **Depends**：T3.4、T5.1。
- **RED**：同时启动 desktop test composition 与 server composition 指向同一 data dir，
  只有一方 engine active；owner 退出后另一方可接管并先 reconcile。
- **GREEN**：把 engine owner 组装放入共享 composition lifecycle，UI 显示
  read-only/non-owner 状态。
- **Acceptance**：AUT-009 在多宿主真实成立。
- **Verify**：server/application integration test。
- **Files**：application composition、desktop bootstrap、server bootstrap、tests。

### T5.7 Remote Desktop Transport

- **Depends**：T5.2。
- **RED**：两个 Tauri window/server profile 订阅不同 Server，事件不串；mixed-content
  URL 通过 Rust remote adapter，token 不进入 WebView JS 持久存储。
- **GREEN**：实现 RemoteDesktopTransport 与每窗口连接生命周期。
- **Acceptance**：WEB-010。
- **Verify**：Tauri integration + frontend transport tests。
- **Files**：Rust remote adapter/commands、frontend transport/provider、tests。

### T5.8 Web 生产构建与 E2E

- **Depends**：T5.3–T5.7。
- **RED**：从生产静态资源启动 `vibex-server`，Playwright 旅程无法完成登录、创建 Turn、
  permission、断线恢复、delegation、Automation 和 Office preview。
- **GREEN**：补静态 fallback、base path、资源路径和部署配置，不在 E2E 特判业务。
- **Acceptance**：WEB 全部；未支持的 CEF 能力按 capability 隐藏。
- **Verify**：Web E2E、`pnpm run frontend:build`、server packaging smoke。
- **Files**：E2E specs/fixtures、server static config、build script、deployment doc。

**M5 Gate**

```bash
cargo test -p server
cargo test -p application
cargo test -p remote-protocol
cd frontend && pnpm test
pnpm run frontend:build
```

随后用生产构建完成 Web 关键旅程；默认服务只监听 loopback。

## M6 — 移动端协议准备（不开发 App）

### T6.1 Schema 与多语言代码生成验证

- **Depends**：M5。
- **RED**：协议 fixture 无法生成/编译 TypeScript、Swift、Kotlin DTO，或未知事件解码
  失败。
- **GREEN**：输出 versioned JSON Schema/OpenAPI；在 CI 用最小 generated model smoke
  验证三种语言，产物可不提交或放 generated test fixture。
- **Acceptance**：MOB-001/002/004；仓库仍无移动 App。
- **Verify**：schema generation check + TS/Swift/Kotlin compile smoke（平台可用时）。
- **Files**：remote-protocol schema generator、scripts、CI/test fixtures、docs。

### T6.2 设备配对与可撤销 token 协议

- **Depends**：T5.1。
- **RED**：一次性 pairing token 只能兑换一次、过期拒绝、撤销设备后 HTTP/WS 都失败；
  token/secret 不出现在事件或日志。
- **GREEN**：实现 pairing DTO/use case/token scopes 与 audit；Web 设置只提供生成二维码
  的协议入口，不做移动 App。
- **Acceptance**：MOB-003、WEB-008。
- **Verify**：server auth integration tests。
- **Files**：auth service/store、pairing routes/DTO、tests、settings affordance。

### T6.3 通知摘要与离线只读契约

- **Depends**：M5。
- **RED**：Conversation/Automation terminal fixture 能生成不含 secret 的通知摘要；
  客户端从缓存 high-water 恢复只读时间线并忽略未知事件。
- **GREEN**：增加 summary projection/capability/schema；不接 APNs/FCM。
- **Acceptance**：MOB-003/004。
- **Verify**：remote-protocol/application tests。
- **Files**：summary DTO/projection、capability、tests、mobile protocol doc。

**M6 Gate**：远程协议文档足以让独立客户端只依赖 Server，不读取 VibeX SQLite 或本机
路径；仓库没有 iOS/Android 产品代码。

## M7 — 安全、迁移、恢复与发布收口

### T7.1 迁移演练

- **Depends**：M1、M3、M5。
- **RED**：复制脱敏的 v1 DB fixture 后升级，验证 plugin/automation/token 迁移；遇到
  中断再启动能继续协调，不能执行旧命令或重发旧 Turn。
- **GREEN**：修复迁移/reconciliation，不添加一次性人工 SQL。
- **Acceptance**：升级可解释、可重试、无隐式副作用。
- **Verify**：migration E2E + `pnpm run prepare-db:check`。

### T7.2 崩溃与竞态矩阵

- **Depends**：全部 backend gate。
- **RED/GREEN 子循环**：随机化/受控调度覆盖安装、preview、delegation、automation、
  Web replay 的关键 crash windows；每次只修一个可复现种子。
- **Acceptance**：无永久 running、双终态、双调度、未验证执行和事件缺口。
- **Verify**：目标 state-machine tests，可选 property tests 保留失败 seed。

### T7.3 安全审查

- **Depends**：M5、M6。
- **RED**：攻击 fixture 覆盖 path traversal、symlink escape、SSRF、cap replay、CORS、
  token in URL/log、超大帧/结果、恶意 manifest；任何成功即失败。
- **GREEN**：在公共 authorization/scope seam 修复，不在单 route 打补丁。
- **Acceptance**：NFR-001/003/005。
- **Verify**：server security suite + dependency/license audit。

### T7.4 全量质量门与文档同步

- **Depends**：T7.1–T7.3。
- **RED**：先运行全量门，逐项记录失败；每次只修一个真实失败并保持目标测试。
- **GREEN**：全部命令通过，更新 `CONTEXT.md` 领域术语、用户文档、部署/故障排查和
  Codeg adoption 清单。
- **Verify**：

```bash
pnpm run generate-types:check
pnpm run prepare-db:check
cargo test --workspace
cd frontend && pnpm test
cd ..
pnpm run check
pnpm run lint
pnpm run frontend:build
```

- **Acceptance**：桌面与 Web 验收记录齐全；移动端仍为明确非目标；所有 ADR/spec 链接
  有效。

## 需求追踪

| 需求 | 主要任务 |
|---|---|
| PLG-001–009 | T1.1–T1.7、T1.11、T7.1 |
| ART-001–007 | T1.8–T1.10、T5.5 |
| DEL-001–009 | T2.1–T2.8 |
| AUT-001–012 | T3.1–T3.10、T5.6 |
| WEB-001–010 | T4.1–T4.5、T5.1–T5.8 |
| MOB-001–004 | T6.1–T6.3 |
| NFR-001–006 | M0、各里程碑 gate、T7.1–T7.4 |

## 完成定义

一项任务只有在以下条件同时满足时才可勾选：

- 有先失败后通过的公共行为测试记录；
- acceptance 中的用户可观察行为成立；
- 目标 crate/feature 全套测试通过；
- 新协议/状态有错误码、取消和恢复语义；
- DB/type 生成物已校验；
- 复用 Codeg 时 adoption/许可证记录已更新；
- 没有为了兼容旧代码而保留第二套权威状态机。
