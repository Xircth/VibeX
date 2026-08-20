# VibeX 官方插件介绍

我对照的是 Host 0.1.3 发行物里随包带上的五份产品包。它们都是独立 git 子仓库，挂在 `assets/plugins/`：`office`、`session-enhance`、`multi-agent`、`workflow-creator`、`plugin-development`。检出 VibeX 时用 `git clone --recurse-submodules`，或之后 `git submodule update --init --recursive`。公共货架还没开，这里只讲已经装进 Host 的这几个。

它们的发布者都是 `vibex`。引擎要求 `vibex >=0.1.3 <1.0.0`，SDK 要求 `^1.0.0`。磁盘上有包，不等于已经注入 Agent。目录里标成「VibeX 内置」或「已随 Host 安装」，默认关掉。你只需要启用，不要再从货架装一遍。

详情页能关，不能当第三方快照卸掉。关掉以后，这一代对外投影按反序拆掉。已经开着的会话通常不会热拆 STDIO MCP，新开会话才干净。

五个包彼此独立。Office 不依赖会话增强，会话增强也不依赖多智能体。Workflow Creator 自己带编辑页和 MCP。插件开发包只管本机写插件这件事。

## VibeX Office

身份 `vibex.office`，当前版本 `3.0.0`，产品名 VibeX Office。一句话简介写的是在 VibeX 里创建、编辑、分析和预览 DOCX、XLSX 与 PPTX。源码是 git 子仓库 `assets/plugins/office`。

这是目前最完整的一份官方包。它同时带 Skill、Workflow、文件打开器、预览和一份锁死的 Runtime。

### 打开以后能做什么

在工作区点 `.docx`、`.xlsx`、`.pptx`，走 Office 预览。Composer 里会出现六条 Workflow。兼容 Agent 会看到三条 Skill，分别管 Word、Excel 和 PowerPoint。

六条 Workflow 的身份和界面标签如下。

- `create-document`，创建 DOCX
- `modify-document`，修改 DOCX
- `create-presentation`，创建 PPT
- `modify-presentation`，修改 PPT
- `analyze-spreadsheet`，分析 Excel
- `generate-spreadsheet`，生成 Excel

选中的是 Workflow 身份。对话里说要生成、修改或分析哪一类文件，也可以直接让 Agent 走对应 Skill。

### Skill 怎么约束 Agent

三条 Skill 都要求使用 Host 锁住的 `officecli`，禁止去用户 PATH 上另找一份。改完要校验，返回工作区相对路径。没点名的结构和样式应尽量留着。

`office-docx` 管文档结构。`office-xlsx` 先看工作簿再改，保留无关表和公式。`office-pptx` 只动点名的演示文稿，保留未指定页。

### 预览怎么跑

`file.opener` 认扩展名 `docx`、`xlsx`、`pptx`，以及对应的 Office Open XML 媒体类型，优先级 100。预览 provider 叫 `office-preview`。

预览进程走 Runtime `officecli`，参数是 `watch {artifact} --port {port}`，环境变量带 `OFFICECLI_SKIP_UPDATE=1`，就绪超时 15 秒，最多同时 4 个预览。Worker 协议 1.1，handler `office-preview` 只是把 `artifact.preview` 的 `open` 转给 Host。

配置页一项 `idleTimeoutMinutes`，1 到 60，默认 10。打开文件走只读预览。

空闲超时到了，预览进程会停。过一会儿再点文件，会重新拉起。

### Runtime

依赖写在 `depends/runtimes/officecli.json`。身份是可执行文件 `officecli`，版本锁在 `1.0.140`。探测命令 `--version`，超时 10 秒，版本串必须匹配 `officecli 1.0.140`。

发行物按平台拆开，darwin / linux / win32，各有 arm64 和 x64，带 sha256。启用时 Host 必须锁住并能探测通过，否则开关打不开。

