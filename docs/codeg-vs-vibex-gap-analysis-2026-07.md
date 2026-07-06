# codeg (v0.18.8) vs VibeX — 功能差距分析与 P0–P3 提升计划

> **日期**：2026-07-04　**方法**：5 路并行只读盘点（codeg 后端 / codeg 前端 / VibeX 后端 / VibeX 前端 / 16 项对等探针）+ 对全部高影响结论的第一手代码核验。
> **取代**：[codeg-vs-vibex-comparison.md](./codeg-vs-vibex-comparison.md)（基于旧快照 codeg-main v0.15.7，其中"结构化权限卡缺失、DelegationCard 缺失、生成图片块缺失、feedback 卡缺失、崩溃恢复缺失"等结论**已过时**——这些均已实现；本文以 codeg v0.18.8 与 VibeX 当前 `refactor/arch-remediation-impl` 分支为准）。
> **范围**：纯功能视角。架构健壮性债务（单投影、行操作协议等）见 [docs/refactor/batch-c-e-implementation-plan.md](./refactor/batch-c-e-implementation-plan.md)，不在本文重复。
> **路径约定**：VibeX 侧路径相对仓库根；codeg 侧路径相对 `/Users/sean/Documents/Projetcs/codeg`。
> **词汇**：遵循根 [CONTEXT.md](../CONTEXT.md)（Conversation/Turn/Session resume/History import 等术语按其定义使用）。

---

## 0. 结论摘要

**两个产品的核心引擎已大体对等，VibeX 在工程闭环上反超；真正的差距在"产品形态"：codeg 是随处可达、可无人值守的四形态产品（桌面 + 服务器/Docker + 浏览器/手机 + IM 远控），VibeX 目前是只能坐在电脑前使用的单形态桌面应用。**

背景事实：[docs/specs/codeg-alignment/](./specs/codeg-alignment/) 的 10 阶段对齐计划中，本文发现的缺口几乎精确落在**未实施的阶段 3（历史聚合）、7（i18n）、8（服务器部署——实际远薄于规格）、10（Project Boot / 托盘 / 宠物）**。差距不是没被认知，而是没被执行。

## 0.1 实施进度（2026-07-04，TDD 执行）

本轮已按 P0 优先级执行并全部通过验证（`cargo check`/`clippy --features qa-mode`/后端 443 测试/前端 tsc+eslint/`generate-types:check` 全绿）：

| 项 | 状态 | 交付物与测试 |
|---|---|---|
| **P0-0** IM 发送者白名单 | ✅ 完成 | `is_sender_authorized` + dispatch 单点门 + fail-closed + 前端授权列表 UI；7 单测 |
| **P0-1** IM 远程审批闭环 | ✅ 完成（后端） | `/approve[always]` `/deny` `/cancel` `/resume` + `decide_remote_permission_response`；6 单测 |
| **P0-2** 能力声明诚实化 | ✅ 完成 | SessionFork→ResetToHere（全 agent 诚实）、修正 sessionContinuity 分叉谎言、删除死 fork 事件；map→design→对抗验证 workflow + 单测 |
| **P0-3** Automations 调度核心 | 🟡 核心完成 | 无依赖 cron 求值器 `schedule.rs`（12 单测）；DB/scheduler/命令/UI 待续 |
| **P1-5** 部署形态方案 B | ✅ 完成 | 本机 API 定位文档化 + spec-08 作废横幅 + API 文档 |

**未开始（需专门会话，规模见各条）**：P1-1 解析器补齐、P1-2 FTS、P1-3 导出、P1-4 真 fork（ADR-0005 已备）、P1-6 更新器、P2-1 stash、P2-2 克隆、P2-3/4/5/7/8、P3。

## 1. 第一性原则框架

这类产品的本质工作：**把开发者的意图，经由多个 AI agent，安全、持续地转化为已验证的工作产物。**

产出总量 ≈ **可用 agent 时长 × 并行度 × 单位时长有效性**。

- "可用 agent 时长"由**可达性**（人不在电脑前时 agent 是否还能推进/被解锁）与**自动化**（任务能否无人值守运行）决定 —— 这是 VibeX 当前最大短板，也是 P0 的全部来源。
- "并行度"由 worktree 隔离（已对等）、委派（已对等）、**会话分叉与并排对照**（偏弱）决定。
- "有效性"由观察控制（大体对等）、**历史资产可检索性**（偏弱）、工程闭环深度（互有胜负）决定。

七维度评分（相对 codeg v0.18.8）：

| 维度 | 本质问题 | 结论 |
|---|---|---|
| ① 可达性与无人值守 | 你不在电脑前时，agent 还能干活/被解锁吗？ | **重大差距** |
| ② 自动化与复用 | 任务能沉淀成可调度资产吗？ | **完全缺失** |
| ③ 历史资产 | 所有会话（含 app 外）是可检索资产吗？ | 明显偏弱 |
| ④ 供给面 | 能驱动多少 agent、接入多深？ | 偏弱（7 vs 10） |
| ⑤ 执行拓扑 | 会话能分叉、并排对照吗？ | 偏弱 |
| ⑥ 工程闭环 | git→diff→PR→预览深度 | **互有胜负，总体反超** |
| ⑦ 产品成熟度 | i18n / 自更新 / 常驻性 / 定制 | 明显偏弱 |

