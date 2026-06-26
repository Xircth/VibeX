# VibeX vs codeg-main 对比报告

> 目的:以更成熟的参考项目 **codeg-main** 为标杆,评估 **VibeX** 在功能完整度、实现真实度、ACP 会话可用性、产品体验上的不足。
> 方法:6 维度并行代码勘察 + 对高影响结论的**第一手核验**。本报告**已纠正自动勘察中的多处夸大**(见下),严重度以核验后为准。
> 范围:只读分析,未改动代码。证据为 `文件:符号/行`。

---

## 0. 可信度说明 —— 自动勘察被核验推翻/修正的结论

自动子代理倾向于**高估差距**。以下结论经亲自读码**已修正**,报告正文采用修正后的判断:

| 自动结论 | 核验结论 |
|---|---|
| 重连"冷启动、丢失会话状态、需重开对话"(高) | **过度**。VibeX 有 `resume_session` / `load_or_new_acp_session`,在 `supports_load_session` 时用持久化的 `external_session_id` 发 `LoadSessionRequest` 恢复会话(manager.rs:345/998/1010-1013)。状态经 **session/load 恢复**;真正缺的是"复用同一活进程"(find_connection_for_reuse)的优化 → 刷新会**新起进程并 load**,而非丢状态。降为中。 |
| "Tauri-only,无 web 客户端 / 无 web transport"(dim6) | **错误**。VibeX 有后端 web 服务(axum,src-tauri/Cargo + deployment)、前端流式传输(`useTauriPatchStream.ts`/`streamJsonPatchEntries.ts`)、`WebServiceSettings`。差距是 **web 端传输的重连韧性**(指数退避/健康探测/重连对话框)不如 codeg,而非"没有 web"。 |
| "无状态栏"(dim5,高) | **错误**。存在 `frontend/src/components/layout/StatusBar.tsx`(被 IDELayout 使用)。差距是模块丰富度,非缺失。降为低。 |
| "权限仅 events stub、无 broker"(dim1) | **过度**。`conversation_service.rs::respond_permission`(245)→`agent_runtime.respond_permission` + `AgentPermissionPanel` 是**可用的请求/响应闭环**。真正缺的是权限 UI 丰富度(diff 预览)与问询/反馈在断连时的登记/取消健壮性。 |
| "无终端面板"(dim5) | **错误**。有 `AgentTerminalPanel`(ACP agent 终端,crates/agents/terminal.rs + 前端组件/测试)。差距:可能缺"用户自驱的通用终端"。 |
| "流式消息适配器 missing"(dim2,高) | **过度**。VibeX 有 `messageTurnAggregate.ts::groupTurnRenderItems`(turn 内连续同类工具折叠)。缺的是**跨 turn 合并**(mergeConsecutiveAssistantTurns)与 goal/delegation 分组。降为中。 |

---

## 1. 执行摘要

**结论:VibeX 的 ACP agent 调度内核已经可用且运行时完整**(连接握手、new/load 恢复、prompt 流式、取消、权限闭环、终端、MCP/skills surface、委派 broker、事件溯源会话),**没有 mock 的 agent 运行路径**。相对 codeg-main 这个更成熟的产品,VibeX 的差距主要集中在四块:

1. **产品外壳广度**(最显著):无 i18n(界面硬编码中文)、设置模块深度约为其一半、状态栏/键位/主题自定义/升级 UI 较浅。
2. **会话 UX 精致度**:权限对话框(结构化 + diff 预览)、子代理/委派可视化、计划浮层、生成图片、流式 shimmer、跨 turn 合并等"高保真"交互缺失或较弱。
3. **平台高层功能**:experts 库 + delegation workflows、reasoning/extended-thinking 与会话模式的热切换 UI、MCP marketplace 深度。
4. **会话健壮性优化(非阻断)**:session fork(已声明能力但未实现)、活进程复用、Claude API 重试可见性、结构化错误码、并发 prompt 串行化等。

**粗略完整度(相对 codeg-main,核验修正后):** ACP 内核 ~70% · 会话渲染 UX ~60-65% · 平台高层功能 ~45-50% · 产品外壳 ~55-60% · 健壮性边界 ~50%(原 35% 偏低,因低估了 session/load 恢复)。