关掉 Office，预览、Workflow 和三条 Skill 应一起从当前代消失。已经打开的预览按这一代收尾或到期。

## 会话增强

身份 `vibex.session-enhance`，版本 `1.0.0`，产品名「会话增强」。简介是在会话里向智能体提供提问、纠偏、会话查询和控制。源码是 git 子仓库 `assets/plugins/session-enhance`。

这个包没有 Worker，也没有文件页。它把 Host 自己的会话能力，通过官方 MCP 和一条 Skill 交给之后新开或重新绑定的 Agent 会话。

### 四个开关

配置默认全开。关掉哪一项，哪一项就不进工具清单。

- `feedback`，实时反馈。Agent 可以拉你中途写下的备注。
- `question`，向用户提问。Agent 可以暂停，抛出多选问题等你答。
- `sessionInfo`，获取会话信息。你用会话链接点名另一段对话时，Agent 可以只读查询。
- `sessionControl`，会话控制。可以向本会话或其子会话发送输入、取消回合或等待结束。

MCP 描述里的功能映射是 `feedback` 对 `feedback`，`question` 对 `ask`，`sessionInfo` 对 `sessions`，`sessionControl` 对 `session_control`。这些名字是 Host 家族二进制 `vibex-mcp` 的产品面，协议修订 `2026-07-28`。首次启用默认绑到所有兼容 Agent。

### Agent 实际会看到的工具

Skill `vibex-session-enhance` 写明了六种工具。

- `ask_user_question`，被你的选择挡住时才用，会等到你作答。
- `check_user_feedback`，动手前和每个阶段后拉一次中途纠偏。没有新备注就继续。
- `get_session_info`，只读查询你点名的另一段会话。
- `send_session_input`、`cancel_session_turn`、`wait_for_session`，只作用于本会话或其子孙。

这些工具由 VibeX 提供，不属于某个 Agent 自带的清单。禁用插件后，新会话不再注入整段会话 MCP。

旧会话可能还留着旧工具名，直到那次会话结束。要立刻干净，结束当前会话或重新绑定 Agent。

## 多智能体协同

身份 `vibex.multi-agent`，版本 `1.0.0`，产品名「多智能体协同」。简介是让父 Agent 把子任务委托给其它 Agent。源码是 git 子仓库 `assets/plugins/multi-agent`。

启用后两件事一起发生。输入框可以用 `&` 点名其它已安装 Agent。之后新开或重新绑定的会话会注入 `vibex-delegation-mcp`。

点名本身不会启动子任务。父模型调用 `delegate_to_agent` 才会拉起。Mention 里带稳定 Agent id，Skill 要求只用这个 id，不要拿显示名称再模糊匹配。

### 工具

- `delegate_to_agent` 立刻返回 `task_id`，子任务异步跑。
- `get_delegation_status` 查询或等待。
- `cancel_delegation` 取消。

每个子任务是独立的子会话。父会话退出会级联取消仍在跑的子任务。

MCP 同样走 Host 家族二进制 `vibex-mcp`，产品面是 `delegation`，协议修订 `2026-07-28`。首次启用默认绑到所有兼容 Agent。

### 配置

三项都只作用于委托拉起的新子会话，不会改你平时新开会话的默认值。

- `depthLimit`，委托链最大深度，1 到 8，默认 1。默认只允许父委托一层子，孙这一层到不了。
- `completedCacheMaxMb`，运行中父会话里已完成子结果的内存缓存，默认 512。写成 0 表示不限。会话结束后仍会清掉。
- `agentDefaults`，只覆盖委托子会话。空对象表示不额外改。

关掉插件，`&` 马上从输入框消失。已经注入的会话可能还看得见工具名，新的委托会被拒绝。插件开关就是委托开关。

深度默认是 1，是有意收紧。多层委托会把权限、工作目录和费用叠起来，需要你自己把上限调高。

## VibeX Workflow Creator