## 2. 逐维度对照（核验后）

### ① 可达性与无人值守

| 能力 | codeg | VibeX 现状（证据） |
|---|---|---|
| 独立服务器二进制 | `codeg-server`（Axum + 静态前端 + WS）| 无（`src-tauri/src/bin/` 仅 generate_types）|
| 浏览器/移动端 UI | 静态导出 + token 登录 + 移动 Sheet 壳 | 无（web 服务不提供 UI）|
| 远程访问 | 0.0.0.0 + Docker + 一行安装脚本 | 仅 127.0.0.1（`web_service.rs:651`）|
| 桌面连远程实例 | remote workspace connections + 传输票据 | 无 |
| 服务器自更新 | 原地更新 + `.bak` 回滚 + supervisor 试用期自动回退 | 无 |
| IM 远程审批 | `/approve [always]` `/deny` | **无**（`chat_channel.rs:1337` `dispatch_command` 仅 help/status/sessions/use/task）|
| IM 会话控制 | `/task` `/resume` `/cancel` `/folder` `/agent` `/search` `/today` | 仅 `task/do/ask`、`use`、`sessions`、`status` |
| IM 通道 | Telegram/飞书/微信（含扫码登录），全双向 | Telegram/QQ/飞书三通道入站（`chat_channel.rs:881,941,1087`）+ 企微/webhook 出站 |

### ② 自动化与复用

codeg：Automations 引擎（`src-tauri/src/automation/engine.rs`）——composer 配置存为自动化，cron（分钟粒度+时区）或手动触发，无头执行，可选 worktree 隔离，运行历史/失败徽标/开机恢复/180min 超时强杀。
VibeX：**零**。无任何调度器；executor profiles（`crates/executors/default_profiles.json`）只是静态配置。

### ③ 历史资产

| 能力 | codeg | VibeX |
|---|---|---|
| 外部 CLI 解析器 | **10 个** agent（`src-tauri/src/parsers/`，含 token/上下文窗口统计）| **2 个**：仅 Claude Code + Codex（[loader.rs:29-33](../crates/agents/src/parsers/loader.rs)，测试断言 Gemini 为 None）|
| 聚合浏览 | 侧栏分组/置顶/状态 + 委派子会话嵌套树 | 无跨源聚合列表（导入后落为普通会话）|
| 会话全文搜索 | ⌘K 双 tab（会话+文件）+ agent 过滤 + IM `/search` | **无**（`conversation_list` 仅按 workspace 过滤；DB 无 FTS）|
| 分享导出 | Markdown / HTML / 图片 | 仅数据 bundle（迁移用）|

### ④ 供给面

- 数量 7 vs 10：缺 **CodeBuddy、Kimi Code、Pi**。（已决策不追平，见 P2-6 墓碑条目。）
- 深度：codeg 有 Codex 设备码登录、OpenCode 插件管理+provider 目录、Kimi 模型拉取、Pi 二进制管理、Hermes 引导终端、二进制下载缓存/uv 安装；VibeX 的 preflight/fix/login-terminal 覆盖通用面，无专属深度。
- **诚实性缺陷**：[metadata.rs:31](../crates/agents/src/metadata.rs) `agent_capabilities` 静态声明 `SessionFork`，但 fork 无实现（见⑤）。

### ⑤ 执行拓扑

- **真 fork 未实现**：codeg `src-tauri/src/acp/fork.rs` 原子双行布局，分叉出兄弟会话且**保留分叉前完整历史**；VibeX 只有破坏性 reset-to-here（`conversation_truncate_to_turn`）。
- **多会话平铺**：codeg 会话标签 + tile 并排；VibeX 一次一个会话视图。与 [PRODUCT.md](../PRODUCT.md) 自述核心用例 *"comparing agent output"* 直接冲突。
- 委派引擎对等（异步/跨类型/深度限制），但 codeg 呈现更厚（collab 卡 spawn/wait/resume/close、子线程内嵌、侧栏嵌套树）；VibeX 委派父端 v1 仅 Claude Code。

### ⑥ 工程闭环（VibeX 总体反超，仍有具体缺口）

VibeX 弱项（全部已核验）：

| 缺口 | codeg | VibeX |
|---|---|---|
| stash | 全套 push/pop/apply/drop/show/clear + 独立窗口 | **0 实现**（`crates/git/src/` 无 stash）|
| 克隆入口 | 克隆对话框 | `clone_repository` 在 [remote_ops.rs](../crates/git/src/remote_ops.rs) 有实现但**未注册为命令**，UI 无入口 |
| remote 管理 | add/remove/set-url | 只读 |
| 冲突精修 | 三栏合并编辑器独立窗口 | 对话框级 + agent 辅助 |
| 编辑器 | Monaco + git 槽标 + 自动保存 + **⌘L 选区→对话** | 基础查看/保存；无选区→对话通路 |
| 多账号凭据 | 多 GitHub 账号 + keyring + 凭据助手按 remote 匹配注入 | 依赖 gh/az CLI 单登录态 |

### ⑦ 产品成熟度

