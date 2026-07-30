---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# 自动化重放版本化 TurnLaunchSpec，并产生真实 Conversation 与 Turn

VibeX 自动化按 Codeg 的产品语义重建：Automation 不是 cron 包装器，也不是后台
执行一段自由 shell，而是一份保存并可重复解析的“发起 Turn”配置。每次触发创建
AutomationRun、真实 Conversation 和真实 Turn；Conversation 事件日志是执行事实，
AutomationRun 只是面向调度、列表和保留策略的索引/摘要。

## 保存的启动配置

Automation 持有版本化 `TurnLaunchSpec`，至少包含：

- 结构化 prompt blocks、显示文本和附件/引用；
- `AgentKind` 选择意图，而非永久安装路径；
- mode 与 session config overrides；
- Plugin actions、Skills 和工具能力引用；
- Project/root folder、目标 branch；
- `worktree_per_run` 或 `shared_in_root` 隔离方式；
- 触发方式、cron、IANA timezone；
- 创建时的可读 label snapshot，用于历史解释。

每次运行前重新解析 Agent、插件与工具的当前可用安装；运行记录保存实际使用的 Agent
Runtime、ACP adapter、插件版本和工具安装锁证据。这延续 ADR-0029：Conversation 和
Automation 都不永久锁定旧 Agent 安装，但每个 Turn 必须可解释。

## 调度与运行语义

- 首版触发器为 `manual` 与 `schedule`；
- 调度器持久化 `next_run_at`（UTC），cron 按保存的 IANA timezone 解释；
- 认领到期项时先原子推进 `next_run_at`，再启动 Run；
- Engine 停止期间错过的多个触发点在恢复后**至多追赶一次**，不会逐条补跑；
- 如果崩溃前已有 `running` Run，启动恢复将其标记为 `interrupted`，绝不自动重放
  其 Turn；这与 ADR-0001 的副作用安全语义一致；
- 同一 Automation 首版不重叠运行；重叠触发写入 `skipped` Run，而不是静默丢弃；
- `worktree_per_run` 为默认隔离；`shared_in_root` 必须取得 per-root 锁、验证 branch，
  并在工作区 dirty 时拒绝启动；
- Turn 的 Completed、Failed、Cancelled、Interrupted 终态决定 Run 终态；
- 手动取消必须在认领、创建工作区、创建连接和发送 Turn 的每个窗口再次检查，防止
  取消后仍产生副作用；
- 自动化只产生工作结果和 Artifact，不自动 merge、push、发布或部署；这些外部副作用
  必须由后续明确审批能力控制。

“宿主进程未运行时不产生运行；错过的定时触发不补跑”的旧说明被本决定细化并取代：
不逐条补跑，但持久化到期项在 Engine 恢复后允许至多一次 catch-up。

## Engine 所有权

同一数据目录同一时刻只能有一个 Automation Engine 所有者。桌面宿主与未来
`vibex-server` 竞争同一 advisory lock；未取得锁的进程可以读写 Automation 配置，
但不得调度。Engine 启动后先做 Run reconciliation，再开始认领。

事件丢失不能让 Run 永久停在 running。Engine 既监听 Conversation 终态事件，也周期性
从持久化事件/投影协调；内存中的 connection map 只用于加速，不是权威。

## Consequences

- 当前只把“成功发起 Turn”记作 run completed 的实现被取代；Run 必须跟随真实 Turn
  直到终态。
- 当前本机时区和 `in_place` 默认实现被取代；迁移时为旧记录显式写入本机 IANA
  timezone，并把旧 `in_place` 映射为需用户确认的 `shared_in_root`。
- 设置中的自动化页面升级为完整编辑器：复用 Composer blocks、Agent mode/config、
  Plugin action、branch picker、timezone、cron builder、运行历史和模板。
- 首批模板至少包括代码审查、依赖检查、测试覆盖、TODO 扫描、CI 排障、Release Notes
  和安全审计；模板只是创建配置的起点，不是特殊运行路径。
- Run 与临时 worktree 必须有保留期、磁盘配额和显式清理策略。

## Considered Options

- 保留 `cron + prompt + executor` 简单模型：否决。它不能重放用户真实的 Composer
  意图，也无法表达插件、文件引用、Agent config 和隔离。
- 自动化直接调用 Agent runtime 而不创建 Conversation：否决。这样会产生不可审计、
  不可恢复且无法从 Web/移动端查看的第二套执行体系。
- 默认在项目根目录运行：否决。自动化应默认隔离，避免未监督任务污染用户工作树。
