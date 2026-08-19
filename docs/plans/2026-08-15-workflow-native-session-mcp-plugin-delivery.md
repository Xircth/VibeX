# Workflow 原生会话、MCP 与 Creator Plugin 完整交付计划

## 目标

把 Workflow 从“可画 DAG 的配置页”完成为可保存、可运行、可逐节点干预、可由 Agent/MCP
共同创作和调试的生产能力，并把 Workflow Creator 作为独立 SDK 项目交付。

## 用户全流程

1. 用户在“设置 → 自动化 → 工作流”创建 source，配置项目、工作区、触发方式和输入。
2. 用户添加 Agent/Approval 节点。新节点先在 Inspector 中编辑，点击“保存节点”后进入 DAG。
3. Agent 节点选择 Agent，并通过与普通会话相同的 Summary 选择模型、权限和其他原生配置。
4. 用户填写任务 Prompt、完成后行为和输出 JSON 示例；连接边形成真实 `dependsOn`。
5. 用户可点击“测试”或在已保存节点对话中直接输入，创建真实 Debug run、Child Conversation
   与 Turn。消息、工具、权限请求和输出使用普通会话投影。
6. Automatic 节点无人干预时自然完成并进入下游；一旦被用户/Controller Agent 干预，必须点击
   “确认完成”。Manual 节点始终经图上的确认投影等待确认。
7. 用户保存 source，发布不可变版本并应用到 Automation；运行时可暂停整个 DAG、暂停单个 Turn、
   继续节点对话、终止 Run 或从指定节点派生重跑。
8. Agent 在 Workspace 会话中通过 Workflow Creator Skill + MCP 完成同样的读取、编辑、发布、运行、
   检查和确认操作，用户在同一 Studio surface 查看结果。

## 实施顺序

### A. 领域与协议

- 扩展 `AgentStepSpec`：`executorProfileId`、`modeOverride`、`configOverrides`；保持 source 向后兼容。
- 把 output Schema 定义为提示示例；删除 Agent 输出解析、Schema 校验与 repair 调度。
- 只提取当前 Turn 最后活动边界之后的 Assistant 最终文本，并以 JSON string 保存/传递。
- 增加平台语言到 Prompt renderer；前置输出、任务、输出约定使用稳定模板。
- 记录“发生人工干预”并强制进入 `awaiting_acceptance`。
- 继续输入以持久化 input 的最终 `turnId` 完成绑定，覆盖提交与 dispatcher 之间的短暂竞态。
- 补齐启动 Debug run/节点测试/直接节点输入/确认的 Application Core 命令。

### B. Studio

- 新节点使用 Inspector-local draft；保存后才写入 source graph。
- 复用 `SessionSettingsSummary` 与 Agent controls 查询，不显示 Workflow 自造权限选项。
- 对话 Tab 使用真实 Conversation timeline 和 ChatComposer；未保存禁用，保存后可直接发送。
- 增加“测试”和“确认完成”；测试后自动切换对话。
- 为 Manual Agent Step 派生 confirmation view node 和 edge，点击跳转到所属对话。
- 保留节点拖拽、边双击删除、一次弯折 tether、节点日志和状态动效。

### C. MCP

- 按 MCP `2026-07-28` 实测 discover/initialize/tools/list/tools/call。
- 补齐 start、test、terminate 与确认相关工具；所有业务调用只走 VibeX Application Core。
- 增加 `workflow_review_step`，覆盖中断后的 retry/accept/skip；同一路径发布必须复用 Definition 身份。
- 使用真实 Host gateway 验证 source CAS、publish、run、inspect、pause/continue/accept。
- 用 MCP 创建“VibeX 全仓代码审阅”：三个 Codex 节点，首节点 Manual，后两节点 Automatic。

### D. 独立插件

- 将插件源迁移到 `~/Projects/vibe-workflow-creator`，不引用 VibeX 私有模块。
- 只使用本机 public Plugin SDK/CLI；Skill、managed MCP、file opener、artifact editor 共用一个产品身份。
- file opener 使用 SDK 的 `nativeRenderer: workflow.studio` 声明，Host adapter 直接复用原生 Studio；
  不打包第二套图编辑规则。
- 通过 build、validate、test、linked install、doctor、pack。
- 生成确定性 `.vxp` 并通过 VibeX 插件控制面安装，保留默认全 Agent binding。

