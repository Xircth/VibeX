---
status: accepted
date: 2026-08-15
decision-makers:
  - VibeX maintainers
---

# Agent Step 复用原生会话配置、按文本交接并投影确认节点

## Context

ADR-0045 与 ADR-0050 已确定 Agent Step 必须使用真实 Child Conversation 与 Turn，并支持
暂停、继续和完成确认。首轮实现仍有三个错误边界：

- Studio 用 Workflow 的 `workspaceAccess` 冒充 Agent 会话配置，无法表达 Codex 的模型、
  推理强度、权限模式等 Agent 原生选项；
- 输出 Schema 被当作运行时校验器，Agent 未返回合法 JSON 时 Step 失败或触发修复 Turn；
- `manual` 完成策略只表现为 Step 内部状态，无法在 DAG 上直接看到待确认位置。

这些设计提高了调试成本，也让 Workflow Step 与普通 VibeX 会话走了不同的启动路径。

## Decision

### 1. Agent Step 保存可移植的原生会话启动选择

`AgentStepSpec` 保存与普通会话首次提交相同的 `modeOverride`、`configOverrides` 与可选
`executorProfileId`。Studio 使用会话输入框已有的 `SessionSettingsSummary` 和相同 Agent
controls catalog；不得硬编码“串行写入”“完全访问”或任何 Agent 专有选项。

`workspaceAccess` 缺省为 `native`：它不另行降级或覆盖 Agent Session 的权限模式，也不为共享
Workspace 增加 Workflow 自造的串行租约。`read_only_shared`、`write_serialized` 与
`write_isolated` 只保留为旧 source 和显式高级编排选择；新节点的权限与工具范围完全来自所选
Agent 的原生 mode/config（例如 Codex 的“完全访问”）。

Workflow dispatcher 将这些值原样写入 `ConversationInputPayload`。后续用户输入在同一个
Child Conversation 中创建新 Turn，并继续使用该会话已经建立的 Agent 原生上下文。

### 2. Prompt 由四层稳定顺序组成

Agent Step 的首次用户消息由 Host 组合，但在 Conversation timeline 中仍作为一条可见的普通
用户消息保存：

1. 前置结果：若存在依赖节点，逐个列出稳定 Step ID 与其最后接受的原始文本；
2. 本轮任务：作者填写的 Prompt，允许在未保存草稿中为空，但保存/发布前必须非空；
3. 输出约定：若配置了输出 Schema 示例，要求只返回一个符合示例形状的 JSON 文本，不加
   Markdown 代码围栏或额外说明；
4. 输出语言：使用当前平台语言，例如 `zh-CN` 要求以中文完成自然语言内容，同时 JSON key
   保持示例约定。

Prompt 组合把前置结果标记为已经接受的上游最终输出，要求 Agent 查看其中的成果、证据与结论，
再继续当前任务。它不额外注入权限门禁或 Workflow 自造的安全策略。

### 3. Schema 是提示示例，不是运行时验证器

Workflow 不解析、不修复、不校验 Agent 的最终输出格式。Agent Turn 自然完成后，Host 读取
该 Child Conversation 当前 Turn 最后一个活动边界之后的 Assistant 最终文本，将其作为 Step 的候选/接受输出，并以
JSON string 持久化。下游收到的就是该原始文本；即使内容不是 JSON、缺字段或包含额外说明，
也不会因此失败。

“最终文本”不能把同一 Turn 中工具调用前的进度播报拼接进去。Host 以最后一次 reasoning、tool call
或 plan activity 为边界，只收集其后的 Assistant text delta；没有活动边界时，当前 Turn 的全部
Assistant text 即为最终回复。

`inputBindings` 仍决定显式数据依赖；默认情况下，每个直接前置 Agent Step 的原始输出都会进入
Prompt。Definition validator 只校验 DAG、ID、引用、尺寸和字段类型，不解释 Schema 示例内容。

本决定取代 ADR-0045 第 4、5 节以及 ADR-0050 第 3 条中关于结构化输出解析、Schema validation、
repair Turn 和 “只有校验成功才能进入下游” 的要求。

### 4. 节点先保存，后进入可执行状态

Studio 新增节点时先创建本地未保存草稿。只有节点配置通过最小完整性检查并点击“保存节点”后，
它才进入 Workflow source、可测试并可创建 Child Conversation。未保存节点的对话输入禁用。

