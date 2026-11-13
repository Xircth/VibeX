# Agent 运行状态与异常提示交付记录

## 已确认根因与修复

- 空 assistant 占位行的 `streaming` 是回合投影事实，并不是模型生成事实。原 LiveTurnStats 固定写“生成中”；现在默认等待 Agent，并使用统一请求活动选择器区分响应、思考、工具、用户交互和取消。
- 连接订阅原来只及时处理 connecting。现在 recovering、failed、disconnected 同步关闭发送闸、停止 keepalive；ACP initialize Ready 不代表会话绑定 Ready。
- `status_message` 在 Conversation 转换时丢失；现在保留脱敏、有界原因。重连进度和错误诊断分别保留，连接绑定真正完成后才清除恢复提示。
- 旧 bind Promise 可能在连接异常后重新开闸，旧失败也可能覆盖新成功。现在使用 slot identity、连接 ID、退役连接集合及 bind generation 校验成功与失败，sequence 只在同一连接内比较。
- 原 silent-turn recovery 与 live-prompt recovery 可能重新执行已发送 Prompt，即使尚无可见输出也可能重复副作用。已移除这些自动重发路径；连接准备重试保留，原 Prompt 失败或中断后仅允许用户主动重试。
- 任意 Agent 文本曾进入专用通知解析。现在 Codex/Pi 固定输出契约限定在对应适配器，未知 Agent 不使用这些解析器；stderr 不作为请求活动输入。
- 工具 partial update 的缺失 status 曾可能重新打开已完成工具。现在省略 status 保持原事实，不重置请求阶段，不把完成工具重新加入看门狗豁免集合。
- Host 启动恢复原来可能遗漏 binding-ready 后的连接。现在清理所有持久存留的活动连接状态，不批量启动历史会话。事件幂等键包含连接 ID，避免进程内序号重置造成新事实被旧事实去重。

## 两个维度及事实归属

连接维度沿现有连接管理器、session/new/load/resume 与 SessionBindReady 建立：connecting（宿主不能可靠细分的启动/握手合并）、ready 且 bound=false（创建或恢复会话）、ready 且 bound=true（可发送）、recovering、error、closed。不会把 initialize 成功当作可发送。

请求维度以持久 UserTurnCreated/Queued/Started、实际发送 Prompt 前的 WaitingAgent、真实内容/思考/工具/权限/提问事件、适配器重试事件和回合终态为依据。工具与用户交互使用已有合并行的事实确定当前阻塞优先级，取消和终态优先；不把在途回合或健康 ACP 解释为模型生成。当前没有足够明确的通用模型请求开始事件时，不主动显示 WaitingModel。

公共契约是 `RequestActivity`、`RequestRetry`、`ConversationRequestStatus` 和 `ConversationConnectionStatus`。边界转换在 agents；Runtime 校验连接与 prompt、生成有意义的活动更新；Conversation recorder 绑定准确 turn 并写现有事件日志；投影用稳定 side row `status:agent-connection` / `status:agent-request` 保存可重建快照。没有新增独立持久状态库或前端按 Agent 名称分支。桌面和远程仍共用同一个 recorder、事件与 row-op 订阅。

关联包含 connection ID、turn ID、可获得的 prompt ID、宿主事件序号；Codex AIR 另外按 incident/revision 去重。已终态请求不再接受活动；取消握手期间不回退成响应；已知旧连接、旧 prompt、旧 incident 或重复 revision 被拒绝。

## 全 Agent 能力矩阵

所有下列入口都具备相同基础能力：宿主进程/ACP 连接生命周期、实际绑定就绪、发送前排队、等待 Agent、有效内容/思考、工具、用户交互、回合终态、取消请求及现有取消握手。取消确认由 ACP Prompt 终止响应或现有超时退役规则确定，不把发出 cancel 通知等同确认。

“未知”表示本次检查的 ACP 契约没有提供该模型 API 事实，绝不表示上游不会重试。默认展示等待 Agent、阶段时长及取消；最终失败显示现有类型化错误及恢复动作。原生 CLI 的内部 API/RPC 有进度，不代表其 ACP 输出也有。

