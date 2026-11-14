# VibeX 参考 T3Code 的优化改进事项清单（量化评估与执行顺序）

> **对齐前提（产品战略聚焦）**
> 1. **全力聚焦单线程会话底座**：先彻底解决单会话的稳定性、内核深度、回滚安全与微交互顺手度；**协作空间/工作流升格**暂后置。
> 2. **战略裁剪**：**PR 工作流闭环**、**外部 IM 通道与 Outside MCP**、**语音输入/访客分享**本阶段暂不投入。
> 3. **量化标准（1~5 分）**：
>    - **紧急性**（5=正在引发线上 Bug/严重劝退，1=锦上添花）
>    - **必要性**（5=决定产品基本盘与口碑上限，1=可选）
>    - **实现难度**（5=涉及核心架构重构/跨进程协议重写，1=局部增量改动）

---

## 一、 核心结论前置：Claude 与 Codex 内核能否直接迁移 T3Code 代码？

**结论：不能直接跨语言拷贝源码（TS/`Effect` vs Rust/Tokio），但可以采取“分层直接复用逻辑 + Node 原生桥接复用代码”的捷径，比全部用 Rust 从零重写快 3~5 倍。**

| 目标内核 | T3Code 实现真相 | VibeX 最优迁移策略 | 预计提速效果与原因 |
| :--- | :--- | :--- | :--- |
| **Codex 内核** | `CodexAdapterV2` (8,650 行) + `effect-codex-app-server`，底层本质是通过 stdio 与 `codex app-server` 走 **JSON-RPC 2.0** 协议 | **协议逻辑 1:1 移植到 Rust** | 无需引入 Node 进程。可参考 T3Code 生成的 JSON-RPC Schema 直接在 `crates/agents` 定义 Rust `serde` 结构体，原生实现 `turn/start`、`turn/steer`、`turn/interrupt`、`thread/revert`、`rateLimits`、`terminal_output_delta` 等，彻底淘汰 `codex-acp` 包装器 |
| **Claude Code 内核** | `ClaudeAdapterV2` (13,769 行)，强依赖 Anthropic 官方 Node.js 包 **`@anthropic-ai/claude-agent-sdk`**（Rust 无官方对等 SDK） | **Node Sidecar 桥接 + 逻辑直接复用** | **强烈不建议在 Rust 里从零逆向 Claude CLI**。VibeX 桌面端已内置 Node 运行时，可直接抽取 T3Code `ClaudeAdapterV2` 中与 `claude-agent-sdk` 交互的核心模块（权限 `canUseTool`、Hooks、`forkSession`、`resumeSessionAt`、`SDKRateLimitInfo`、`promptCacheExpiresAt`、子代理进度读取），封装成 VibeX 自有轻量化 Node Driver 进程，通过增强型 JSON-RPC 对接 Rust 底座 |

---

## 二、 微交互与工具差距全清单（剔除 VibeX 已有项）

> 核验确认：VibeX **已具备**会话内搜索（`ConversationFindBar`）、引用预览浮层（`QuoteTokenPreview`）、基础消息排队（`MessageQueueIndicator`）、输入历史上下翻（`sessionComposerHistory`）、手动压缩按钮及目标栏。以下仅列出 **VibeX 真正缺失** 的 T3Code 能力：