VibeX 也有**反超点**:reset-to-here 原位重发 + 上下文截断、逐 token 流式、macOS Tahoe Liquid-Glass 设计体系、桌面 toast 快捷回复、模块化的 delegation/事件溯源架构。

---

## 2. 分维度差距(核验后严重度)

### 2.1 ACP 运行时与会话生命周期(后端)
| 能力 | VibeX | 影响 | 严重度 | 证据(codeg → vibex) |
|---|---|---|---|---|
| Session Fork(分叉/分支) | 仅声明 `ForkSupported` 能力,**无 fork 操作实现** | 已在 UI 暗示但不可用;无法分支探索/保留分叉前历史 | **高** | acp/fork.rs、manager.rs:1191 `fork_session` → agents/events.rs:229 仅事件 |
| 活连接复用(刷新后 re-attach 同进程) | 无 `find_connection_for_reuse`;刷新→新进程 + session/load | 多一次进程启动与重载(状态本身能经 load 恢复);多窗口同会话共控弱 | 中 | manager.rs:585-614 → 无 |
| 并发 prompt 串行化(prompt_lock / turn-in-flight 门) | 有 `AgentPromptQueue` 队列,但无 per-connection 锁与 in-flight 拒绝门 | 多标签/渠道同时发送可能交错、队列无界增长 | 中 | manager.rs:664-689 → runtime.rs 队列无锁门 |
| 问询/反馈登记(pending registry + 断连取消) | 仅事件,无 pending 注册表/去重/断连清理 | 父连接死亡时问询变孤儿,无法应答/取消 | 中 | acp/question.rs、feedback.rs → conversation.rs 仅类型 |
| 空闲连接清扫 | 无 idle sweep | 长期空闲会话累积活连接,资源占用 | 中 | manager.rs:480 → 无 |
| 配置指纹/陈旧检测 | 有 `SessionConfigStale` 事件,无指纹比对主动触发 | 中途改配置不自动提示"重启生效" | 低 | manager.rs:539 → 仅事件 |
| 实时 usage/上下文窗口上报 | `TurnUsage` 静态,无实时 Usage 事件 | 无实时 token 燃烧/接近上限预警 | 低 | → conversation.rs:34-45 |

### 2.2 会话渲染与聊天 UX(前端)
| 能力 | VibeX | 影响 | 严重度 |
|---|---|---|---|
| 权限请求 UI(结构化 + diff 预览) | `AgentPermissionPanel` 简单面板,无命令/变更 diff/计划/Web 请求结构化展示 | 用户难以审阅代理意图(尤其代码改动),安全决策信息不足 | 高 |
| 子代理/委派可视化 | 仅在 side row 显示 delegation 文本 | 委派进度/状态/子会话不可追踪 | 高 |
| 跨 turn 合并 / goal-run 分组 | 有 turn 内工具分组,无跨 turn 合并/goal 分组 | 多轮工具流体验冗余,统计不跨 turn 聚合 | 中 |
| 实时计划浮层 | 仅内联 `TimelinePlanCard`,无右上浮层/流式动画 | 看不到全局执行进度,需上滚查看 | 中 |
| 生成图片块(预览/下载) | 缺失 | 无法显示/下载代理生成图片 | 中 |
| ask-question/feedback 卡片丰富度 | result card 仅文本,无多选/选项卡/历史预览;无 feedback 显示 | 复杂问卷/反馈交互弱 | 中 |
| 虚拟化与流式动画(shimmer) | 基础 react-virtual,无 shimmer 加载动画 | 长会话滚动/加载反馈略逊 | 低-中 |
| 消息导航栏信息密度 | 有导航点,展开信息不如 codeg(无 +N/-N 变更统计/文件 diff) | 导航可用但信息少 | 低 |