保存后的节点即使尚未点击“测试”，也允许直接发送输入：Host 为它创建/复用 Debug run 与 Child
Conversation。点击“测试”只是启动同一操作并自动切到对话 Tab，不创建另一套预览执行器。

暂停后继续输入时，Conversation input 可能先持久化、再由 dispatcher 在数毫秒后绑定 Turn。Workflow
必须以该 input 最终记录的 `turnId` 为事实来源并完成绑定，不能因为提交接口的瞬时返回值为空而报错；
这避免用户重试后产生重复 Turn。

### 5. 人工干预后必须显式确认完成

无人干预时，Automatic Step 的 Turn 自然完成即接受最后回复并调度下游。用户或 Controller Agent
一旦在节点对话中暂停 Turn、发送追加输入或 Steering，该 Step 进入 `awaiting_acceptance`；后续
Turn 自然结束也不自动放行。对话页显示“确认完成”，接受当前最后回复后才调度下游。

Manual Step 从定义上始终进入 `awaiting_acceptance`。Human 与 Controller Agent 调用同一个
幂等 `accept_candidate` 用例；Worker Agent 不隐式自我确认。

### 6. 确认节点是派生投影，不是 Workflow Step

对每个 `completionPolicy = manual` 的 Agent Step，Studio 在其右侧投影一个确认节点，并用边连接。
确认节点没有独立 Step ID、Conversation、依赖、输入输出或 Definition 记录；它的稳定视图身份为
`confirmation:<agentStepId>`。

- Agent Step 等待确认时，确认节点以状态动效提示“需要确认结果”；
- 点击确认节点打开对应 Agent Step 的对话 Tab；
- 用户在 Agent Step 对话中点击“确认完成”后，确认投影立即变为已放行；
- 依赖关系跨过确认投影：`A → 确认(A) → B` 在 Definition 中仍然只是 `B.dependsOn = [A]`；
- Automatic Step 不生成确认投影。

独立 Approval Step 继续用于拥有业务决策 payload 的审批，不与此完成确认投影合并。

### 7. MCP 与 Studio 使用同一 Application Core

Workflow MCP 必须覆盖 source read/write、validate/publish/catalog、run start/inspect、节点测试、
节点继续/暂停、候选确认、Run 暂停/恢复/终止与 derived rerun。Studio 和 MCP 不得拥有不同的
Prompt 组合、输出提取、节点保存或确认规则。

同一个 `sourcePath` 是可复用 Definition 的稳定身份；调用者不传 `definitionId` 时，后续 publish
仍追加到该 Definition 的版本历史。MCP 还必须提供 `workflow_review_step`，以 retry/accept/skip
处理 crash recovery 后明确处于 `needs_review` 的节点。

MCP 创建的 Definition 在 Studio 中必须完整可编辑；Studio 创建的 Definition 也必须能由 MCP
读取、发布、运行和调试。测试以同一份至少三节点、全部 Codex、首节点需要确认的全仓代码审阅
Workflow 作为互操作验收夹具。

### 8. 续跑 Turn 必须可自包含恢复节点上下文

Agent Runtime 不一定支持原生 session resume；即使 Child Conversation 身份不变，暂停后的下一次
Turn 也可能落到一个新建的 Agent session。因而 Workflow 不能假定上一条 Prompt 仍在模型上下文中。

每次 `workflow_step_input` 都以 StepRun 持久化的 `resolvedInput` 重新渲染前置结果、本轮任务、输出
示例和语言约定，再附加用户本次 guidance。Conversation timeline 仍把它保存为真实用户消息。这样，
支持原生恢复的 Agent 得到明确上下文，不支持恢复的 Agent 也不会只收到孤立的“继续”指令。

Conversation input 的 `turnId` 仍以 dispatcher 最终写入的持久化记录为准；MCP、Studio 和 Run resume
都走同一个提交与绑定路径。

### 9. 主动暂停与派生复用在重启后保持其原语义

主动暂停的 Step 保持 `status = running + awaitingInput = true`，Run 保持 `controlState = paused`；
Host 重启的 interrupted reconciliation 必须排除这类 Step，不能把用户明确的暂停升级成
`needs_review`。Run 恢复先提交持久的 Run active 状态，再为等待输入的 Child Conversation 创建新 Turn，
避免 Agent 启动失败把 Run 永久留在 paused。