身份 `vibex.workflow-creator`，版本 `1.0.0`，产品名 VibeX Workflow Creator。简介写的是从对话和可编辑文件页里设计、检查、调试并安全改写 `*.vibex-workflow.json`。源码是 git 子仓库 `assets/plugins/workflow-creator`。

这个包同时带 Skill、独立 MCP、文件打开器和一个 App 编辑页。源文件仍是创作真相。保存走产物修订，外部改过会拒绝盲覆盖。发布才生成不可变版本。Automation 钉在某个已发布版本上，不会跟着草稿走。

### 你在界面上会碰到什么

打开 `*.vibex-workflow.json`，走 Workflow Studio。打开器按文件名后缀匹配，优先级 200，编辑面是 `workflow-studio`。App 协议 1.0，入口在 `dist/app`，原生渲染器名字是 `workflow.studio`，最小高度 560。

Worker 协议 1.1，负责 `surface.createSession` 这类 surface 会话。MCP 不走这个 Worker，走 Host 托管的 `vibex-workflow-mcp`。

编辑器本身在本机，不要求外网。Agent 步骤能不能上网，跟你选的 Agent 和项目策略走。MCP 流量停在 Host 与托管进程之间的随机回环端口。令牌由 Host 按应用生命周期注入，不会写进这个包，也不会进 `config.json`。

### 配置

只有一项 `defaultCompletionPolicy`。取值 `automatic` 或 `manual`，默认 `manual`。

`manual` 表示 Agent 步骤跑完以后，先停在确认投影上，你点过才往下游走。`automatic` 表示步骤结束后直接继续。Skill 也写了，只有你明确要求确认门时才用 `completionPolicy: manual`。

### Skill 要求 Agent 怎么做事

Skill `vibex-workflow-creator` 把创作收成一条固定顺序。

先找到或创建恰好一份 `*.vibex-workflow.json`，路径可以相对项目，也可以在 `~/.vibex/workflows/` 下面。先 `workflow_source_read`，记住修订号，再改。

节点按持久步骤建模，不要按「一个节点一个 Agent」来想。一个 Agent 步骤拥有一段子会话，重试和你继续说话，都是往同一段会话里加回合。

步骤 id 用稳定的 kebab-case。顺序只写在 `dependsOn` 里。禁止环，禁止引用不存在的步骤。数据流用 `inputBindings` 和 JSON Pointer。`outputSchema` 只是嵌进初始提示的示例，不会校验或挡住最终助手文本。下游拿到的是那段最终文本，哪怕它不是合法 JSON。

`executorProfileId`、`modeOverride`、`configOverrides` 从 Agent 自己的会话控件里选。不要发明 Workflow 专用权限模式。用户没点名隔离策略时，不要写调度元数据，Host 会补兼容默认值。

保存用 `workflow_source_write` 加上读到的修订号。冲突就再读、对一遍、再写。先保存并校验，再测试。源码测试走 `workflow_debug_source`，它用一份不公开的持久调试快照，既不发布版本，也不改 Automation 指向。

只有你明确说要发布时，才调用 `workflow_publish`。开一次正式 Run 只能针对已发布版本，并且带真实工作区 id。已经发布的版本要按步骤调试，用 `workflow_debug_from_step`。

暂停 DAG 用 `workflow_pause_run`，不会把这次 Run 标失败。干预单个节点先 `workflow_pause_step`，再 `workflow_continue_step`。被干预过的回合必须 `workflow_accept_candidate` 之后，下游才能继续。`needs_review` 的步骤用 `workflow_review_step` 选重试、接受或跳过。永久结束才用 `workflow_cancel_run`。日常停下来，优先暂停。

### MCP 工具清单

托管 MCP 当前声明了这些工具。

