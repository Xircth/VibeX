---
status: accepted
date: 2026-08-17
decision-makers:
  - VibeX maintainers
---

# 会话增强与多智能体协同成为两个内置插件 MCP

> 「不能卸载的内置插件、随 Host 进入 catalog」已由
> [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md) 修订。
> 二者改为官网市场官方分类上的可安装包；产品拆分、MCP 身份、默认禁用、只影响新会话
> 仍然有效。

## Context

平台 `vibex-mcp` 把委派、实时反馈、向用户提问、会话查询和会话控制放在同一个按会话
注入的 companion 里，feature 在桌面启动时写死全开，没有产品配置页。CodeG 用同一
companion 加「设置 → 常规」里的两组开关（会话内工具、多智能体协同）达到可观察的
生产行为；VibeX 已有 Broker / 工具骨架，但配置面、反馈入队、结果缓存和子智能体
会话默认都未产品化。

ADR-0031 规定这些工具共用一个 companion、按独立 flag 暴露，且 `&` 必须按 Agent
是否协商到 `session/new.mcp_servers` 显示。ADR-0051 否决继续膨胀 `vibex-mcp`，并
写明协作以后迁成独立插件；同时要求按会话注入短期、最小 scope 凭据。ADR-0047
规定新安装插件默认禁用。Workflow Creator 已证明「内置插件 + 独立 MCP + 连
`vibex-server`」这条产品边界。

本决定把平台 companion 拆成两个 First-party 插件，并固定启用、投递、凭据、`&`
和旧 `vibex-mcp` 退场规则。

## Decision

### 1. 两个不能卸载的内置插件，默认禁用

| 产品 | Plugin ID | 显示名 | MCP ID |
|---|---|---|---|
| 会话增强 | `vibex.session-enhance` | 会话增强 | `vibex-session-mcp` |
| 多智能体协同 | `vibex.multi-agent` | 多智能体协同 | `vibex-delegation-mcp` |

二者随 VibeX 分发，`sourceKind=builtin`，可以停用，不能卸载。首次导入与 Office /
Workflow Creator 一样 **默认禁用**。用户打开插件后，该插件内部开关默认全开。

启用协同插件 = 启用委托。不再在「设置 → 常规」放委托或会话工具。深度、缓存、
子智能体配置只活在协同插件的 `config.json`。

### 2. 工具目录与对齐范围

会话增强（插件启用后可单独关）：

- `check_user_feedback`
- `ask_user_question`
- `get_session_info`
- `send_session_input` / `cancel_session_turn` / `wait_for_session`

协同（插件启停即总闸，无第三层「启用委托」）：

- `delegate_to_agent`
- `get_delegation_status`
- `cancel_delegation`

行为对齐 CodeG 的可观察契约：异步 `task_id`、批量 wait、深度 1–8、父会话级结果
缓存（默认 512 MiB，0 为不限、会话结束清除）、提问阻塞、反馈投递、会话只读查询、
注入时裁剪 `tools/list`。不移植 CodeG 的 `create_automation` / `create_work_task` /
`task_progress` / `task_complete`。自动化与 Workflow 继续走既有领域和
`vibex-workflow-mcp`。

`check_user_feedback` 必须是完整能力：Host Composer 在途条、写入队列、工具投递、
配置开关。不得默认打开一个永远返回空的工具。

### 3. 配置真相源与配置页

每个插件的根 `config.json` 是用户配置的唯一事实，schema 由该包自定，Host 校验并
原子写回。产品详情的配置 Tab 挂通用 `plugin.detail.panel` App surface，由插件自定义
布局；Host 不得按插件 ID 特判一套设置页。

协同插件配置页对齐 CodeG「多智能体协同」：

- **通用**：最大委托深度（1–8，默认 1）、已完成结果缓存 MB（默认 512，0 为不限）
- **子智能体配置**：列出当前已启用 Agent；现场探测 ACP session modes 与 select 型
  `config_options`；存一份仅委派使用的覆盖；只在 `delegate_to_agent` 拉起的新子
  会话上应用 `session/set_mode` / `session/set_config_option`。不是全局新会话默认。
  探测失败时该 Agent 为空状态，不回退成改全局配置。

会话增强配置页为四个布尔开关，默认全开。

### 4. 两个独立 MCP 服务，执行权威在 Host

插件只拥有 MCP 进程、tool catalog 和 `config.json`。调用进入既有 Application Core
（Delegation Broker、Conversation control、提问/反馈状态）。插件不得再实现一套
broker。