### 2.3 Agent 平台功能(MCP/skills/slash/experts/委派/模型档位)
| 能力 | VibeX | 影响 | 严重度 |
|---|---|---|---|
| Built-in experts 库 + 命令菜单 | 无 experts.toml/元数据/命令菜单(仅 skills.sh) | 无法一键调用结构化专家工作流 | 高 |
| delegation 驱动的 workflows | broker 架构完整,无 workflow 编排层/UI | 无法用并行子代理/任务分解/自动 code review 等高级模式 | 高 |
| reasoning/extended-thinking + 模式热切换 UI | 类型存在,无 mode-selector/thinking budget/reasoning 展示组件 | 运行时无法调档位/看推理过程 | 中 |
| per-agent 委派默认值配置 UI | 无 | 子代理无法继承父偏好,每次手填 | 中 |
| MCP marketplace 深度 | 可装本地/Smithery,无 per-server 模型列表/详情页/高级筛选 | 选 MCP 缺决策支持 | 中 |
| checkpoint/reset UI | DB 层完整(SessionCheckpoint),无前端检查点列表/回滚 UI | 无法浏览/回滚到历史检查点(注:reset-to-here 重发已实现) | 低 |
| Agents 设置面板深度 | 基础,无 per-agent MCP 细调/skill 开关集中管理 | 高级配置分散 | 中 |
| slash 命令覆盖 | 仅 claude_code/codex/opencode 有定制命令,其余 4 个 agent 无 | 用 Gemini/OpenClaw 等无快捷命令 | 低 |

> 平台层 **foundational 已就绪**(mcp surface、skills surface、delegation broker、vibex-mcp 二进制均**真实可用**,与 codeg 对等);缺的是 **product/workflow 层**。

### 2.4 实现真实度(mock/stub vs 真实)
| 能力 | VibeX | 影响 | 严重度 |
|---|---|---|---|
| Chat channel 持久化 | 文件 JSON(无 DB 表),无消息日志/发送人上下文/审计 | 无法追踪通知投递历史/失败重试 | 中 |
| Chat channel 日报(daily report) | 无字段/无定时摘要 | 无定时编码摘要推送 | 中 |
| Provider/Model 配置历史 | apply 真实写多格式 + 备份(保留 10 份),但无版本历史/应用时间戳 | 无法回溯配置历史;多工作区可能不同步 | 低 |
| Agent capability 动态更新 | metadata.rs 静态硬编码,不随 ACP 初始化动态更新 | UI 可能声称支持(如 fork)但实际不支持 → 操作失败 | 低-中 |

> 真实度整体良好:**delegation 端到端真实**(子会话 DB 建模 + 任务克隆)、**provider apply 真实**(JSON/TOML/YAML/dotenv + 原子写 + 备份)、**无 agent 运行的 mock**。主要"真实度"短板在 **chat channel 的持久化/审计**这一块偏"轻量占位"。

### 2.5 产品外壳与整体体验
| 能力 | VibeX | 影响 | 严重度 |
|---|---|---|---|
| i18n 多语言 | **无 i18n 框架,界面硬编码中文** | 非中文用户无法使用;限制国际化(若定位 China-only 则降级) | 高* |
| 设置深度 | ~16 个设置文件 vs codeg 40+;缺 delegation/experts/backup/channel-commands 等细分 | 高级配置受限 | 中 |
| 键位完全自定义 | 仅"发送键"二选一,无全量重绑/冲突检测/恢复默认 | 无法定制工作流键位 | 中 |
| 升级/回滚 UI | 有逻辑层,无进度/重启倒计时/一键重启 UI | 升级过程不透明 | 中 |
| 主题颜色/缩放/字体 | 仅亮暗模式 | 定制有限(无缩放/主题色/字体) | 低 |
| 状态栏丰富度 | 有 StatusBar,但模块少于 codeg(更新/tokens/连接/告警等) | 信息可见性弱于 codeg | 低 |
| Web 远程接入便利性 | 有 web 服务/端口,但无 QR 码/多地址选择/地址记忆 | 移动端接入繁琐 | 中 |
| Pet 宠物系统 | 无 | 缺个性化/可玩性 | 低 |
| onboarding / 项目启动模板 | 有基础 OnboardingDialog,无多模板引导启动 | 新手引导浅 | 低 |
| git/diff 面板深度 | 有提交图,缺 changes/log 详情、统一 diff 深度 | Git 可视化不够细 | 低 |