| Agent / 接入方式 | 模型重试的额外真实来源 | 次数 / 上限 / 等待 | 原因 / 错误码 |
| --- | --- | --- | --- |
| Claude Code / claude-code-acp 0.94.0 | `_claude/sdkMessage` 的 SDK `system.api_retry`（SDK 0.3.22 形状 fixture） | 事件可选字段直接保留 | `error` / `error_status`，缺失未知 |
| Codex / codex-acp 2.2.2 | session_info_update 的 JetBrains AIR v1 warning sessionFailure；兼容 codex.error.willRetry | 未提供，全部未知；revision 不是次数 | title；错误码未知；支持恢复后第二个 incident |
| Pi / pi-acp 0.0.34 | 适配器完整、未带 messageId 的固定 `Retrying (attempt N/M, waiting Ss)...` 和 `Retry finished, resuming.` | 精确匹配 N/M；S 是上游取整秒；fallback 均未知 | 固定输出未提供，未知 |
| Antigravity / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| OpenClaw / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| OpenCode / 原生 ACP | ACP 路径未接入 native RPC 的 retry scheduled | 未知 | 最终 ACP 错误 |
| Cline / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| Hermes Agent / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| CodeBuddy / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| Kimi Code / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| Grok / 原生 ACP | 原有专用模型/usage 通知不解释成 API 进度 | 未知 | 最终 ACP 错误 |
| Cursor / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| DeepSeek Harness / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| MiMo Code / 原生 ACP | 走同一公共运行时，不要求 AgentKind 枚举成员 | 未知 | 最终 ACP 错误 |
| Qoder / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| Kiro CLI / 原生 ACP | 原有模型/推理配置扩展不解释成 API 进度 | 未知 | 最终 ACP 错误 |
| Auggie / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| TRAE CLI / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| Command Code / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| ZCode / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| OMP / 原生 ACP | 未接入额外模型重试契约 | 未知 | 最终 ACP 错误 |
| Registry `mistral-vibe` | Vibe 2.25.5 `_session/retrying` 固定扩展 | 未提供，全部未知 | detail；category 只验证契约，不从文本猜分类 |
| 其他 Registry Agent | 统一标准 ACP 生命周期与活动 | 未知 | 最终 ACP 错误与可用诊断 |
| 用户声明的 ACP Agent | 同一公共路径；不按名称猜已知 vendor | 未知 | 最终 ACP 错误与可用诊断 |
| QaMock / 测试 ACP | fixture 的标准协议事件 | 由 fixture 明确给出 | 由 fixture 明确给出 |

## 等待、恢复和操作

- 连接阶段与请求阶段各有真实起始时间；首响应等待或输出停滞超过 30 秒显示提示。30 秒是提示门槛，不判失败；心跳、usage 和无关通知不刷新请求活动。
- 保留现有 600 秒 ACP 空闲看门狗作为传输保护，并豁免真正运行中的工具、权限与提问等待；没有简单缩短全局超时。未知状态不被宣称为模型连接成功或正在重试。
- 明确 retry 在同一状态行更新次数、原因和倒计时，缺失值不显示；内容进展或明确恢复通知退出 retry，终态停止计时。
- 可取消当前请求/连接准备；取消中不再提供重复取消。断开/连接失败提供重新连接。失败、中断或取消提供主动重试，复用现有消息重发与 checkpoint 流程；没有自动执行 Prompt。
- 类型化认证、会话丢失和配置失败仍走已有 TurnErrorCard / SessionNoticeActions。未知错误保留原因为可展开、可复制内容，不把未知错误导向某个猜测的配置操作。
- 当前事实不允许手动 dismiss；旧回合错误通过当前请求 turn 过滤。连接原因和重连进度可以同时存在。

## 参考与界面证据