| 项 | codeg | VibeX |
|---|---|---|
| i18n | 10 语种 + RTL | 无框架，硬编码中文为主 |
| 自更新 | 桌面 updater + 服务器原地更新/回滚 | 仅 release 检查（`system_maintenance.rs`）|
| 常驻性 | 托盘 + 单实例 + `codeg://` 深链 | 全无（tauri.conf 仅 shell/fs/dialog 插件）|
| 定制 | 主题色板/缩放/字体/文件夹色 + 全键位重绑 | 亮暗主题 + 发送键二选一 |
| 应用日志查看器 | tracing 级别过滤/文件/实时流 | 仅进程输出与 dev server 日志 |
| 无项目纯聊天 | 支持 | 会话必须挂项目/工作区 |
| 备份 | 加密 + 外部 agent 记录 + 冲突扫描 | zip 不加密不含外部记录 |
| 脚手架 | Project Boot（shadcn/hyperframes + 实时预览）| 无（`$shadcn` 提示词而已）|
| Office | officecli 全链路 + watch 实时预览 + 技能矩阵 | 只读 docx 正则抽取预览（[preview.rs](../src-tauri/src/commands/file_tree/preview.rs)）|
| 氛围层 | 桌面宠物 + 状态映射 + 速批面板 + 市场 | 无 |

## 3. 反超点保护清单（对齐过程中**不得回退**）

任何执行本计划的 Agent 在实施前须确认改动不损伤以下 VibeX 独有优势：

1. **PR 全链路**：创建/附加/从 PR 建工作区/评论/后台监控，GitHub + Azure DevOps（codeg 无 PR 创建）。
2. **成本核算**：美元成本仪表盘（日/周/模型 + Codex 套餐面板）；codeg 只有 token 数。
3. **diff 评论 → 下一轮 prompt**（ReviewProvider）。
4. **dev server 预览 + 元素审查器 → composer**（preview proxy 注入）。
5. **事件溯源会话核**：崩溃恢复（Interrupted 终态）、幂等追加、逐 token 流式、检查点 + reset-to-here。
6. prompt 增强、AI commit message、reasoning effort 显式选择器、桌面 toast 快捷回复、VS Code 内嵌、看板 + 多仓项目模型。

---

## 4. 提升计划（P0–P3）

> **战略基调（已拍板 2026-07-04）：选择性对齐。** 补齐可达性/自动化/历史资产（P0–P2）；品类扩张项（Office、Project Boot、宠物）不跟进；差异化持续押注工程闭环（见 §3 保护清单）。

### 4.0 全局执行纪律（每一项都适用；防偏移总则）

1. **架构红线**（[CLAUDE.md](../CLAUDE.md)）：新后端能力进 service crate、经 `Deployment` trait 暴露，命令层保持薄（标杆 `commands/model_provider.rs`）；agent/会话/回合一律走 `crates/agents` + 事件溯源核心；**禁止**向 `crates/executors` 添加任何 agent 执行路径；**禁止**绕过事件日志直接改投影或 DB 状态。
2. **代码生成**：导出到前端的新类型走 `generate_types.rs` 注册 + `pnpm run generate-types`；`shared/types.ts` 不得手改。SQLx 宏/迁移变更后 `pnpm run prepare-db`。
3. **UI 纪律**：遵循 [DESIGN.md](../DESIGN.md) 与设计 token（`--surface-*`/`--text-*`），不新增本地色板；文案暂与现状语言一致（i18n 落地前不引入第二语言的散装文案）。
4. **完成定义**：`pnpm run check` + `pnpm run lint` + 相关测试全绿；对照该项"验收标准"逐条自查；**每项收尾做一次对抗性审查**（用 `/code-review` 或等价流程，重点攻击"验收标准是否真的被行为满足而非表面满足"）。
5. **词汇纪律**：新概念先在 [CONTEXT.md](../CONTEXT.md) 落定义再写代码（Automation、远程审批、Session fork 等）；与既有术语冲突时停下报告，不得自造同义词。
6. **参考实现使用规则**：codeg 路径仅作行为参考与边界案例来源；**不逐行移植**（技术栈不同：SeaORM vs SQLx、Next vs Vite），以 VibeX 架构等价实现。Apache-2.0 归属要求见 `docs/specs/codeg-alignment/`。

> 规模标记：S ≤ 1 人日；M ≈ 2–4 人日；L ≈ 1–2 人周；XL > 2 人周。

---

### P0 — 解锁"人不在场"的 agent 时长（原料已在库，直接扩大产出乘法公式）

#### P0-0 IM 入站发送者白名单 【热修复级；S；已决策 2026-07-04】

- **第一性依据（安全前置）**：现状是**现役漏洞**——任意发现 bot 的人即可用 `task/ask` 驱动 agent 往仓库发起回合（[chat_channel.rs:912-935](../src-tauri/src/commands/chat_channel.rs) Telegram 入站对任意 chat/sender 直接 `dispatch_command`，未与通道配置比对；飞书 :1039、QQ 同理）。P0-1 加 `/approve` 后将升级为"陌生人远程批准工具权限"。
- **目标行为（验收标准）**：
  1. `dispatch_command` 入口强制校验：sender/chat 必须在该通道配置的**授权发送者**列表内（Telegram 复用既有 `chat_id` 字段并支持多值；飞书/QQ 同理增加授权列表字段）。
  2. 未授权消息**静默丢弃**（不回复，避免探测），仅本地日志计数。
  3. 通道设置 UI 增加授权列表编辑；空列表 = 入站整体禁用（fail-closed），不是放行。
  4. 三条入站通道（Telegram/QQ/飞书）全部覆盖 + 各一条拒绝路径测试。