\* i18n 严重度取决于定位:面向全球=高;China-only=中。

### 2.6 健壮性与可用性边界
| 能力 | VibeX | 影响 | 严重度 |
|---|---|---|---|
| Claude API 重试可见性(退避反馈) | 无 `ClaudeApiRetryState` 等价物 | 限流/5xx 时用户看不到"重试中",像卡死 | 中-高 |
| 结构化错误码 + terminal 标志 | `AgentEvent::Error{message,raw}` 无 code/terminal | UI 无法按错误类型本地化/图标化;turn 终态判定弱 | 中 |
| resource_not_found(会话过期)区分 | 无;与通用错误混在一起 | 恢复已删除会话时只见通用错误,无"会话过期+新建"引导 | 中 |
| web 传输重连韧性(退避/健康探测/重连按钮) | web 服务存在,但无指数退避/探测/重连对话框 | 网络抖动/休眠后 web 端连接可能挂起需重启 | 中 |
| 握手超时含 stderr 诊断 | 有超时 env,但超时错误未带最近 stderr | agent 启动挂起难诊断 | 低 |
| 快照重放事件去重(lastAppliedSeq) | 前端有 gap 回填,但无 seq<=last 去重护栏 | 重连快照+实时流重叠时极端情况下可能重复渲染 | 低 |
| 关键异步序列取消护盾(如 fork) | 无(fork 未实现) | (随 fork 一起) | 低 |

---

## 3. VibeX 反超 codeg-main 的点

- **reset-to-here 原位重发 + 上下文截断**(后端 `truncate_to_turn_ordinal` + 前端硬重载),codeg 无等价的"重置到此消息"。
- **逐 token 流式**(后端 8ms coalesce + 前端 rAF 按帧),codeg 仅 turn 级聚合。
- **macOS Tahoe Liquid-Glass 设计体系**(DESIGN.md 单一真源:两层材质/token/无障碍降级),比 codeg 的标准 shadcn 更系统级。
- **桌面 toast 快捷回复**(通知窗口内直接追问、自动消失/暂停),codeg 未提供。
- **架构清晰度**:事件溯源会话核心 + 模块化 delegation-proto/broker + `SessionRecoveryStrategy` 显式枚举,易测试与扩展。
- **skills.sh marketplace 开放集成**(symlink/copy 可选),比 codeg 内置捆绑 experts 更社区友好。

---

## 4. 优先级建议(若以"对齐 codeg 产品力"为目标)

**P0(高 ROI,直接影响可用性/可信度)**
1. **会话 UX 高保真化**:权限对话框(结构化 + diff 预览)、子代理/委派可视化、计划浮层 —— 直接影响"看得懂代理在干什么 + 安全决策"。
2. **Claude API 重试可见性 + 结构化错误码 + resource_not_found 区分** —— 把"像卡死/通用报错"变成可理解、可操作。
3. **experts 库 + delegation workflows** —— 若 VibeX 定位多代理编排平台,这是核心产品力短板。

**P1(完善度)**
4. session **fork** 端到端(参照 codeg acp/fork.rs;先把 metadata 声明改为动态/真实,避免"声称支持但不可用")。
5. reasoning/extended-thinking 与会话模式**热切换 UI** + per-agent 委派默认值。
6. **i18n 框架**(若需国际化)。
7. 设置深度补齐(键位全自定义、升级进度 UI、主题/缩放、MCP marketplace 深度)。

**P2(健壮性/打磨)**
8. 活进程复用(find_connection_for_reuse)+ prompt 串行化锁 + 空闲清扫 + 快照 seq 去重。
9. chat channel 持久化(DB 表 + 消息日志 + 日报)。
10. 生成图片块、shimmer、跨 turn 合并、消息导航信息密度、终端通用化、状态栏模块补齐。

---

## 附:方法学

6 个并行只读勘察 agent(ACP 运行时/会话渲染/平台功能/真实度/产品外壳/健壮性),各自跨两库读码并产出结构化差距;随后对**所有高严重度与存疑结论**做第一手核验(见 §0),按核验修正严重度。原始勘察输出保存在本次会话的 workflow 任务结果中。
