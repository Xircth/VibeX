---
status: accepted
date: 2026-08-05
decision-makers:
  - VibeX maintainers
---

# Built-in Agent 提供白名单账号动作与 Codeg 档案对齐

本次最终对照基线固定为 Codeg commit
`fa230248d285c3f4fa541a737fc93f209820512e`；后续上游变化需要重新审计，不能在未验证
原生配置格式、CLI 参数位置和账号动作的情况下自动继承。

VibeX 的默认 Agent 档案与 Codeg 当前默认集合对齐：Claude Code、Codex、Gemini、
OpenClaw、OpenCode、Cline、Hermes、CodeBuddy、Kimi Code、Pi、Grok 与 Cursor。
每个档案可以声明版本锁定的 Binary、npx 或 uvx 分发、ACP 启动入口、依赖环境、原生
配置文件以及官方账号和订阅管理动作。所有 Agent 继续使用同一安装、探测和会话管线。

本 ADR 取代 ADR-0012、ADR-0021 与 ADR-0035 中“认证只能只读显示、VibeX 不得启动
登录或注销”的限制，但保留安装和认证相互独立、后台不得自动触发交互式认证的原则。

用户在“设置 → Agent”明确点击后，VibeX 可以执行两类档案动作：

1. 在可见终端中启动档案编译时固定声明的官方 CLI 程序与参数；
2. 使用系统浏览器打开档案编译时固定声明的官方订阅或账号 URL。

动作请求只携带 `agent_id` 与 `action_id`。后端必须重新从 Built-in Agent Profile
解析完整程序、参数与 URL，并从当前安装锁、托管组件同目录或刷新后的 PATH 解析
官方可执行文件。用户声明 Agent、Registry 元数据、配置文件和前端均不能提供或覆盖
程序、参数、URL、shell 片段或工作目录。未知动作 fail-closed。

除 Codex 外，CLI 的设备码、OAuth、浏览器回调、账号切换与注销确认由官方 Agent
持有；VibeX 不截获标准输入、不读取终端输出，也不把交互内容写入数据库或诊断记录。
Codex 采用 OpenAI 官方 device-auth 端点提供设置页内设备码登录：前端只接收短期设备
码、验证 URL、轮询间隔与状态，access、id 与 refresh token 只在 Rust 后端交换并直接
写入 Codex 官方 `auth.json`，不得穿过 IPC、日志或数据库。订阅购买、升级、降级与
取消仍在官方页面完成。

Kimi Code 的 ACP API 模式是一个上游特例：Runtime 在使用用户自定义 Provider 时仍要求
官方凭据文件存在。为与上述固定 Codeg 基线保持一致，VibeX 仅在 API 模式且不存在真实
凭据时写入固定的本地门禁标记；该标记不是访问令牌、不会传给模型端点、不会覆盖真实
Kimi 凭据，切回订阅登录时也只删除由 VibeX 写入且值完全匹配的标记。真实 OAuth Token
仍只由 Kimi 官方 CLI 管理。

OpenCode 的 Provider 连接是已适配原生配置，不是任意文件写入。VibeX 可结构化读写
OpenCode 官方 `auth.json` 与 `opencode.json` 中指定 Provider 的凭据、SDK 包、API URL
、API 适配器和模型映射，并通过 `enabled_providers` / `disabled_providers` 切换可用状态；
模型以 ID/显示名逐项编辑，重命名时携带原 ID 以保留 context window 等未知扩展字段；
编辑已有 Provider 时可不重新提交密钥，后端保留原凭据且绝不把它返回前端。
保存时保留文档中其它键，界面不回显 API Key，断开操作移除目标 Provider 的凭据、
配置和启停残留。Provider 目录优先读取 `models.dev/api.json`，使用 24 小时缓存并
在网络或缓存不可用时回退到随应用发布的完整快照。OpenCode 插件管理只允许安装
`opencode.json` 已声明的包，使用 OpenCode 自带 Bun 或 PATH 中的 Bun，在官方缓存目录
校验安装版本；卸载同步移除声明和缓存包，`@opencode-ai/*` 保留包不可移除。

原生配置文件预览对敏感文件实行后端脱敏：IPC 只返回路径、格式、存在性与敏感标记，
`content` 必须为空；前端不得以模糊、悬停或聚焦揭示的方式接收或暂存完整凭据文件。

Grok 与 Cursor 的订阅/密钥模式保存在 Agent 设置环境中。启动时必须应用模式策略：
订阅模式显式清除继承进程中的冲突 API Key；密钥模式在预检查中验证凭据存在；Cursor
不支持的自定义 Base URL 无论来源都不得传给子进程。凭据不回显。

预检查除 Runtime 与 ACP 外，还按档案逐项检查 Node.js、npm、uv、Python 等运行依赖，
展示要求、观测版本和解析路径；Grok/Cursor 显示鉴权模式与凭据就绪状态，OpenCode
显示声明插件的安装、缺失与浮动版本状态。缺少必需依赖会进入需要修复；缺少所选模式
凭据会进入需要认证；可选工具只显示提醒。Hermes 优先使用 PATH 中的 `uv`；没有系统
`uv` 时，VibeX 从 Astral 官方发布页下载与 Codeg 对齐的固定版本，按六个平台固定的
SHA-256 校验并安全解压到应用数据目录。预检查和环境诊断必须识别、显示该托管路径。
随后由 `uv` 在 Agent 私有目录自动下载并固定 Python 3.13；机器上的系统 Python 只作为
可选观测项，缺失或版本不同不得阻止安装。