- **防偏移**：校验必须在 dispatch 入口单点实施，**禁止**散落到各命令 handler；**禁止**以"回复一条提示"代替静默丢弃。
- **依赖关系**：P0-1 不得在本项合入前发布。

#### P0-1 IM 远程审批与会话控制闭环 【S–M；依赖 P0-0】

- **第一性依据**：agent 最常见的阻塞是"卡在权限审批等人"。远程 `/approve` 把"人必须回到电脑前"变成"手机上点一下"，直接回收无人值守时长。全计划 ROI 最高项。
- **现状锚点**：[chat_channel.rs:1337-1358](../src-tauri/src/commands/chat_channel.rs) `dispatch_command` 仅有 `help/start`、`status`、`sessions|conversations|ls`、`use`、`task|do|ask`；入站通道已有三条（Telegram 长轮询 :881、QQ OneBot :941、飞书 pbbp2 :1087）。权限响应链路已存在：`conversation_respond_permission` → `conversation_service.rs::respond_permission` → `agent_runtime.respond_permission`；pending 权限在 `ConversationRuntimeState` 与事件日志中可查。
- **目标行为（验收标准）**：
  1. 权限请求产生时，启用了入站的通道收到通知，含工具名、参数摘要与**可选项列表**（allow/allow_always/reject，来自 agent 提供的 options）。
  2. `/approve [always]`、`/deny` 作用于发送者当前绑定会话（`use` 选中的）**最早一条 pending 权限**；多条 pending 时回复队列并支持 `/approve <序号>`。
  3. `/cancel` 取消绑定会话的在途 Turn（复用 `conversation_cancel_turn`）。
  4. `/resume <序号>` 对已中断/空闲会话发起新 Turn 前的绑定切换（等价 `use` + 提示状态）。
  5. 无 pending/无在途 Turn 时，命令回复明确的"当前无待办"文案，不静默。
  6. 权限经 IM 批准后，桌面 UI 的权限卡即时消解（事件驱动，非轮询）。
- **实施边界**：只改 `dispatch_command` 增加 handler + `chat_delivery` 增加通知模板；**禁止**在 IM 层复制权限状态（唯一权威是事件日志）；**禁止**为 weixin/webhook 这类出站-only 通道伪造入站。
- **参考实现**：codeg `src-tauri/src/chat_channel/session_commands.rs`（`/approve /deny` 语义）、`command_dispatcher.rs`（前缀路由）、`event_subscriber.rs`（权限通知格式）。
- **状态：后端已完成 2026-07-04。** 选项选择逻辑 `decide_remote_permission_response`（[permissions.rs](../crates/agents/src/permissions.rs)，6 单测覆盖 approve/always/deny/无选项边界）+ `chat_channel.rs` 的 `respond_permission_command`/`cancel_command`/`resume_command` 命令，权限请求通知文案已改为提示远程 approve/deny。**v1 已接受的简化**：`/approve` 作用于最早一条 pending 权限（未做 `/approve <序号>` 多条选择——ACP 单回合在途时通常至多一条 pending，够用）。

#### P0-2 能力声明诚实化：capability 动态化 【S】

- **第一性依据**：UI 相信 `agent_capabilities` 的静态声明（含 `SessionFork`），而 fork 无实现——"声称能做而做不到"比"没有"更伤信任。这是 P1-4 真 fork 的前置，且独立有价值。
- **现状锚点**：[metadata.rs:31-42](../crates/agents/src/metadata.rs) 静态 `agent_capabilities`；`AgentEvent::ForkSupported/ForkSupportUpdated`（`crates/agents/src/events.rs`）只是转发声明。
- **目标行为（验收标准）**：
  1. 能力以 ACP `initialize` 响应为准动态更新（agent 连接后覆写静态默认）。
  2. 在 P1-4 落地前，前端不再出现任何"分叉"可点入口（或置灰 + "即将支持"）。
  3. 静态表仅作为"未连接时的展示默认"，且 `SessionFork` 从静态默认中移除。
- **实施边界**：改 `metadata.rs` + 连接握手处一次事件发射；不新增命令。**禁止**顺手实现 fork（那是 P1-4）。
- **状态：已完成 2026-07-04（经 map→design→对抗性验证 workflow 定案）。** 实施为 Option A：`AgentCapability::SessionFork` → `ResetToHere` 并对**全部 agent** 诚实声明（reset-to-here 后端 truncate 路径本就无能力门）；删除从未在生产发射的 `AgentEvent::ForkSupported` / `ConversationEvent::ForkSupportUpdated` / 翻译 shim / 前端 `fork_supported` 手写镜像；**修正了一处真实用户可见谎言** [sessionContinuity.ts](../frontend/src/utils/sessionContinuity.ts)（原文案称"从快照分叉出新会话"，实为破坏性截断）。continuity 模式与能力解耦（去掉 `ForkSnapshot`）。验证：`agent_capabilities` 单测（ResetToHere 全覆盖）、224 个 agents 测试、UserMessage 测试、`generate-types:check`、前端 tsc 全绿；全库 fork 引用清零。**真 fork（P1-4）落地时以 ACP initialize 动态协商重新引入独立能力，不再复用 reset 门。**

#### P0-3 Automations：可调度的无头运行 【L】