## 测试矩阵

- Rust：definition 兼容、Prompt renderer、原始输出、自动/人工确认、干预、暂停/继续、derived run。
- Frontend：新节点保存门、原生 Summary、测试切 Tab、输入启用、确认投影、点击跳转、拖拽与删边。
- MCP：modern/legacy negotiation、工具目录、错误 envelope、真实 Host 全流程。
- Plugin：Worker/App harness、artifact CAS 冲突、build/validate/test/doctor/pack、真实安装。
- Product：中文与英文、浅色/深色、reduced motion、键盘焦点、窄窗口。

## 完成门槛

- `pnpm run check`、目标前端测试、Workflow Rust tests 与插件全部命令通过；
- 真实 Workflow MCP 创建、发布并检查三节点 Workflow；
- 用户页面能完成同样的创建、会话、确认和运行操作；
- 独立 `.vxp` 已安装并能在设置 → 插件中被发现；
- 不保留第二套 Studio、第二套 validator 或硬编码 Agent 权限枚举。

## 2026-08-15 实施记录

- Core 已采用 Agent 原生 profile/mode/config，Schema 仅参与 Prompt，最终 Assistant 文本按原文交接；
- 新 Agent Step 的 workspace 策略缺省为 `native`，不再硬编码 `write_serialized`；显式旧策略继续兼容；
- 默认直接前置输出、续跑上下文重注入、主动暂停重启恢复、人工干预确认和派生 Run 证据重基已实现；
- Studio 已复用 Session Summary 与真实 Conversation 投影，支持节点保存/测试/继续/确认、派生确认节点、
  原子重命名/删除/断边、按 sequence 增量分页事件和共享 artifact renderer；
- dedicated Workflow MCP 已按 `2026-07-28` 与 legacy fallback 通过协议测试，并通过真实 Host gateway
  完成 source、publish、inspect、pause、continue、accept、review 与 derived run 调用；
- MCP source write 在 revision 比较、临时文件替换的完整临界区持有跨进程独占锁；并发使用同一旧
  revision 时只有一个写入者能进入 CAS，另一个得到可见冲突，不再静默覆盖；
- 首次节点测试已支持 `debugStepId`：只执行所选节点及递归祖先、排除下游与无关分支；真实 MCP
  验证 Run `e9513c23-cf2d-4e08-bfb1-e8397ed567e0` 为无父 `debug_node`，目标为
  `frontend-product-review`，两个非目标分支均为 `skipped`；
- Studio 与 MCP 的 source 测试现统一走 `workflow_debug`：草稿被物化为 catalog 不可见的负版本快照，
  不再调用 publish、Automation create/update/runNow 或调度器；应用层回归测试证明显式 publish 才将
  同一 row 提升为正版本；
- 真实 MCP `workflow_debug_source` 验证 Run `893b6809-896c-43aa-a93c-5c2204eda7e0`
  为 `debug_node`、隐藏版本 `-1`、Agent 调用数达到 1，调用前后 catalog 数量保持 `2 → 2`；
- 全仓审阅验收 source 位于 `~/.vibex/workflows/vibex-full-repository-review.vibex-workflow.json`，
  全部节点使用 Codex，首节点 Manual，后续节点 Automatic；完成 Run 为
  `773496d9-6430-4da8-af4f-117d585e1772`，最终事件序号 50；
- 独立 SDK 项目已迁移到 `~/Projects/vibe-workflow-creator`，build/test/MCP test/validate/pack 通过；
- 当前独立包为 `dist/vibex.workflow-creator-1.0.0.vxp`；连续两次打包的实际归档 SHA-256 均为
  `a7974ab9c0cb4dd4080953b480a41915d0fcc596715e5ae97950d2ceadde7cad`；
- VibeX 当前内置同 ID 插件已启用，Codex 与 Claude Code binding 已 applied；独立 `.vxp` 的 UI 替换导入
  需在 macOS 解锁后完成设置页操作。
- 最终代码门禁：`pnpm run check`、`pnpm run lint`、Workflow/Application Rust 全套通过；前端
  `270` 个测试文件、`1357` 个测试全部通过；独立与 bundled Plugin 的 build/test/MCP protocol test
  均通过。开发应用已以最新 Rust migration 与 MCP snapshot 启动。
