# Traceability: Codeg 对齐差距追踪矩阵

本文档把 `docs/reviews/对比报告.md`、用户补充的 22 项前端会话 UI 差距，以及
对 `C:/Users/Administrator/Documents/Projects/codeg-main` 的源码勘察，映射到
`docs/specs/codeg-alignment` 的 Phase 与可验收任务。它是实施时的索引：任何后续
代码任务若找不到本表对应项，应先更新 spec，再实现。

## 关键假设

- VibeX 继续保持 Vite + React 18 + Tauri 2 架构；Codeg 的 Next.js 16/React 19
  作为能力参照，不作为本计划的框架迁移目标。
- Codeg 的 Apache-2.0 源码可作为移植参考；大段移植须保留出处标注。
- 所有会话渲染入口收口到 `frontend/src/components/NormalizedConversation/`，
  不再为 Kanban、IDE、导入会话各维护一套渲染实现。
- “对齐 Codeg”指能力、交互语义、稳定性、视觉质量对齐；底层库可在不降低能力
  的前提下选择 VibeX 生态中更合适的等价实现。

## 实施记录

- 2026-06-13 / Phase 1 T1.10：完成 Phase 1 五轴收口审查、修复与全门验证。审查中发现 `local-deployment` 测试专用 `sessions` schema 未同步 Phase 1 新列，导致 `cargo test --workspace` 的 stop/finalize 流程失败；已在 `crates/local-deployment/src/container.rs` 补 `external_session_id`/`agent_type` nullable 列并恢复全量 Rust 测试。收口记录见 `01-agent-session-core/phase1-closure-review.md`。验证：`pnpm run check`、`pnpm run lint`、`cargo test -p local-deployment --lib`、`cargo test --workspace`、`cd frontend && pnpm vitest run`、`pnpm run prepare-db:check`、`pnpm run generate-types:check`、`pnpm run backend:check`、`pnpm run backend:lint` 通过。
- 2026-06-13 / Phase 1 T1.9：完成七类 Agent 会话门的可重复 fixture gate 与本机探测记录。`crates/agents/tests/integration.rs` 通过隐藏 test driver 跑 ClaudeCode、Codex、OpenCode、Gemini、OpenClaw、Hermes、Cline，覆盖 connection/session 创建、流式输出、工具调用、可用命令、模式/配置、权限请求与应答、turn 完成、resume、取消和取消后再次发送。结果记录见 `01-agent-session-core/agent-gate-results.md`。验证：`cargo test -p agents --test integration`、`cargo test -p agents`、`pnpm run backend:check`、`pnpm run backend:lint` 通过。
- 2026-06-13 / Phase 1 T1.8：完成 Agent spawn env 合并与 ensure_session 去重收口。运行时设置中的 `env_json` 会解析为标量环境变量并随 `agent_connect`、`agent_resume_session`、workspace prompt 的 `ensure_session` 传入 runtime；spawn 环境按 registry 默认值 < DB 运行时配置 < 进程代理环境变量（`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 及小写形式）覆盖。`ensure_session` 新增 `(agent_type, working_dir, session_id)` 三元组锁，避免并发首发 prompt 建出重复 connection/session。验证：`cargo test -p agents manager`、`cargo test -p agents runtime`、`cargo test -p vibex commands::agents`、`pnpm run backend:check`、`pnpm run backend:lint` 通过。
- 2026-06-13 / Phase 1 T1.7：完成 registry 驱动的 Agent preflight。新增 `crates/agents/src/preflight.rs`，输出平台、Node/uv 前置条件、runtime launcher、adapter version、authentication、network 六类结构化 check item；`agent_preflight` 改为按 `AgentDistribution` 构造命令、解析七类 Agent、检测认证痕迹并转换为现有设置页 API。设置页新增完整诊断明细列表，保留运行态摘要与 npm fix 按钮。验证：`cargo test -p agents preflight`、`cargo test -p vibex agent_settings`、`cd frontend && pnpm vitest run src/pages/settings/AgentSettings.test.tsx`、`pnpm run generate-types:check`、`pnpm run frontend:check`、`pnpm run frontend:lint`、`pnpm run backend:check`、`pnpm run backend:lint` 通过；设置页手动冒烟由组件测试覆盖，未启动完整 Tauri shell。
- 2026-06-13 / Phase 1 T1.6：完成 SessionModes/ConfigOptions/AvailableCommands 运行时贯通。ACP `session/new` 与 `session/load` 初始响应会转为 `SessionModes`/`SessionConfigOptions` 事件；ACP `AvailableCommandsUpdate`、`CurrentModeUpdate`、`ConfigOptionUpdate` 通知会转为 VibeX 事件并进入前端 store。`AgentWorkbenchState` 新增按 scope 归约的 modes、config options、available commands，并支持从 runtime snapshot 事件日志恢复这些控制面状态。验证：`cargo test -p agents`、`cd frontend && pnpm vitest run src/features/agents/store.test.ts`、`pnpm run frontend:check`、`pnpm run frontend:lint`、`pnpm run backend:check` 通过。
- 2026-06-13 / Phase 1 T1.5：完成权限多选项与 auto-approve 决策器第一批落地。`AgentPermissionOption` 增补 ACP option kind，新增 `AgentAutoApproveMode` 与纯函数决策器；Agent settings 的 `auto_approve_mode` 进入 live connection，`allow_always` 优先选择持久 allow，`yolo` 选择第一个 allow 类选项，reject-only 请求保留人工确认；自动响应发出 `PermissionResponded(auto: true)`。权限请求同时写入 `agent_permissions` 与 `agent_pending_permissions`，响应按 `(session_id, request_id)` resolve，支持重启后 pending 查询恢复。验证：`cargo test -p agents permissions`、`cargo test -p db pending_permissions`、`pnpm run generate-types:check`、`pnpm run frontend:check`、`pnpm run backend:check`、`pnpm run backend:lint` 通过。
- 2026-06-13 / Phase 1 T1.4：完成显式 Agent session resume 管道。新增 manager `ResumeSession` 命令与 runtime `resume_session` 入口；ACP 初始化后按 `agent_capabilities.load_session` 尝试 `session/load`，失败或不支持时发 `SessionLoadFailed` 并回退 `session/new`，fallback 后的新 ACP session id 写回 runtime snapshot；新增 Tauri `agent_resume_session` 与前端 `agentsApi.resumeSession`。验证：`cargo test -p agents runtime`、`cargo test -p agents manager` 通过。
- 2026-06-13 / Phase 1 T1.3：完成 ACP spawn 健壮性第一批落地。`manager.rs` 对 initialize 握手增加 `VIBEX_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS` 可配置超时（默认 60s），保留最近 8KB stderr 并在超时错误中输出摘要；连接级异常会先发 `ConnectionStatusChanged(Failed)`，runtime 收到连接级 Error 后将关联 session 与 active/queued prompts 标记为 failed 并保留 transcript。验证：`cargo test -p agents manager`、`cargo test -p agents runtime` 通过。
- 2026-06-13 / Phase 1 T1.2：完成 Agent runtime 事件合同扩展。新增 `session_modes`、`mode_changed`、`session_config_options`、`config_changed`、`available_commands`、`session_load_failed`、`turn_completed`、`fork_supported`、`session_config_stale` 事件及 ts-rs 导出，保留既有 `prompt_finished.stop_reason` 合同；前端 content-part adapter 对新控制类事件提供 status 兜底。验证：`cargo test -p agents events`、`pnpm run generate-types:check`、`pnpm run frontend:check` 通过。
- 2026-06-13 / Phase 1 T1.1：完成 Agent session core 持久化地基。`sessions` 新增 `external_session_id`/`agent_type`，新增 `agent_pending_permissions` 表和 DB store 方法，`agent_setting` 增加 `auto_approve_mode`，并修复 `generate-types` 脚本使其稳定使用 `crates/db/.sqlx` 离线缓存。验证：`cargo test -p db`、`pnpm run prepare-db:check`、`pnpm run generate-types:check`、`pnpm run frontend:check`、`pnpm run backend:check` 通过。
- 2026-06-12 / Phase 2 T2.4：已完成 Shiki 代码高亮第一批落地。会话 Markdown 与文件预览均改为 Shiki token + React `<span>` 渲染；删除 `frontend/src/utils/syntax.ts` 的 Prism/DOMPurify HTML 高亮路径；移除 VibeX 前端对 `prismjs`、`@types/prismjs` 的直接依赖；新增 `frontend/src/utils/shikiHighlighter.ts` 作为统一高亮入口。验证：`pnpm run check`、`pnpm run lint`、70 个目标测试通过。
- 2026-06-12 / Phase 2 T2.5：已完成数学公式与 Mermaid 图表第一批落地。`Markdown.tsx` 接入 `remark-math` + `rehype-katex` + KaTeX CSS，并新增保护 fenced code/inline code 的 TeX delimiter normalizer；`MermaidDiagram.tsx` 通过动态 `import('mermaid')`、`securityLevel: 'strict'` 和 SVG data URL 渲染图表，错误态保留源码，不引入 `dangerouslySetInnerHTML`。验证：`Markdown.test.tsx` 20 条通过，相关回归 96 条通过，`pnpm run check`、`pnpm run lint` 通过。
- 2026-06-12 / Phase 2 T2.6：已完成会话 stick-to-bottom + 虚拟滚动第一批落地。`VirtualizedList` 改为 `@tanstack/react-virtual` 真实虚拟 rows，保留贴底自动跟随、用户上滚暂停和“回到消息底部”按钮；新增 `scrollToIndex` imperative API；上一条用户消息跳转改为虚拟锚点 + 用户消息索引；新增 1,000 条长会话 fixture。验证：`VirtualizedList.test.ts` 14 条、相关回归 97 条通过，`pnpm run check`、`pnpm run lint`、`pnpm run build` 通过；临时 Vite HTTP 冒烟 200。浏览器截图因本机缺少 Chrome executable 未执行。
- 2026-06-12 / Phase 0 T0.1-T0.3：已恢复基线验证。修复 Windows `prepare-db` SQLite URL，重新生成 SQLx 离线缓存；4 个 composer/会话测试均判定为断言过期并按新结构化 token / agent profile 契约更新；`pnpm run prepare-db:check`、`cargo test --workspace`、`cd frontend && pnpm vitest run` 通过。`CLAUDE.md`/`AGENTS.md` 删除按 Phase 0 约束保留为未提交用户态修改。
- 2026-06-12 / Phase 2 T2.6 回修：关闭审查发现的两个高严重度问题。`vite.config.ts` 为 Shiki/oniguruma/textmate 添加 `vendor-shiki` chunk；`VirtualizedList` 移除流式 patch 全量 `measure()`，补 `scrollMargin`、贴底二次校正和会话切换 at-bottom 重置。新增 Shiki 失败重试、文件预览语言映射、HTML 预览 DOMPurify 净化、Mermaid 成功态保留等中严重度回修。
- 2026-06-12 / Phase 2 T2.7-T2.8：新增 `adaptContentParts.ts` 与 `ContentPartsRenderer.tsx`，VibeX normalized entries、Phase 3 imported messages、Phase 6 agent events 均可转为 `AdaptedContentPart`；工具卡第一批覆盖命令、文件、搜索/web、通用 JSON，并恢复中文标签/安装脚本默认展开/非命令成功卡中性状态。验证：适配器 12 条、工具卡 9 条通过，`pnpm run check` 通过。

## 用户感知优先级矩阵

| 排序 | 功能类别                 | Codeg 参照                                              | VibeX 现状                                                                | Phase / Task                   | 验收焦点                                                                  |
| ---: | ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
|    1 | 流式 Markdown 渲染       | `src/components/ai-elements/message.tsx` (`streamdown`) | `react-markdown` 整块渲染                                                 | Phase 2 / T2.2-T2.4            | 流式 chunk 不闪烁、不整列重排；保留文件链接/图片/tag 引用能力             |
|    2 | 代码高亮质量             | `ai-elements/code-block.tsx` (`shiki`)                  | 已接入 Shiki token 渲染；直接 Prism/HTML 注入路径已移除                   | Phase 2 / T2.4                 | Shiki token 渲染、双主题、未知语言降级 text、无 `dangerouslySetInnerHTML` |
|    3 | Stick-to-Bottom 自动滚动 | `ai-elements/message-thread.tsx`                        | 已补齐贴底跟随、上滚暂停、回底按钮，并接入虚拟 rows                       | Phase 2 / T2.6                 | 贴底自动跟随；用户上滚后暂停；显示回到底部按钮                            |
|    4 | CJK 文字优化             | `@streamdown/cjk`                                       | 无                                                                        | Phase 2 / T2.2                 | 中文/日文/韩文断行、标点、软换行正确                                      |
|    5 | 数学公式                 | `@streamdown/math` + KaTeX                              | 已通过 ReactMarkdown fallback 接入 `remark-math` + `rehype-katex` + KaTeX | Phase 2 / T2.5                 | `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 正常渲染，代码区域不误转换       |
|    6 | Mermaid 图表             | `@streamdown/mermaid`                                   | 已通过 fenced-code renderer + 动态 `mermaid` import 接入                  | Phase 2 / T2.5                 | 懒加载、错误占位、源码保留、无 HTML 注入                                  |
|    7 | 消息虚拟滚动             | `message/virtualized-message-thread.tsx` (`virtua`)     | 已采用既有 `@tanstack/react-virtual` 等价实现，提供 `scrollToIndex`       | Phase 2 / T2.6                 | 1,000 条消息滚动流畅；流式增高不跳动                                      |
|    8 | Thinking 块高级展示      | `ai-elements/reasoning.tsx`                             | 基础折叠卡                                                                | Phase 2 / T2.8                 | 流式实时增长、耗时、自动收起、用户展开偏好保留                            |
|    9 | 多种工具卡片             | `message/agent-tool-call.tsx` 等                        | 单一工具卡                                                                | Phase 2 / T2.6-T2.7            | 命令、编辑、读取/搜索、计划、委托、提问、反馈、图片、goal 分型            |
|   10 | Diff 内联预览            | `diff/unified-diff-preview.tsx`                         | 切专项面板                                                                | Phase 2 / T2.7                 | apply_patch/edit 输出内联 unified diff，显示 +N/-N                        |
|   11 | 消息导航轨               | `message/conversation-message-nav.tsx`                  | 无                                                                        | Phase 2 / T2.9                 | 用户消息锚点、文件变更摘要、点击跳转                                      |
|   12 | Token/成本统计           | `message/turn-stats.tsx`、`live-turn-stats.tsx`         | 无                                                                        | Phase 1 + Phase 2 / T2.10      | Usage 事件贯通，显示模型、token、耗时、复制、回跳                         |
|   13 | 国际化                   | `next-intl` + `src/i18n/messages/*.json`                | 无框架                                                                    | Phase 7 / T7.1-T7.5            | 10 语包、缺键回退、硬编码中文扫描门                                       |
|   14 | 可变字体系统             | `@fontsource-variable/*`                                | 无                                                                        | Phase 7 / T7.8                 | UI/等宽字体独立选择，缩放和字体即时预览                                   |
|   15 | 自定义滚动条             | `overlayscrollbars`                                     | 原生滚动条                                                                | Phase 2 / T2.13                | 会话/侧栏滚动条一致且不破坏键盘滚动                                       |
|   16 | 命令面板                 | `cmdk`                                                  | 无                                                                        | Phase 2 / T2.11                | `/`、`@`、全局命令统一键盘语义                                            |
|   17 | 代理委托展示             | `delegation-status-card.tsx` 等                         | 缺失                                                                      | Phase 6 + Phase 2 / T2.6, T6.7 | 委托状态、子会话、取消、错误路径在消息流内可见                            |
|   18 | 计划卡片                 | `message/plan-card.tsx`                                 | 基础 plan 展示                                                            | Phase 2 / T2.6                 | 状态/优先级/流式计划更新规范化                                            |
|   19 | 生成图片卡片             | `generated-images-block.tsx`                            | 无                                                                        | Phase 2 / T2.6                 | 生成中/成功/失败、修订 prompt、缩略图与打开预览                           |
|   20 | 图片内联展示             | `user-image-attachments.tsx`                            | 弹窗展示为主                                                              | Phase 2 / T2.12                | 用户附件在消息内缩略展示，点击仍复用现有预览弹窗                          |
|   21 | XTerm ligatures          | `@xterm/addon-ligatures`                                | 无                                                                        | Phase 4 / T4.9                 | 等宽连字字体下终端连字生效，非连字字体不报错                              |
|   22 | 主题深度定制             | `appearance-provider.tsx`、`appearance-settings.tsx`    | 基础亮/暗模式                                                             | Phase 7 / T7.8                 | 主题色、缩放、字体、pre-runtime 偏好统一持久化                            |