- **第一性依据**：把"一次性对话"升级为"可复用、可调度的资产"。夜间跑测试修复/依赖升级/定期审查 = 纯增量 agent 时长。VibeX 原料齐全：executor profiles（配置）、worktree 隔离（安全）、事件溯源无头会话（执行与审计）都已存在，缺的只是"调度器 + 运行记录 + UI"。
- **现状锚点**：无任何调度器（全库 grep `cron|scheduler|automation` 阴性）；无头启动 Turn 的能力已具备（`conversation_service` 不依赖 UI；IM `task` 命令即无头发起的现例，`chat_channel.rs::send_task`）。
- **目标行为（验收标准）**：
  1. 新建 Automation：名称 + 项目/仓库 + executor profile + prompt 模板 + 隔离模式（in-place / 新 worktree）+ 触发（手动 / cron 表达式 + 时区）。
  2. `automation_run_now` 立即无头执行：创建（或复用）工作区 → 创建会话 → 发起 Turn；运行落 `automation_run` 记录（状态/摘要/错误/conversation_id）。
  3. cron 到点自动执行；应用重启后调度恢复；超时（默认 180min）强制失败。
  4. 运行历史可在 UI 查看并**一键打开产生的会话**；失败有未读徽标。
  5. 崩溃期间在途的运行按批次 B 语义落 `Interrupted`，不自动重发。
- **实施边界**：调度引擎放 `crates/services`（新 service，经 `Deployment` 暴露）；DB 新表 `automation` + `automation_run`（走迁移 + prepare-db）；命令层薄封装。**禁止**引入第二套会话执行路径——必须复用 `conversation_service::start_turn`；**禁止**在前端/JS 层做定时（进程退出即失效的定时器不算实现）。
- **形态约束（随 P1-5 决策 B 而定）**：调度宿主 = 桌面应用进程。UI 必须明示"应用未运行时不执行"；**错过的 cron 触发不补跑**，启动时只重算 `next_run_at`（简单可预期；codeg 的 boot-reconcile 仅用于在途运行收敛，遵循批次 B 的 Interrupted 语义）。
- **参考实现**：codeg `src-tauri/src/automation/engine.rs`（触发/对账/恢复/强杀语义）、`commands/automation.rs`（API 面）、`db/entities/{automation,automation_run}.rs`（字段设计）。
- **裁剪线**：v1 不做"运行中途 IM 通知细粒度事件"（复用现有会话事件通知即可）；不做自动重试。
- **状态：调度核心已完成 2026-07-04（[schedule.rs](../crates/services/src/services/automation/schedule.rs)，无依赖的 5 字段 cron 求值器 + `next_after`，12 单测覆盖步长/范围/列表/DOW/Vixie DOM-DOW OR 规则/滚动到次日）。** 剩余（未实施，需专门会话）：`automation`/`automation_run` DB 迁移、调度循环 service、命令层、AppState 接线、generate-types、设置页 UI。调度核心是纯逻辑基石，独立可用、无死迁移风险。

---

### P1 — 历史资产 + 形态决策 + 分叉（资产型收益，周级投入）

#### P1-1 历史导入解析器补齐 + 聚合入口 【M–L】

- **第一性依据**：历史会话是复利资产（数据引力）。入口越宽（更多 agent 的历史可导入），VibeX 越接近"所有 AI 编码工作的唯一档案馆"。
- **现状锚点**：[loader.rs:27-33](../crates/agents/src/parsers/loader.rs) 仅注册 Claude/Codex 解析器；`default_history_sources`（`crates/agents/src/history/mod.rs`）已能发现全部 7 agent 的数据目录；导入落库链路已通（`agent_history_import` → `import_agent_session_to_conversation_events`）。
- **目标行为（验收标准）**：
  1. 新增解析器：Gemini、Cline、OpenCode（`opencode.db`）、OpenClaw、Hermes（`state.db`），每个附带真实样本 fixture 测试（消息/工具调用/时间戳/external_session_id 正确抽取）。
  2. `parser_for` 对 7 个 AgentType 全部返回 Some；loader 测试同步更新。
  3. 设置或项目页出现"导入历史"入口：列出各源的可导入会话（数量/时间范围），支持按源批量导入。
  4. 导入产生的 Conversation 遵循 CONTEXT.md 的 History import 定义（接管为原生会话，可 resume 则可续聊）。
- **实施边界**：解析器全部放 `crates/agents/src/parsers/`，实现 `ConversationParser` trait；坏行/未知字段按批次 A 容错语义跳过并计数，**禁止**整文件失败。
- **参考实现**：codeg `src-tauri/src/parsers/{gemini,cline,opencode,openclaw,hermes}.rs`（格式细节与边界案例的最佳来源）。

#### P1-2 会话全文搜索（FTS5）【M】

- **第一性依据**："存了但搜不到"的资产等于没有。检索是历史资产的变现通道。
- **现状锚点**：`conversation_list`（`commands/conversations.rs`）仅按 workspace 过滤；`crates/db/migrations/` 无 FTS 虚表；前端搜索仅文件名（`SearchPalette`）与工作区文本（`search_workspace_text`）。
- **目标行为（验收标准）**：
  1. SQLite **FTS5** 虚表索引会话文本（用户消息 + 助手消息；工具调用参数不索引），事件追加时增量同步（触发器或投影旁路）。
  2. 新命令 `conversation_search(query, filters)`：跨项目全文搜索，支持按 agent kind / 项目 / 时间过滤，返回高亮片段 + 命中 Turn 定位。
  3. 前端 ⌘K 搜索面板增加"会话"tab，命中项点击直达该会话并滚动到命中 Turn。
  4. 导入的历史会话（P1-1）同样可搜。
