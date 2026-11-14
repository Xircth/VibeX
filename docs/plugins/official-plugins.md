# VibeX 官方插件全景介绍

在 [ADR-0069（一切皆插件）](../adr/0069-everything-is-a-plugin-platform.md) 纪律下，VibeX 的 **17 个官方插件**源码全部位于仓库 [`plugins/`](../../plugins/) 目录，与第三方作者共用完全相同的公开 `@vibex/plugin-sdk`（`^2.0.0`）、Package v4 清单和 **23 类贡献点**（CI 通过 `pnpm run plugin:no-privilege` 强制校验宿主零官方 ID 特判）。

### 分发与生效规则

- **市场官方分类与源码登记**：仓库根 [`vibex-plugin.json`](../../vibex-plugin.json) 登记了通过 [官方插件市场](https://vibex.xforever.xin/marketplace/) 与独立 GitHub Release 分发的核心官方包；Host 优先从市场拉取，离线或市场无制品时回退至快照/仓库地址，也支持直接导入 `.vxp` 或 `vibex plugin add --dev` 链接本地源码目录。
- **能力等价插件（Capability-Parity）**：从原内置功能迁出的等价官方插件（如浏览器、代码补全、提示词增强、看板视图、笔记等）按 Host 版本白名单自动就绪，用户仍可随时禁用或卸载。
- **生效双轨（Dual Activation）**：UI 面板、主题、右键菜单与 Provider 接缝**启用即刻生效、禁用原子撤下**；向 Agent 注入的 **Skill、MCP 与 Hook 仅对启用后新建或重新绑定的会话生效**（不热拆已在运行中的 STDIO 会话）。
- **单层独立**：各插件彼此完全独立，不存在插件依赖插件；关闭任一插件只会按反序回收其当前激活代（Activation Generation）。

---

## 一、核心旗舰插件详解

### 1. 内置浏览器（`vibex.browser`）

- **源码**：[`plugins/browser`](../../plugins/browser) ｜ **简介**：带持久化 Cookie、页面元素移交（DOM Handoff）与可选 Agent 自动化工具的工作台内置浏览器。
- **能力亮点**：
  - 在 Dockview / 空间画布内直接打开持久化登录态网页或本地开发预览；
  - 支持直接点选页面 DOM 元素，将组件层级、选择器、Computed CSS 与局部截图一键注入会话输入框；
  - 可按需向新开 Agent 会话暴露受控页面检查与交互工具。

### 2. VibeX Office（`vibex.office`）

- **源码**：[`plugins/office`](../../plugins/office) ｜ **简介**：在 VibeX 中创建、编辑、分析和实时预览 `DOCX`、`XLSX` 与 `PPTX` 文件。
- **能力亮点**：
  - **只读实时预览**：`file.opener` 接管 `.docx` / `.xlsx` / `.pptx`，通过锁定的 `officecli`（`1.0.140`，全平台 SHA-256 校验与 `--version` 探测）拉起最多 4 路并发预览租约（默认空闲超时 `idleTimeoutMinutes = 10`）；
  - **3 条专业 Skill + 6 条 Composer Workflow**：涵盖 `create-document`、`modify-document`、`create-presentation`、`modify-presentation`、`analyze-spreadsheet`、`generate-spreadsheet`，强制 Agent 调用受锁定的 `officecli` 原地增量编辑并保留未点名的公式与版式。

### 3. 电脑控制（`vibex-plugin-computer-use`）

- **源码**：[`plugins/computer-use`](../../plugins/computer-use) ｜ **简介**：桌面窗口与应用的感知和自动化控制：无障碍树、截图、键鼠输入、窗口级授权与全局紧急停止。
- **能力亮点**：
  - 按**单窗口、单应用或全屏**粒度授权，明确区分「仅查看」与「允许控制」；
  - 启用后向新会话注入 Computer-Use MCP 与 Skill；屏幕边缘提供状态呼吸指示条，**全局紧急停止（Kill Switch）**可瞬间撤销全部授权并中断执行动作。

### 4. VibeX Workflow Creator（`vibex.workflow-creator`）

- **源码**：[`plugins/workflow-creator`](../../plugins/workflow-creator) ｜ **简介**：从 Agent 对话与可视化编辑页中设计、检查、调试并安全改写 `*.vibex-workflow.json` DAG 工作流。
- **能力亮点**：
  - 打开 `*.vibex-workflow.json` 自动进入 **Workflow Studio** 可视化编排器；保存基于修订号防盲覆盖，显式 `publish` 才生成不可变定义版本（供 Automation 精确钉住）；
  - 通过宿主托管的 `vibex-workflow-mcp` 向 Agent 提供 `workflow_source_read/write`、`workflow_validate`、`workflow_publish`、`workflow_debug_source`、`workflow_debug_from_step`、`workflow_pause_run/resume_run`、`workflow_accept_candidate` 等完整编排与断点调试工具。

### 5. 会话增强（`vibex.session-enhance`）

- **源码**：[`plugins/session-enhance`](../../plugins/session-enhance) ｜ **简介**：在会话中向智能体提供结构化提问、实时中途纠偏、跨会话只读查询与子会话控制。
- **四个独立功能开关**（映射 `vibex-mcp` 对应特性，默认全开）：
  - `question` → `ask_user_question`（Agent 遇到关键分歧时弹出多选卡片等待决策）；
  - `feedback` → `check_user_feedback`（Agent 阶段性拉取用户的实时备注纠偏）；
  - `sessionInfo` → `get_session_info`（解析 `@会话` 引用，只读读取关联对话上下文）；
  - `sessionControl` → `send_session_input` / `cancel_session_turn` / `wait_for_session`（在当前会话及其子孙范围内编排输入与等待）。

### 6. AI 代码补全（`vibex.code-completion`）

- **源码**：[`plugins/code-completion`](../../plugins/code-completion) ｜ **简介**：编辑器内联 Ghost Text / FIM 补全，支持 OpenAI 兼容与 Anthropic 兼容双协议、智能上下文拼装、自适应防抖与一键原子级撤销。

### 7. AI 语音输入（`vibex.voice-input`）

- **源码**：[`plugins/voice-input`](../../plugins/voice-input) ｜ **简介**：Composer 实时流式语音听写，支持 Whisper / Groq / 多模态音频识别、自定义技术术语热词表与听写后智能去口水词润色。

### 8. Remote SSH（`vibex.remote-ssh`）

- **源码**：[`plugins/remote-ssh`](../../plugins/remote-ssh) ｜ **简介**：通过系统 SSH（密钥 / `ssh-agent` / 可选密码，绝不拷贝私钥）自动探测远端架构、投递并拉起 `vibex-server`、建立隧道并完成一键配对（注册 `provider.remote.provisioner`，见 [ADR-0070](../adr/0070-ssh-provisioned-remote-server.md)）。

### 9. Open Connector（`vibex.open-connector`）

- **源码**：[`plugins/open-connector`](../../plugins/open-connector) ｜ **简介**：在工作台内嵌本机第三方应用连接器控制台，通过锁定校验的本地网关二进制向新会话注入 `list_apps`、`list_connections`、`search_actions`、`get_action_guide`、`execute_action` 五项 HTTP MCP 工具（凭据独立存于 `plugin-state/vibex.open-connector/`）。

### 10. 科学研究（`vibex.science`）

- **源码**：[`plugins/science`](../../plugins/science) ｜ **简介**：精选并经过许可证审计的 **146 项科研技能**（源自 `K-Dense-AI/scientific-agent-skills`），按 10 个学科领域分组开关（`general` 通用科研 13 项默认开启，其余 `literature`、`writing`、`stats`、`infra`、`singlecell`、`genomics`、`chemistry`、`medicine`、`physics` 按需勾选投影）。

### 11. 插件开发（`vibex.plugin-development`）

- **源码**：[`plugins/plugin-development`](../../plugins/plugin-development) ｜ **简介**：向 Codex、Claude Code 及通用 ACP Agent 投影 `vibex-plugin-development` Skill（支持 `/create-plugin`、`/create-skill`），指导 Agent 直接调用本机 `vibex-plugin` CLI 与 SDK 完成初始化、校验、测试、构建与 `--dev` 热更新链接。

---

## 二、更多官方工作台与体验扩展（`plugins/*`）

| 插件 ID | 源码目录 | 核心作用 |
| --- | --- | --- |
| `vibex.provider-switch` | [`plugins/provider-switch`](../../plugins/provider-switch) | 在「新建模型供应商」表单中贡献按 Agent 分组的无密钥预置端点与模型映射模板（[ADR-0079](../adr/0079-provider-catalog-templates-are-not-import-sources.md)）。 |
| `vibex.prompt-enhancer` | [`plugins/prompt-enhancer`](../../plugins/prompt-enhancer) | Composer 提示词优化器（含 `@enhance` 动作），自动结合仓库上下文补齐验收标准与边界条件。 |
| `vibex.kanban-views` | [`plugins/kanban-views`](../../plugins/kanban-views) | 任务看板多维分组视图、分诊预设与迭代速率统计扩展。 |
| `vibex.notes` | [`plugins/notes`](../../plugins/notes) | 项目随手记（Scratchpad）、会话笔记面板与消息右键一键摘录。 |
| `vibex.tauri-ui-debugger` | [`plugins/tauri-ui-debugger`](../../plugins/tauri-ui-debugger) | 开发模式下悬浮点选 VibeX 自身界面元素，将源码行列、React 组件链与关键样式作为结构化 token 插入输入框。 |
| `vibex.ayu-theme` | [`plugins/ayu-theme`](../../plugins/ayu-theme) | 为窗口壳层、代码编辑器、终端与语法高亮提供 Ayu Light、Ayu Mirage 与 Ayu Dark 三套完整主题。 |

---

## 三、附：内置「协作空间」（非插件）

**协作空间（Collaboration Space）** 与 `&Agent` 委派是 **VibeX Host 内置核心能力**（开关位于「设置 → 常规 → 协作空间」，默认开启，不通过插件安装）：

- 开启后，新建或重绑定的会话自动获得 `delegate_to_agent` / `create_conversation` 等协同能力，Composer 可用 `&` 点名其他已就绪 Agent；
- 协作空间中的「助手（Bot）」是持久身份（`collaboration_members`），名下自动维护一条私聊隐藏会话（`direct:<member_id>`）及每个群组座位的独立隐藏会话，群聊通过共享房间日志与逐收件人投递回执（`DeliveryReceipt`）协同。完整架构与身份语义见 [`docs/architecture.md#collaboration-member-identity`](../architecture.md#collaboration-member-identity)。