每个 Agent 都提供独立的附加环境变量编辑器，用于覆盖档案未结构化暴露的高级 CLI
配置。变量名、单值、条目数和总大小均在后端校验；凭据类变量只返回存在性和掩码，
空值更新保留已保存凭据。读写使用环境文档修订号与数据库 compare-and-set，不能覆盖
并发编辑；保存后向存活会话发送 config-stale 事件。安装、修复、预检查与账号动作产生
的结构化诊断在 Agent 详情中可见，原始输出在后端脱敏并受长度限制，界面最多展示最近
20 条并继续支持完整诊断导出。独立的只读环境诊断会对照 GUI 应用进程与登录 Shell 的
PATH，逐项探测当前档案依赖和实际 ACP 启动入口，并生成仅含安全白名单环境项的可复制
报告；它不得遍历或输出任意环境变量。

安装、更新与修复还会通过同一有序操作事件流显示最近 200 行安装日志；npm/uv 子进程的
stdout 与 stderr 按行读取、先做 UTF-8 安全截断和凭据脱敏再穿过 IPC，单次进程输出捕获
也有上限。日志事件不改变已有进度值，操作取消会终止子进程，失败输出继续写入有界诊断。
内置的非 uvx Agent 可以明确请求一个具体点分版本；输入只接受可安全拼接的
`[0-9A-Za-z.+-]` 版本并拒绝 dist-tag、空格和路径字符。只替换 Runtime/Combined Runtime，
ACP Adapter 仍使用档案固定版本；npm 包重新验证 Registry integrity，二进制 URL 只能替换
档案中已固定的版本片段并对这次明确请求使用 TOFU。uvx、自定义 Agent 与 Registry Agent
不接受该入口。

原生配置字段对齐 Codeg 的结构化设置，包括 Claude 模型别名、推理与流量开关，Codex
Skills、WebSocket 与 workspace-write 沙箱细项，Kimi Provider 环境/推理能力，Pi
`models.json` 自定义 Provider，Grok 正确的 `[ui]` / `[models]` / `[model]` / `[session]`
字段，以及完整 Hermes Provider 列表与对应凭据变量。Hermes 界面只显示当前 Provider
相关的密钥与端点。Cursor 模型和 Run Everything、Grok 权限模式、OpenClaw Gateway
与 Session 配置在保存后同步到 Agent 启动设置，并转换为各 CLI 所要求的根级或子命令
参数；静态安装锁本身不被改写。
所有结构化字段的后端说明必须在界面可见并通过 `aria-describedby` 关联到控件；英文界面
使用稳定英文说明，不能直接显示后端中文文案。

Codex 的审批策略同时支持简单策略与 granular 五项开关；两种原生形态必须互斥，切换
时不能在 `config.toml` 留下冲突值。Codex 模型目录优先读取 Runtime 的 bundled catalog，
并缓存最后一次有效结果；用户可基于完整官方模型条目建立自定义模型、排除官方模型并
选择默认模型；自定义条目还可稀疏覆盖推理强度、摘要、详细度、Shell、Apply Patch、
并行工具、搜索、描述与基础指令，未覆盖字段继续继承完整官方模板。VibeX 生成的 catalog
与 source sidecar 只由该功能管理，关闭自定义能力时只删除自身生成的文件。Cursor 模型
列表来自官方 `cursor-agent models`，Kimi 模型列表
来自用户当前草稿端点的 OpenAI-compatible `/models`；Kimi API Key 只用于该次后端请求，
不进入响应或模型缓存。Pi 提供独立的结构化配置面板：内置 Provider 列表与 Codeg 对齐，
任意动态 Provider 凭据写入 `auth.json`，自定义端点和 wire protocol 写入 `models.json`，
选中模型会增量加入该 Provider 的模型数组；三份原生文件中的其它键和其它 Provider 均保留。
高级 JSON builder 仍可用于修复或批量维护已有自定义 Provider。

当 Codex 的 source sidecar 尚不存在但 `config.toml` 已引用外部 `model_catalog_json` 时，
VibeX 必须按 Codex 的路径规则解析绝对路径、`~/` 与 `CODEX_HOME` 相对路径，在 8 MiB
上限内只读导入该目录，并与当前官方目录对比还原自定义模型、排除项与默认模型。打开编辑器
不得写入或改名外部文件；用户保存后才由 VibeX 生成自己的 catalog 与 sidecar。