## 后端与聚合能力矩阵

| 差距                  | Codeg 参照                                    | Phase / Task        | 验收焦点                                                        |
| --------------------- | --------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| 7 类 Agent 历史解析器 | `src-tauri/src/parsers/*`                     | Phase 3 / T3.1-T3.5 | Claude/Codex/OpenCode/Gemini/Cline/Hermes/OpenClaw fixture 全绿 |
| 统一会话模型          | `models/conversation.rs`, `models/message.rs` | Phase 3 / T3.1      | `ConversationSummary/Detail/Turn/ContentBlock/Stats` 等价模型   |
| 导入去重与标题锁      | `db/service/import_service.rs`                | Phase 3 / T3.7      | 三连导幂等、软删除不复活、用户改名不覆盖                        |
| 项目路径匹配          | `path_eq_for_matching`                        | Phase 3 / T3.2      | Windows/UNC/大小写/尾斜杠/中文路径表驱动测试                    |
| 会话恢复与事件面      | `acp/connection.rs`, `acp/types.rs`           | Phase 1 / T1.2-T1.6 | 31 类事件、session/load、权限多选、AvailableCommands            |
| 多 Agent 委托         | `acp/delegation/*`, `bin/codeg_mcp.rs`        | Phase 6 / T6.1-T6.9 | sidecar、broker、spawner、UI、取消级联、权限链路                |