Derived Run 只复用定义完全未变且已有 accepted output 的祖先节点。复用时将 execution evidence 的
`definitionDigest` 重基到派生 Run 的当前不可变版本，并保留 `reusedFromDefinitionDigest` 作为来源
证据；否则一次正常重启会把合法复用误判为 evidence mismatch。

默认输入先按稳定 Step ID 注入全部直接依赖的原始 accepted output，再应用显式 `inputBindings`；
显式同名 binding 覆盖默认值。完整结果参与 `resolvedInputDigest`。

### 10. 首次节点测试与派生重测使用相同的执行边界

没有父 Run 时，节点测试创建 `runMode = debug_node` 的 durable Run：递归执行所选 Agent Step 的全部
前置节点，执行所选节点本身，并把无关分支与传递下游标记为 `exclude/skipped`。这样目标节点能获得真实
前置产物，同时测试不会越过目标节点产生下游副作用。Run 以 `forkStepId` 记录目标节点，即使
`parentRunId` 为空也可被 Studio 与 MCP 一致识别。

节点测试先将已保存 source 规范化为 `publicationKind = debug` 的隐藏负版本快照；该快照可被 Run 审计，
但不会出现在 Definition catalog/version history，也不会更新 Automation 的版本引用。只有用户显式发布时，
完全相同的隐藏快照才原地提升为下一个正版本，避免复制 Definition row。

已有父 Run 时继续使用 derived node-scope Run：定义未变且证据匹配的祖先被复用，只重新执行目标节点，
其余节点排除。首次测试与后续重测因此只有“执行祖先”与“复用祖先”的差别，不再出现首次整图运行、
后续单节点运行的语义分裂。Studio 与 MCP 都通过 `workflow_debug` Application command 进入该语义；
MCP 对外工具名为 `workflow_debug_source`。`workflow_start.debugStepId` 仅保留给已发布版本的兼容调用。

## Consequences

- Agent Step 的权限、模型与推理配置来自 Agent 自身能力，Workflow 不再维护错误的平行枚举；
- 原始文本交接牺牲了机器可验证的结构化保证，但符合交互式 Agent 工作流的实际容错目标；
- `allowOneRepair` 成为旧 source 的兼容输入，新 Studio 不再展示或写入，dispatcher 不再执行修复；
- confirmation node 只在共享 Studio graph projection 中生成，Plugin editor 与原生 Studio 行为一致；
- Plugin file opener 通过公共 SDK 声明 `nativeRenderer: workflow.studio`，Host 使用共享 Studio adapter；
  插件 App 仅保留旧 Host 的升级提示，不实现第二套 DAG 编辑器；
- 用户干预具有可见、持久、可审计的“需要确认”后果，不会意外启动下游。

## Acceptance criteria

1. Studio 对 Codex 显示与普通会话一致的原生 Session summary，包括可用的权限模式。
2. dispatcher 将 mode/config/profile 选择写入首个 `ConversationInputPayload`。
3. 空默认 Prompt 不再出现示例文案；新 Agent Step 默认包含一个输出 Schema 示例。
4. 前置原始输出、任务、输出示例和平台语言按稳定顺序出现在首次用户消息中。
5. Agent 返回非 JSON 文本时 Step 仍可完成并把原文传给下一节点。
6. 未保存节点不能测试或输入；保存后测试和直接输入都能创建真实 Child Conversation。
7. 用户干预后，Turn 完成不会自动进入下一节点，直到显式“确认完成”。
8. Manual Agent Step 在 DAG 上显示确认节点；确认节点不出现在 Definition `steps` 或依赖列表。
9. 点击确认节点打开所属 Agent Step 对话；从对话确认后下游被调度且确认投影显示已放行。
10. MCP 与 Studio 对同一 source、Run、Conversation 与确认状态产生一致结果。
11. 首次测试 B 只执行 B 及其递归祖先；B 的下游和无关分支不创建 Agent Turn。
12. 节点测试不会创建可见版本、更新 Automation 或触发 Automation schedule；显式发布才改变 catalog。
13. 新 Agent Step 的 `workspaceAccess` 为 `native`，其权限摘要与首轮启动 payload 均来自 Agent controls。