- **实施边界**：索引构建放 `crates/db`（迁移）+ `crates/services`；**禁止**在前端做全量拉取后内存过滤的伪搜索。
- **参考实现**：codeg `search-command-dialog.tsx`（交互形态）；索引方案自研（codeg 无 FTS，为反超点）。

#### P1-3 会话分享导出（Markdown / HTML）【S–M】

- **第一性依据**：工作产物需要离开工具才能进入协作流（PR 描述、issue、团队分享）。现有 bundle 导出是迁移格式，不可读。
- **现状锚点**：`conversation_export`（`commands/conversations.rs`）输出 bundle JSON（[conversation_bundle.rs](../src-tauri/src/conversation_bundle.rs)）。
- **目标行为（验收标准）**：
  1. 会话菜单新增"导出为 Markdown / HTML"：含消息、工具调用摘要（可折叠）、时间戳、agent/模型标注；HTML 自包含（内联样式）。
  2. 导出内容不含密钥类环境值（对 env/token 字段做脱敏）。
  3. 图片导出（PNG 长图）作为可选二期，不阻塞本项验收。
- **实施边界**：渲染放 service 层从投影生成（复用 `ConversationProjector`），**禁止**前端截 DOM 生成 Markdown。
- **参考实现**：codeg `src/lib/export-conversation/`。

#### P1-4 真 Session Fork（保历史分叉）【L】

- **第一性依据**：探索性开发需要"从这个点试两条路且都保留"。reset-to-here 是破坏性的（丢弃分叉点之后的历史），fork 是资产友好的。
- **现状锚点**：无 fork 实现；`ForkSupported` 声明经 P0-2 已诚实化。事件溯源核心天然适合 fork（事件日志复制到分叉点即可）。相关：`conversation_truncate_to_turn`、`SessionCheckpoint`。
- **语义已决策（2026-07-04，见 [ADR-0005](./adr/0005-session-fork-copies-events.md) 与 CONTEXT.md「Session fork」）**：复制事件到分叉点，完全独立的新 Conversation；亲子关系仅为展示元数据。
- **目标行为（验收标准）**：
  1. 在任意历史 Turn 上可"从此处分叉"：产生独立新 Conversation，复制事件日志至分叉点（含权限/工具事件；重写 sequence 与幂等键；快照不复制）。
  2. 分叉会话经 Session resume 语义接入 agent（能力位支持 `session/load` 的 agent 恢复上下文；不支持者以导入语义冷启动并明示）。
  3. 两个会话在侧栏/看板可见其分叉关系（parent 标注，元数据 `forked_from_conversation_id + fork_point_turn`）。
  4. 分叉期间原会话若有在途 Turn，fork 被拒绝并提示（避免复制半成品 Turn）。
- **实施边界**：fork 是会话域操作：`crates/agents` + `conversation_service` + `crates/db`；**禁止**用"新会话 + 首条 prompt 塞历史文本"的假 fork；**禁止**跨会话复用幂等键（ADR-0005 后果条款）。
- **参考实现**：codeg `src-tauri/src/acp/fork.rs`（原子双行布局、防并发护栏）。

#### P1-5 部署形态 【已决策 2026-07-04：方案 B（本机 API 定位）；S】

- **决策**：web_service 正式定位为**"本机自动化 API"**（供脚本/快捷指令/本机集成调用），**不做**独立 server / 浏览器 UI / Docker（方案 A 不立项；未来重开需新决策 + 真实需求证据）。远程可达性由 IM 通道（P0-1）承担。
- **现状锚点**：[web_service.rs](../src-tauri/src/commands/web_service.rs)（:651 绑 127.0.0.1；仅会话 REST + SSE）。
- **执行内容（验收标准）**：
  1. 设置页与文档明确"仅本机"的定位描述（去掉任何"远程访问"暗示）。✅ 设置页文案已本机化（`WebServiceSettings.tsx`：仅回环、本地集成/自动化）。
  2. `docs/specs/codeg-alignment/08-server-deployment/`（requirements/design/tasks）已加"⛔ 已裁决不实施"横幅，避免后续 Agent 误把规格当待办。✅
  3. 保持 127.0.0.1 绑定不变；API 最小文档见 [local-automation-api.md](./local-automation-api.md)（端点清单 + token 获取方式）。✅
- **状态：已完成 2026-07-04（纯文档/定位，无代码风险）。**
- **防偏移**：**任何 Agent 不得实施方案 A 的任何组成部分**（独立二进制/静态托管/0.0.0.0/Docker）。

#### P1-6 桌面自更新 【M】

- **第一性依据**：分发效率决定迭代速度可达用户的速度；无 updater 的桌面产品每次发版都在流失用户。
- **现状锚点**：`tauri.conf.json` 无 updater 配置、Cargo 无 `tauri-plugin-updater`；仅 `check_app_release`（`system_maintenance.rs`）查 GitHub release。
- **目标行为（验收标准）**：
  1. 集成 `tauri-plugin-updater` + 签名密钥流程；设置页显示当前/最新版本、下载进度、"重启应用"按钮。
  2. 更新失败不损坏现安装（下载-校验-替换原子性由插件保证，验证覆盖 macOS + Windows）。
  3. 现有 `check_app_release` 徽标逻辑并入同一入口。