## 产品化能力矩阵

| 差距                 | Codeg 参照                                         | Phase / Task           | 验收焦点                                    |
| -------------------- | -------------------------------------------------- | ---------------------- | ------------------------------------------- |
| 设置分区 13 化       | `src/app/settings/*`                               | Phase 5/7/8/9/10       | 分区稳定深链，跨 Phase 挂载不重复           |
| 网络代理             | `network/proxy.rs`, `system-network-settings.tsx`  | Phase 7 / T7.6         | 6 种 env 形式、Agent spawn 注入、连通性验证 |
| Git 账户与 keyring   | `version-control-settings.tsx`, `keyring_store.rs` | Phase 5 / T5.6-T5.8    | 多账户、token 验证、GIT_ASKPASS             |
| Web 服务模式         | `bin/codeg_server.rs`, `web/*`                     | Phase 8 / T8.1-T8.10   | Axum、token、WS、transport、Docker、回滚    |
| Chat Channels        | `chat_channel/*`                                   | Phase 9 / T9.1-T9.9    | Telegram/Lark/iLink、审批、必达队列、日报   |
| Project Boot         | `app/project-boot/*`, `commands/project_boot.rs`   | Phase 10 / T10.1-T10.4 | 模板、预览、脚手架执行、入库打开项目        |
| 文档与 README 多语言 | `docs/readme/*`                                    | Phase 7 / T7.11        | en 主文、zh-CN 翻译、其他语言目录结构       |

## 全局 Definition of Done

- 规格更新先于实现：新增/裁剪任何功能必须先改对应 Phase 的
  `requirements.md`、`design.md` 或 `tasks.md`。
- 每个任务必须包含 Acceptance、Verify、Files；没有验证命令的任务必须说明人工
  冒烟路径。
- 依赖新增必须记录在对应 `design.md` 的“新依赖”表，并说明为什么不能复用既有
  依赖。
- 前端完成必须同时满足：单元/组件测试、`pnpm run frontend:check`、
  `pnpm run frontend:lint`、必要时 `pnpm run frontend:build`、关键桌面截图/冒烟。
- 后端完成必须同时满足：迁移可重放、`pnpm run prepare-db:check`、`pnpm run
generate-types:check`、`cargo test --workspace` 或受影响 crate 的最小测试集。
- Codeg 参照代码如果大段移植，文件头或模块注释必须保留出处和许可证说明。