- `workflow_source_read` / `workflow_source_write`，按修订号读写源文件，源文件上限 4 MiB
- `workflow_validate`，校验并规范化，不发布
- `workflow_publish`，从合法源发布不可变版本
- `workflow_catalog`，列可复用定义和可选版本史
- `workflow_start`，从已发布版本开一次持久 Run
- `workflow_run_inspect`，看一次 Run、各步骤最近尝试和完整事件
- `workflow_debug_source`，用未发布快照测当前源
- `workflow_debug_from_step`，保留未改动的已完成祖先，只重跑一个节点或其下游
- `workflow_pause_run` / `workflow_resume_run` / `workflow_cancel_run`
- `workflow_pause_step` / `workflow_continue_step`
- `workflow_accept_candidate` / `workflow_review_step` / `workflow_decide_approval`

Desktop 必须在跑。Host 起回环命令网关，用托管 Node 拉起 MCP。界面或 MCP 报 VibeX 不可用时，先让 Desktop 开着，再重新启用这个插件。

保存冲突表示源文件在页外被改过。重新加载，对一遍，再存。Automation 仍钉在旧版本上，要它跟着走，必须发布新版本并明确改指向。

## 插件开发

身份 `vibex.plugin-development`，版本 `1.0.0`，产品名「插件开发」。简介是让 Agent 用当前 Host 自带的 SDK 和 CLI，在本机开发、校验并链接插件。源码是 git 子仓库 `assets/plugins/plugin-development`。

当前随 Host 带上的这份包声明了 Skill `vibex-plugin-development`（触发含 `/create-skill`、`/create-plugin`）和开发 MCP `vibex-plugin-dev-mcp`。Skill 目标是 `codex`、`claude-code`、`acp`。首次启用默认投影给已安装、支持 Skill 的 Agent。Skill 旁的 `references/` 写清单、模板、Node stdio 入口和链接步骤。

配置只有一项 `devMcp`，默认 `false`。关掉时官方运行时不会注入开发 MCP。打开后，之后新开或重新绑定的会话才会看到 `plugin_dev_link_request` 和 `plugin_dev_link_status`。链接仍要你在 Host 里确认 Full Trust。不要让模型向你要粘贴 token。

这份包自己不带 Worker。校验、测试、链接由 Host 家族里的 `vibex-plugin` CLI 完成。

Skill 要求 Agent 先定位本机契约：VibeX 源码树用 `locate_toolchain.py` 与 `node packages/plugin-cli/dist/cli.js`；否则用 `vibex-plugin toolchain` 或 Host 二进制旁边的 `vibex-plugin`。读 Skill 旁 `references/` 与 Host 自带 SDK 类型。

它让 Agent 做一个产品包。README 的 `summary`、`contents/`、根上的 `config.json`、以及声明过的 integrations。常用命令是 `init`、`validate`、`test`、`build`。链接必须你在 Host 里确认 Full Trust。公共 SDK 表达不了的能力，应先加 Host 目录，再写进包。

关掉这个插件，Skill 投影应从当前代收回。开发目录里的源码不会被删。你自己用 CLI 链上的包，卸的是 VibeX 这一侧的引用。

## 怎么一起用

常见组合很直接。

写文档、表或幻灯片，开 Office。要 Agent 中途问你、读你的备注或管子会话，开会话增强。要父 Agent 把活分给另一个 Agent，开多智能体。要画或改 DAG，开 Workflow Creator。要让 Agent 帮你写插件，开插件开发。

官方 MCP 只进启用之后的新会话或重新绑定的会话。先开插件，再开对话，少踩一次「工具清单还是旧的」这个坑。

Office 卡在 Runtime 没锁住或探测失败。预览停了，先看空闲超时是不是到了。多智能体看不到 `&`，先确认开关是开的，再确认对方 Agent 已经装上。Workflow 保存失败，先看修订号冲不冲突。会话工具没出现，结束当前对话再开一次。

这五个包覆盖的是文档、会话、委托、工作流创作和插件作者工具。页面布局、会话日志、Agent 连接和工作区隔离仍由 Host 自己负责。