研究基准是 [t3code e0d6aadb](https://github.com/pingdotgg/t3code/tree/e0d6aadb88d229746be9503c510baaccbad84f4f)（2026-11-12）。借鉴的是 session 与 runtime diagnostics 分开、保留 retry counts/delay/reason、成功清除 retry、最终失败停止等待。`apps/web/src/session-logic.ts`、`packages/provider-pi/src/server/adapter.ts`、`packages/provider-opencode/src/server/v2/adapter.ts` 和 `packages/provider-acp-registry/src/server/adapter.ts` 明确展示 native 与 ACP 信息能力差异。本次没有替换 VibeX 的 ACP 接入协议。

以下是实际 React 组件与项目 CSS 的浏览器渲染 fixture，包含等待、重试、重连、失败、取消；不是有真实凭证的 Provider E2E：

- [中文状态](../evidence/agent-runtime-status-zh.png)
- [English states](../evidence/agent-runtime-status-en.png)
- [390px 窄屏展开原因和操作](../evidence/agent-runtime-status-details-mobile.png)，检查无横向溢出。

## 验证与限制

已先建立失败测试再修复发送闸、旧 bind Promise、Host 重启、Codex 第二次 incident、工具 partial patch。真实子进程 fixture 先落盘副作用再无输出退出，验证一次副作用、失败终态且不会自动重发。每种新增 adapter 映射均有真实协议形状 fixture；Codex 另有完整 ACP bridge fixture。

最终执行结果见本文末尾验证记录。未使用各家真实账户执行认证/配额耗尽/网络断流测试；没有声称所有真实 Provider 都经过线上 E2E。标准 ACP v1 内容更新以及部分 vendor 重试通知没有上游 prompt/attempt ID；宿主可以拒绝已知旧连接/回合，但不能识别所有在同一 ACP session 内、缺少关联 ID 的未知迟到通知。Codex incident ledger 有界保留 128 项；没有全局任意文本或 stderr 关键词状态推断。

真实耗时仅说明阶段未观察到进展，不证明模型服务失效。后台工具与用户交互仍可并发，界面显示当前主要阻塞；上游没有明确模型请求事件时继续显示等待 Agent。

### 验证记录

| 检查 | 结果 |
| --- | --- |
| `cargo test -p agents --lib --no-fail-fast` | 893 passed |
| `cargo test -p conversations --lib --no-fail-fast` | 469 passed，1 ignored；之后连接 ID 幂等键/prompt 关联改动再运行 recorder 36 项全通过 |
| `cargo test -p conversations --lib runtime_events::tests::` | 最终串行 36 passed，包括新连接低序号不去重、旧 prompt 不串回合 |
| `cargo test -p agents --test management_fixture silent_process_death_never_replays` | 1 passed：真实子进程副作用只发生一次 |
| `cargo test -p agents --lib vendor_request_activity` | 最终 6 passed |
| `cargo test -p agents --lib codex_retry` | 最终 2 passed，含 bridge revision、第二个 incident 和工具元数据更新 |
| 前端五个相关测试文件 | 70 passed；之后新增 reconnect 不显示旧输出，selector 最终 6/6 passed（合计 71 个相关测试）；组件收尾 3/3 再通过 |
| `cargo clippy -p agents -p conversations --all-targets -- -D warnings` | 通过，包含最终 recorder 关联改动 |
| ESLint / Prettier / `git diff --check` | 本次修改文件通过；Git 仅有原工作区 CRLF 提示 |
| `pnpm exec tsc --noEmit` | 最终通过；中间轮次曾受未完成的并行画布改动影响 |
| 类型生成 | 已执行 generate-types，`shared/types.ts` 由生成器产出，未手改 |
| 视觉验证 | 中英文与窄屏截图已检查，390px 无横向溢出 |

中间类型检查中的无关错误来自同时变化的画布文件：`SessionCanvasDock.tsx` 的重复 `Bot` 导入、`useCanvasNodeContextMenu.tsx` 的重复对象字段；较早一轮是 `requestCreateSession.test.ts` 的 controller 新字段尚未完成。这些并行工作随后完成，最终类型检查通过；本任务没有覆盖它们。Vitest 有一条既有 flush-window 用例的 React `act` 警告；相关断言通过。

最后一轮 recorder 并行测试中，既有 streaming cache 性能断言出现一次不稳定失败（期望一次 lookup，实际四次）：它观察进程全局 `ACTIVE_TURN_MUTATION_EPOCH`，其它测试修改活动回合会正常使缓存失效。随后使用 `--test-threads=1` 验证全部 36 项通过；没有修改生产缓存语义或放宽测试断言。

Tabbit CLI 创建页面失败（task-scoped CDP 无法分发），因此截图改用项目 Playwright 的 headless Edge。Tabbit 任务随后已过期（finish 返回 unknown task）；没有获得或修改用户浏览器标签。临时 fixture 页面、截图脚本和 Vite 服务均已清理/停止，保留上述截图产物。