- **实施边界**：**禁止**自研下载替换逻辑；服务器侧更新/回滚仅在 P1-5 选 A 后另立项。

---

### P2 — 工作台深度（单位时长有效性）

#### P2-1 git stash 套件 【M】

- **现状锚点**：`crates/git/src/` 无任何 stash 实现（grep 阴性）。
- **目标行为**：`stash_push(message?, include_untracked)` / `list` / `apply` / `pop` / `drop` / `show` 进 `crates/git`（git2 优先，CLI 兜底与现有模式一致）；工作区 Git 面板增加 stash 区块（列表 + 各操作）；有未提交改动时切换分支/rebase 前提供"先 stash"引导。
- **验收**：脏工作区 stash → 切分支 → pop 全流程 UI 可完成；冲突时给出明确状态而非静默失败。
- **参考**：codeg `commands/folders.rs` git_stash_*、`app/stash/`。

#### P2-2 克隆入口 + remote 管理 【S】

- **现状锚点**：`clone_repository` 已在 [remote_ops.rs](../crates/git/src/remote_ops.rs) 实现但未注册命令；remotes 只读（`get_repo_remotes`）。
- **目标行为**：欢迎页/项目创建流增加"克隆仓库"（URL + 目标目录 + 进度）；repo 设置支持 remote add/remove/set-url。
- **验收**：从 URL 克隆到新项目并打开首个工作区一条龙完成。
- **防偏移**：克隆命令走 repos 域注册，复用现有实现；**禁止**重写克隆逻辑。

#### P2-3 多会话平铺对照 【M–L】

- **第一性依据**：PRODUCT.md 核心用例 *"comparing agent output"*；Dockview 已支持多编辑器组，缺的是"会话视图可多开"。
- **现状锚点**：`KanbanSessionConversationView` portal 単实例设计（`components/kanban/`）。
- **目标行为**：同项目下可同时打开 ≥2 个会话面板并排；各自独立滚动/输入/流式；活动会话有视觉标识。
- **验收**：两个不同 agent 的会话并排各自流式输出互不干扰；关闭一侧不影响另一侧。
- **防偏移**：这是前端视图多实例化改造 + `conversationStore` 多实例隔离；**禁止**为此在后端复制事件流通道（现有按 conversation 订阅已够）。

#### P2-4 编辑器选区 → 对话 【S–M】

- **目标行为**：文件查看器中选中代码 → 快捷键/按钮"加入对话"，composer 出现 `file.ts:10-25` 范围引用 chip（复用现有 file-reference WYSIWYG 节点，扩展行号范围）。
- **验收**：选区引用随消息发出后，agent 收到的 prompt 含正确路径+行号+代码内容。
- **参考**：codeg Monaco ⌘L "Add selection to chat" pill。

#### P2-5 托盘 / 单实例 / 深链 【M】

- **现状锚点**：`lib.rs:61-63` 仅 shell/fs/dialog 插件；`vibex://backup-progress` 是内部事件名而非 URL scheme。
- **目标行为**：
  1. `tauri-plugin-single-instance`：二次启动聚焦既有窗口。
  2. 托盘：关窗驻留（可设置）、菜单（显示/新会话/退出）；实现遵循可用的 `adding-tauri-system-tray` skill 指引。
  3. `vibex://` 深链：`vibex://session/<id>` 打开指定会话（IM 通知里可放跳转链）。
- **验收**：关窗后 agent 完成任务 → 桌面通知点击 → 窗口恢复并定位到该会话。
- **防偏移**：深链命名先查 CONTEXT.md 术语；**禁止**与内部事件名 `vibex://backup-progress` 混用命名空间（内部事件应改名或文档化区隔）。

#### P2-6 agent 覆盖 +3 与 per-agent 接入深度 【已决策 2026-07-04：整项移出计划】

- **决策**：不新增 agent（Kimi Code/CodeBuddy/Pi 不接入），per-agent 接入深度（Codex 设备码登录、OpenCode 插件入口）也不做；7 个 agent 维持现状。未来重开需新决策 + 需求证据。
- **已知悉并接受的风险**：Codex 登录体验（无设备码流）是现有用户的真实痛点，本决策一并搁置。
- **对执行 Agent 的指令**：本条为墓碑条目——**禁止**以"对齐 codeg agent 数量"为由重新立项。若做 P1-1 历史导入，范围同样只覆盖现有 7 个 agent kind。

#### P2-7 IM 通道持久化与审计 【M】

- **现状锚点**：通道配置在 DB，但无消息投递日志表（旧报告确认，仍有效）。
- **目标行为**：`chat_channel_message_log` 表（方向/通道/会话/状态/错误）；投递失败可见 + 手动重试；设置页显示最近投递记录。
- **验收**：断网发送 → 日志记 failed → 恢复后重试成功可见。

#### P2-8 应用级日志查看器 【S–M】

- **现状锚点**：仅进程输出（`ProcessLogsViewer`）与 dev server 日志；tracing 无 UI。
- **目标行为**：tracing 层加内存环形缓冲 + 级别持久化；设置页"日志"节：实时滚动、级别过滤、打开日志目录。
- **参考**：codeg `src-tauri/src/logging/` + `logs-settings.tsx`。