Pi Runtime 可在 PATH 中的托管 `pi` 与用户指定的可执行文件之间切换；自定义文件必须解析到
真实可执行文件并通过启动前验证。`PI_CODING_AGENT_DIR` 与
`PI_CODING_AGENT_SESSION_DIR` 可随该 Runtime 保存，同时保留 Agent 设置中的其它环境变量。
工作区信任默认开启：启动 Pi 前只把当前规范化工作目录增量加入目标 `trust.json`，已有的
`false`、`null` 或其它路径不改变，同一路径重复启动不重复写入，无法解析的现有文件绝不覆盖；
`PI_ACP_TRUST_WORKSPACE=0` 可关闭该行为，且此 VibeX 策略变量不会传给子进程。
外部安装探测可临时使用这些 Pi Runtime 设置完成握手，但持久化安装锁不得冻结它们；启动
时当前设置必须覆盖旧锁，用户清空字段时也必须清除旧锁或父进程继承的同名变量。

Claude Code、Codex 与 Gemini 支持 VibeX 本地 Model Provider 预设。预设保存名称、Agent
类型、端点、模型映射和凭据，绑定时分别投影到三个 Agent 的官方原生配置；Claude 支持
八项结构化模型映射，Codex 使用正式 `model_provider` / `model_providers` 配置并复用上述
完整模型清单，Gemini 使用单模型映射。更新已绑定预设会重新投影。首次绑定前由 VibeX
保存其负责字段与 sidecar 的精确备份；切换 Provider 保留同一备份，解除绑定时恢复原值，
同时保留期间出现的其它原生配置字段。预设不是 Runtime 配置权威，未绑定时不产生运行
效果。IPC 不回显 API Key，空密钥更新保留已有凭据，包含凭据及备份的预设文件在 Unix
上以 `0600` 原子写入；仍被 Agent 绑定的预设不能删除。任何原生配置、Codex catalog 或
Provider 投影变化都会向该 Agent 的存活会话发送 config-stale 事件，明确提示重启后生效；
Grok/Cursor 鉴权模式以及 OpenCode Provider、启停状态与插件变化同样适用。

十二个 Built-in Agent 均声明默认历史源。OpenCode 与 Hermes 读取官方 SQLite 存储，
并把 reasoning、正文和 tool part 保留为独立消息；Kimi Code 与 Grok 解析各自事件流，
保留工具调用 ID、名称、状态、原始输入输出和可用的模型/Token/费用元数据；Cursor 读取
会话元数据并对私有二进制 blob 做保守文本恢复；其它 Agent 读取其官方 JSON/JSONL
目录。导入投影使用结构化 reasoning 与 tool event，而不是把全部内容压平成回答文本。
历史导入始终只读，不修改外部文件。

全局 MCP 管理与 Codeg 的原生存储适配保持一致：Claude Code、Codex、Gemini、OpenCode、
Cline、Hermes、CodeBuddy、Kimi Code、Grok 与 Cursor 是可分配目标；OpenClaw 因拒绝
ACP `mcpServers` 条目而不新增分配，Pi 因 `pi-acp` 不转发且 Pi 没有原生 MCP 配置而不
作为目标。每个适配器保留其它配置，按目标集合做精确增删，Codex 明确拒绝 SSE。
市场同时支持官方 Registry 与 Smithery，并把远端、npm/npx、uvx 参数表单解析为统一
stdio、HTTP 或 SSE 规范；包含密钥的输入不写入日志。已有的隐藏/退役目标在编辑时保留，
不能因 UI 不再展示而静默删除。

十二个 Built-in Agent 均提供与其原生目录语义一致的 Skills 管理，支持全局/项目读取、
编辑、删除、skills.sh 安装和全局托管；Hermes 仅有全局作用域。共享的物理 Skills 目录
按规范化目标路径合并后再写入，任一选中 Agent 需要该路径时，未选中的另一适配器不得
反向删除同一文件。用户定义 Agent 必须显式声明使用共享 `~/.agents/skills`、一个绝对
专属目录或二者；声明被持久化、投影到能力 UI，并由所有 Skills IPC 统一解析。未声明、
相对路径或数据库中的异常路径均 fail-closed，不能借 Agent ID 构造任意文件系统目标。
路径解析严格遵循各 CLI 的目录语义：`GEMINI_CLI_HOME` 是父目录，历史位于其
`.gemini/tmp` 与 `.gemini/history` 下的 `chats/session-*`；`CLINE_DIR` 和
`CODEBUDDY_CONFIG_DIR` 则直接指向各自数据/配置根。Claude Code、OpenClaw 与 CodeBuddy
的 reasoning、tool call 和 tool result block 必须拆成独立结构化事件并保留调用关联信息。
设置中保存的 Agent Home/Session 目录优先于进程默认值。会话创建页会把本地历史与 Agent
通过 ACP 返回的远端会话合并展示；即使 Agent 不支持 `session/list`，仍可选择并导入本地
历史。远端会话执行连接，本地历史则通过正式 conversation event 管线写入可渲染、可搜索
的已完成会话，界面不展示来源文件路径。

除 Pi 专属 Runtime 面板中经过解析与可执行性验证的本地程序外，该设计不授权任意命令
执行。若未来需要用户自定义账号动作、远程脚本或动态 URL，必须另行建立签名、权限、
审计和参数化执行模型，不能扩展当前动作 DTO 绕过白名单。
