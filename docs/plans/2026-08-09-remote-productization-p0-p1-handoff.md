# VibeX 远程产品化 P0/P1 开发交接

**交接状态：** 分析与决策文档完成，P0/P1 尚未进入开发实施。
**VibeX 基线：** `e13d2a4366e2d03f2abc4e523be91cfd626792f9`
**Codeg 对照基线：** `aa0c4d694870420b2caf7dba285b05dca789cecf`

## 当前任务完成情况

本轮已经完成 Codeg 与 VibeX 的远程能力比较、P0/P1 范围核对、关键架构取舍和完整交付
计划。结论是 Codeg 已有可使用的远程产品路径，而 VibeX 已有更严格的 Application Core、
版本化协议、持久事件序列和设备授权基础，但缺少桌面产品入口、完整远程编码闭环、正式
Server 发行物、Conversation Split View 与 Android 应用。

本轮没有实现任何 P0/P1 业务代码、数据库迁移、协议生成物、Android 工程或发行流水线。
现有仓库中的 Remote Protocol、Headless Host、Web UI 和 Remote Desktop bridge 是进入
本计划前已经存在的基础，不应被记为本轮开发完成量。

完整范围、依赖顺序、验收旅程和提交边界以
[P0/P1 改进计划](./2026-08-09-remote-productization-p0-p1.md)为唯一实施清单，不在本交接
文档重复展开。

## 已落地的文档资产

- [P0/P1 改进计划](./2026-08-09-remote-productization-p0-p1.md)：包含 Codeg 对比结论、
  当前能力盘点、P0.0–P0.6、P1-A/B/C、测试矩阵、交付顺序和 Definition of Done。
- [ADR-0033](../adr/0033-shared-application-core-and-versioned-remote-transport.md)：补充长期设备
  信任、Server-bound window、远程编码闭环、单 owner、权限预设和 Android/通知边界。
- [ADR-0041](../adr/0041-native-kotlin-compose-android-companion.md)：确定 Android 使用原生 Kotlin
  与 Jetpack Compose，iOS 不属于 P1。
- [ADR-0042](../adr/0042-conversations-are-first-class-dockview-panels.md)：确定 Conversation 是一等
  Dockview panel；布局不跨设备共享，Conversation draft 跨设备共享并使用 CAS。
- [领域术语](../../CONTEXT.md)：补充 Remote、Device、Mobile companion、Conversation panel
  和 Conversation draft 的规范语义。

## 不得在实施中悄然改变的约束

以下内容已由用户逐项确认；如需改变，必须重新进入决策流程并同步计划、领域术语和 ADR：

- 配对 secret 只使用一次，兑换后的 scoped device credential 长期有效；断开、重启、网络
  变化和管理员 token 轮换不得要求相同设备重新认证。
- Host 必须是在线桌面应用或 Headless Server；没有 Host 在线时，Android 只能读取带最后
  同步时间的离线缓存，所有写操作禁用。
- 不引入 FCM、第三方推送或 VibeX 云中继；Android 首版使用前台连接/前台服务和本地通知。
- P0 以完整远程编码闭环为边界，不以远程化全部 Tauri command 为目标。
- P0/P1 是单一 Server owner、多台 Paired device，不是多用户、团队或多租户系统。
- 每个应用窗口只绑定一个 Server Profile；跨 Server 的资源、凭据、缓存、capability 和布局
  不得混用。
- Dockview 布局只在当前设备保存；Conversation draft 属于 Server 上的 Conversation，可在
  桌面、Web 和 Android 之间共享，但必须通过 revision/CAS 处理冲突。
- Android 是首个移动交付平台，不在移动设备上运行 Agent、Git worktree 或 Artifact runtime。

## 下一位 agent 的建议起点

从计划的 **P0.0 — Freeze baselines and protocol guardrails** 开始，只完成这个可独立验收的
切片后再进入 P0.1。首个开发切片应至少做到：

1. 为现有 Local/Tauri、Web 和 Remote Desktop transport 建立行为基线 fixture。
2. 在协议中加入由数据目录持有的稳定 `server_instance_id`，并贯穿 pairing redemption 和
   已认证 capabilities。
3. 定义版本化 Developer Device permission preset 到细粒度 scopes 的映射，保证新增 scope
   不会自动扩大旧预设。
4. 建立 P0 command → scope → capability → transport → UI consumer → test 登记表。
5. 保留现有轮询作为待删除 characterization，不在新功能中继续扩展轮询路径。
6. 更新并校验 Schema、OpenAPI、TypeScript/Kotlin 生成物及兼容性 fixture。

完成 P0.0 前不要开始 Profile UI、系统凭据库存储、Android 工程或 Conversation Split View；
这些工作都依赖稳定身份、scope preset 和协议基线。

## 工作区边界

当前工作树不是干净状态。与本轮远程产品化规划直接相关且尚未提交的文件是：

- `CONTEXT.md`
- `docs/README.md`
- `docs/adr/0033-shared-application-core-and-versioned-remote-transport.md`
- `docs/adr/0041-native-kotlin-compose-android-companion.md`
- `docs/adr/0042-conversations-are-first-class-dockview-panels.md`
- `docs/plans/2026-08-09-remote-productization-p0-p1.md`
- 本交接文档

工作树中还存在 Agent 设置、Tauri inspector、process/shell、onboarding、README、生成类型及
启动脚本等其它修改和未跟踪文件。它们不属于本轮规划任务，下一位 agent 必须先运行
`git status --short`，保留这些改动，不得 reset、checkout、覆盖或顺手格式化无关文件。

## 已执行验证

- 对计划、文档索引和两份新 ADR 执行 Prettier 检查，通过。
- 对跟踪中的任务文档执行 `git diff --check`，通过。
- 对新文档执行尾随空白和文件末尾换行检查，通过。
- 对计划、ADR 和文档索引执行本地 Markdown 链接检查，通过。
- 重新核对 Codeg 项目说明，确认其桌面 Web Service、独立 Server、Docker、WebSocket、
  Split View 和原生移动客户端能力与比较结论一致。

本轮只修改文档，因此没有运行 Rust、TypeScript、Tauri、E2E 或 Android 测试。开始 P0.0
开发后，应按计划第 11 节运行对应的定向测试，再逐步扩大到全量门禁。

## Suggested skills

- `maiden-skill`：每个开发切片开始前必用，维持单一权威、完整纵向闭环和无残留迁移。
- `tdd`：协议、存储、transport 或 UI 行为均先建立失败测试/characterization。
- `testing-tauri-apps`：进入 P0.1/P0.2 的窗口、IPC、生命周期和 Remote Desktop bridge 时使用。
- `frontend-design` 与项目内 `impeccable`：实现 Profile、配对和连接状态 UI 时共同使用。
- `ci-cd-and-automation`：只在 P1-A 正式 Server 打包、签名和发布流水线阶段使用。
- `review`：每个 P0/P1 纵向切片完成后，按计划与仓库标准做双轴审查。
- `grill-with-docs`：只有在用户要求改变已确认边界时再次使用；常规实现无需重新提问。

## 完成交接判定

本轮任务已完成到“可交给开发 agent”的程度：问题结论明确、P0/P1 决策冻结、文档互相引用、
下一切片和验收门禁清楚。下一位 agent 的任务是实施，而不是重新分析 Codeg 或重新设计
P0/P1；除非代码事实证明计划与现状冲突，此时应先记录证据，再最小化修正文档。