---

### P3 — 外壳打磨与品类决策项

#### P3-1 i18n 框架 【已决策 2026-07-04：双语目标，渐进式；XL（全量）/ 即刻仅纪律】

- **现状锚点**：无 i18n 框架，硬编码中文为主（~197/634 前端文件含 CJK）。
- **决策**：目标双语（zh-CN/en），渐进落地。**立即生效的只有一条纪律**（已并入 §4.0 第 3 条）：新增/改动代码的用户可见文案必须收敛到集中常量模块（前端按 feature 的 `strings.ts` 等价物；后端用户可见串集中于模块级常量），不再新增散落字符串——为未来接 react-i18next 留门，增量成本≈0。
- **全量执行（P0–P2 清空后启动）**：react-i18next + zh-CN/en；后端用户可见文案（IM 模板、恢复原因等）同步进资源体系。**禁止**机器翻译未审校上线；**禁止**在全量启动前就引入 i18n 框架半用不用（避免两套并存）。

#### P3-2 主题定制 + 全键位重绑 【M】

- 主题色板/界面缩放/等宽字体选择（token 体系内做，遵循 DESIGN.md 两层模型）；键位全量重绑 + 冲突检测 + 恢复默认（现有 `keyboard/registry.ts` 已是注册表结构，是好底子）。

#### P3-3 无项目纯聊天模式 【M】

- 允许创建不挂项目/工作区的 Conversation（无 worktree、无 git 面板）；入口在欢迎页。**先决**：CONTEXT.md 需为"无工作区会话"落术语（与 Workspace 关系）。

#### P3-4 备份加密 + 外部记录纳入 【S–M】

- backup_create 增加口令加密（age 或等价）；可选把外部 agent 历史目录（P1-1 的源）纳入备份；restore 时冲突扫描。参考 codeg `commands/backup/crypto.rs`。

#### P3-5 状态栏模块补齐 【S】

- StatusBar 增加：在途后台任务数、当前会话 token/上下文环、更新徽标（衔接 P1-6）、web 服务状态。

#### P3-6 Office 工作流 【已决策 2026-07-04：不做】

- 依选择性对齐基调裁定不跟进。留档理由：PRODUCT.md 定位（engineering cockpit）不含 Office；若未来推翻，走 codeg 同款外置 CLI 集成路线（officecli + watch 预览），不自研文档引擎。

#### P3-7 Project Boot 脚手架 【已决策 2026-07-04：不做完整版】

- 依选择性对齐基调降级为：克隆入口（P2-2）+ `$shadcn` 等提示词模板 + 文档。完整可视化 Boot 仅在未来用户数据支持时重开（规格 10 设计存量保留）。

#### P3-8 氛围层（宠物等）【已决策 2026-07-04：不做】

- 与品牌定位（"calm, inspectable, precise"，反参考"促销式 AI 仪表盘"）冲突。其功能内核——**可瞥视的 agent 状态外显**——由 P2-5 托盘徽标 + 桌面 toast 承接。

---

## 5. 决策门汇总（需产品拍板，Agent 不得自行启动）

| 决策 | 影响项 | 状态 |
|---|---|---|
| 战略基调：选择性对齐 / 全面对齐 / 自主路线 | 全局 | **已决策 2026-07-04：选择性对齐** |
| 部署形态：真 server（A）还是本机 API 定位（B）？ | P1-5，间接影响 P3-1 | **已决策 2026-07-04：B（本机 API；A 不立项）** |
| 目标市场含非中文用户吗？ | P3-1 优先级 | **已决策 2026-07-04：双语目标渐进式（纪律即刻生效，全量 P0–P2 后启动）** |
| IM 入站发送者鉴权？ | 新增 P0-0，P0-1 前置 | **已决策 2026-07-04：强制白名单 + 静默丢弃 + fail-closed** |
| Session fork 事件语义？ | P1-4 | **已决策 2026-07-04：复制事件到分叉点（ADR-0005）** |
| agent 覆盖 +3 与 per-agent 接入深度？ | P2-6 | **已决策 2026-07-04：整项移出（含 Codex 设备码登录，风险已知悉）** |
| 品类边界：纯编码还是含 Office？ | P3-6 | **已决策：纯编码，不做 Office** |
| 新项目冷启动是否核心场景？ | P3-7 | **已决策：降级方案（克隆 + 提示词模板）** |
| 氛围层要不要？ | P3-8 | **已决策：不做** |

## 6. 方法学与证据

- 5 个并行只读盘点 agent：codeg 后端（~250 命令/14 表/10 解析器全数枚举）、codeg 前端（页面/composer/设置/跨切面）、VibeX 后端（~330 命令/24+ 模型）、VibeX 前端（路由/会话 UI/设置/规划存根）、16 项对等探针（每项含证据路径）。
- 高影响结论第一手复核：stash 零实现、clone 未注册命令、docx 预览为正则抽取、`dispatch_command` 命令集、`parser_for` 注册表、web 服务绑定地址、`agent_capabilities` 静态表。
- 已知偏差修正：旧对比文档中 6 项"缺失"结论已过时（权限卡/委派卡/生成图片/feedback 卡/崩溃恢复/桌面通知）；本文不再沿用。