| 类别 | T3Code 具备而 VibeX 缺失的具体功能/工具 | 紧迫度分级 | 用户体感价值 |
| :--- | :--- | :---: | :--- |
| **队列与改向** | **Steering 不支持时自动中断重启** (`restart_active`) | **迫切** | 解决改向直接报错拒收的痛点，用户无需手动停掉再复制重发 |
| **队列与改向** | **排队消息编辑 / 重排 / 一键“提升为 Steer”** (`QueuedRunsControl` / `t3_queue`) | **迫切** | 排队中发现少写条件可直接修改，或急了直接插队升为 Steer |
| **上下文省流** | **伴生 MCP 延迟工具发现** (`tool_search`) | **迫切** | 冷启动只暴露核心元工具，按需检索再挂载，大幅降首轮 Token 与误调用 |
| **长会话审阅** | **划线选中 AI 回复直接引用追问** (`AssistantCitation`) | **迫切** | 选中长回复中的几行代码/文字直接浮出引用按钮，带入输入框并支持点击回跳定位 |
| **长会话审阅** | **右侧时间线缩略导航条** (`TimelineMinimap`) | **较迫切** | 30+ 轮长对话中悬停快速预览每轮提问并秒级跳转（补全当前纯文本 `Ctrl+F` 搜索的不足） |
| **无干扰分支** | **旁路轻量分叉** (`SideChatPane`) | **较迫切** | 主线程旁边拉起临时提问窗，问完即走，不污染主任务上下文与线程列表 |
| **输入保护** | **草稿暂存箱** (`ComposerStashMenu`) | **一般** | 写到一半的长 Prompt 一键暂存先发插曲消息，之后一键恢复 |
| **自动化看护** | **限流重置自动续跑** (`UsageLimitRecoveryWorker`) | **迫切** | 撞订阅额度后记录 `resetAt`，时间一到自动接着跑完 |
| **自动化看护** | **空闲缓存到期前自动 `/compact`** (`IdleCompaction`) | **较迫切** | 长对话（>100k–200k Token）在 Prompt Cache 过期前 2 分钟自动压缩，防止下次唤醒整段重计费 |
| **跨模型接力** | **同线程跨 Provider 热切换 + 预算摘要交接** (`ContextHandoffService`) | **较迫切** | 单条对话里从 Claude 切去 Codex，系统按 Token 预算提炼历史变更摘要无缝续跑 |
| **其他生态工具** | 浏览器录屏 (`preview_recording`)、页面交互微应用 (`McpAppFrame`)、语音输入 (`VoiceInputPill`)、访客链接 (`GuestShare`)、PR 监控 Stack | **暂缓** | 非当前单线程主痛点，本阶段不做 |

---

## 三、 VibeX 参考 T3Code 优化改进事项总表（已量化 & 排定顺序）

### 执行总路线图（4 个阶段，10 项核心改造）

```
Phase 1（先止血：消息可靠性 + 渲染性能 + 零门槛体验）
  [1] 根治消息乱序/丢字/闪跳（切除双轨回读竞态）
  [2] 流式 Markdown 闭合块 LRU 缓存
  [3] MCP 延迟工具发现 (tool_search)
  [4] Steering 自动中断重启 + 排队消息编辑/提升
        │
        ▼
Phase 2（换引擎内核 + 修好 Rewind 安全网：决定上限）
  [5] Codex 原生 App-Server 协议直连驱动
  [6] Claude Code 原生 SDK 桥接驱动（复用 T3Code 核心逻辑）
  [7] 真 Rewind 重构（隐藏 Git Ref + 原生回退 + 隔离安全校验）
        │
        ▼
Phase 3（释放原生红利 + 补齐编码微交互顺手度）
  [8] 限流自动续跑 & 缓存到期前 Idle Compaction
  [9] 编码微交互三件套（划线引用追问 + Minimap + Side Chat / 草稿暂存）
  [10] 同线程跨模型热切换（预算摘要交接）
```

---

### 量化明细表