两个 MCP 互相独立，都作为客户端连接 `vibex-server`，不走桌面进程内 UDS companion
作为产品传输。实现上可以共享一个 crate，但必须是两个 MCP 身份、两份清单、两个
可独立启停的进程。

父会话身份由 Host 在 **按父会话启动该 MCP 进程** 时注入（`conversation_id`、
workspace）。模型不得靠自己填写 `conversation_id` 来选定父会话。Host Core 只允许
该进程操作被注入的 Conversation，即使凭据是长驻 token。

委派子会话若插件仍启用，使用同一套 binding 与投递规则；深度限制仍阻止超额嵌套。

### 5. 给 Agent 配置并启用，双适配器投递

打开插件 = 以 All-agents binding intent 绑到当前及以后所有已启用、能投递的
Agent，用户只做排除。插件设置与 Settings → MCP 编辑同一份 binding。

同一对 MCP 身份用两条适配器投递：

- 接受 ACP `session/new.mcp_servers` 的 Agent：Host 写入该会话 MCP 列表
- 读取原生 MCP 文件的 Agent：投影到该 Agent 的原生配置

这不是按 Agent 名字假装成功，而是同一启用事实的两种投递。Composer **不为** `&`
再做 Agent 种类或 MCP 能力校验。

### 6. 凭据：插件启用期间长驻，scope 按插件拆开

每个已启用插件一枚长驻 token，寿命与插件启用相同，停用即作废。协同 token 只有
`delegation.*`；会话增强 token 只有 `conversation.feedback|ask|read|control`。
不得发一枚万能 Host token。插件不把 Server URL 或 token 写入 `config.json`。

这修订 ADR-0051「按会话短期票」对这些产品插件的要求；Workspace 绑定与最小
scope 仍然成立。身份靠第 4 节的进程级会话上下文，不靠把 token 做成每会话一张。

### 7. `&` 与注入同一时刻生效

`&` 只在协同插件启用、且 **当前 Conversation 已在启用后完成一次 session
new/resume/rebind 投递** 时出现。打开插件不会给已在跑的会话热插 STDIO，也不强制
rebind。已开会话的输入框先不出现 `&`。

停用协同插件后 `&` 立即消失。已注入会话的 `tools/list` 可以旧到该会话结束；写
路径（新的 `delegate_to_agent`、会话控制、入队反馈）按 **当前** 启用与配置
fail-closed。深度 / 缓存 / 子智能体默认对之后新拉起的子会话生效。

Mention 仍只表示「请父 LLM 考虑委派」，序列化为 `[&Name](vibex://agent/<id>)`。
UI 不得因出现 Mention 就显示子任务已启动。

### 8. 平台 `vibex-mcp` 同一版本切干净

本决定落地后删除平台 companion 注入。未打开插件 = 没有对应工具，也没有 `&`。
旧会话保持到结束；新会话只走插件 MCP。不保留「没开插件就回退旧 vibex-mcp」的
双轨。升级后这些能力先消失，直到用户打开对应插件。

## Consequences

- ADR-0031 中「同一 companion + 按 Agent MCP 能力显示 `&`」被取代；委派公开行为、
  `&` 语法、one-shot 子任务、Broker 不变量仍然有效。
- ADR-0051 中「vibex-mcp 暂时保留」和「这些插件必须用每会话短期票」被取代；
  通用 Host 托管 MCP seam、All-agents binding、按会话启动 Runtime 仍然有效。
- 产品详情必须能挂 `plugin.detail.panel`，schema 表单不够表达协同配置。
- Host 必须能把 **N 个** 已启用插件 STDIO 投递进 `session/new`，并同时做原生文件
  投影；今天只能注入一个 `vibex-mcp`。
- Composer 读的是协同插件启用 + 本次会话是否已投递，不是 Agent 种类。
- 发行说明必须写明：升级后需在插件目录打开「会话增强」「多智能体协同」。

## Considered options

- **继续做平台内置 `vibex-mcp`，只补设置页。** 否决。与 ADR-0051 和「从设置迁到
  插件」的产品方向冲突。
- **可卸载插件。** 否决。`&`、提问和会话查询会被当成平台能力；卸载路径与投递
  失败缠在一起。
- **插件启用默认开。** 否决。与其它内置插件一致，默认禁用。
- **长驻一个 MCP、让模型传入 conversation_id。** 否决。会把委派和提问派到错误
  会话。
- **只投影原生文件或只写 session/new。** 否决。会让一半 Agent 看不到工具。
- **打开插件强制当前会话 rebind。** 否决。会打断在途 Turn。
- **移植 CodeG 的自动化 / 待办 / 任务汇报工具。** 否决。VibeX 已有独立领域。