| 顺序 | 阶段 | 优化改进事项 | 紧急性 | 必要性 | 难度 | 核心做法（参考 T3Code 对应机制） |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| **1** | Phase 1 | **消息持久化收口与乱序/丢字/刷新异常根治** | **5** | **5** | **4** | **治本方案**：以 SQLite 规范化投影表作为唯一读写权威源（服务端按 400ms/块边界节流写入，携带严格单调 `sequence` 与稳定 `itemId`）。前端与历史分页**停止回读外部 JSONL 文件**（JSONL 退居纯审计写副本），彻底删除 `window-covers-live` 覆盖对账与 2 秒时间容差补丁；客户端断线落后过多时直接按投影快照重同步，并顺手补齐超 1 天冗余事件裁剪。 |
| **2** | Phase 1 | **流式 Markdown 改造成“闭合块分块 + LRU 缓存”** | **5** | **5** | **2** | 参考 `markdownStreamBlocks` 与 `markdownRenderer`：在进入渲染前按空行与闭合围栏切割字符串，已闭合段落按文本哈希进 LRU 缓存复用 `ReactElement`；流式吐字期间**只重解析最后一段未闭合块**，同步解决长回答掉帧并减少前端二次切片的负担。 |
| **3** | Phase 1 | **伴生 MCP 延迟工具发现（`tool_search`）** | **4** | **5** | **2** | 参考 `McpToolExposure`：对伴生 MCP 默认只下发高频核心元工具 + `tool_search`，模型检索命中后再在会话内动态开放目标工具并发送 `list_changed` 通知，立竿见影降低首轮 Token 消耗与模型选错工具概率。 |
| **4** | Phase 1 | **Steering 智能中断重启 + 队列消息编辑/提升** | **4** | **4** | **2** | 参考 `CommandPolicy` & `QueuedRunsControl`：保留“原生 `_session/steering` 优先”，但在引擎不支持（或带附件）且非禁用名单时，由服务端自动协调 `cancel -> 等停稳 -> 优先重发`；前端放开排队消息的文本编辑、删除与一键“提升为 Steer”。 |
| **5** | Phase 2 | **Codex 内核升级：Rust 原生对接 `codex app-server`** | **5** | **5** | **3** | 彻底替换 `codex-acp`。参考 `effect-codex-app-server` Schema 在 Rust 实现 JSON-RPC 客户端，直接消费原生 `turn/start`、`turn/steer`、`thread/revert`、`rateLimits` 与终端流式增量，直接为 Phase 2/3 解锁真回滚与限流续跑。 |
| **6** | Phase 2 | **Claude 内核升级：复用 T3Code SDK 逻辑建 Node 桥接驱动** | **5** | **5** | **4** | 彻底替换第三方 `claude-agent-acp`。基于 VibeX 内置 Node 环境封装 `@anthropic-ai/claude-agent-sdk` 桥接进程，直接迁移 `ClaudeAdapterV2` 里的权限钩子、子代理流、`resumeSessionAt`、`forkSession`、Usage 账本与 Cache TTL 透传给 Rust 底座。 |
| **7** | Phase 2 | **Rewind（回滚）机制全链路重构** | **5** | **5** | **4** | 参考 `CheckpointService` + `CheckpointRollbackService` + `CheckpointRestoreSafety`：<br>① 每轮用 **隐藏 Git Ref** 捕获基线与快照，不再强行冷启动拉历史；<br>② 文件与引擎**协同回滚**：Codex 调原生 `thread/revert`，Claude 调 `resumeSessionAt`；不支持回退的 ACP 引擎明确二选一（只退代码开新会话 / 拒绝撕裂操作）；<br>③ 强制校验工作区隔离状态（禁止在共享目录误覆盖其他任务文件），失败时原子恢复。 |
| **8** | Phase 3 | **限流重置自动续跑 & 缓存到期前 Idle Compaction** | **4** | **4** | **2** | 依托第 5、6 项拿到的原生 `usageLimitResetAt` 与 `promptCacheExpiresAt`：额度耗尽时自动挂起并在重置后自动发送继续；Claude 长会话（>100k–200k Token）在缓存过期前 2 分钟自动触发压缩保鲜。 |
| **9** | Phase 3 | **高频编码微交互补齐（划线引用 + Minimap + Side Chat + 暂存）** | **3** | **4** | **3** | ① **划线引用追问**：选中回复片段生成引用芯片并支持回跳定位（优先级最高）；<br>② **Timeline Minimap**：长对话右侧缩略跳转条；<br>③ **Side Chat & 草稿暂存**：主线旁路临时问答窗 + 输入框草稿 Stash。 |
| **10** | Phase 3 | **同线程跨模型热切换（预算摘要交接）** | **3** | **4** | **3** | 参考 `ContextHandoffService` & `ProviderSwitchService`：支持在同一对话中从 Claude 切去 Codex/Grok 等，由后台按目标模型 Token 预算自动生成前序决策摘要与文件变更清单作为交接上下文注入，无需手动重开会话。 |

---

## 四、 本阶段明确暂缓清单（不做项，防止范围蔓延）

以下 T3Code 功能已核实差距存在，但结合你的业务判断，**本周期暂不列入改造计划**：
1. **PR 监控 / Review 导览 / PR Stack**：开发者普遍直接指令 Agent 调 `gh` / Git 完成 PR，ROI 低于内核与稳定性。
2. **微信 / Telegram 外部 IM 扩展与 Outside Agents `/mcp` 网关**：优先打磨好桌面单线程底座后再做跨端与外部触达。
3. **单线程一键升格协作空间 / Workflow**：先将底座单会话打磨到零乱序、高顺滑度，空间与流自然水到渠成。
4. **原生移动端 App（Live Activity）、语音输入、浏览器录屏、Guest Share**：属于非核心编码主链路的扩展形态，待底座稳固后再按需评估。
