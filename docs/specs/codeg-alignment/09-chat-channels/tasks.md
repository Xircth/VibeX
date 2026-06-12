# Tasks: Phase 9 — Chat Channels 接入

执行环境：worktree `../VibeX-chat-channels`，分支 `feature/chat-channels`。

- [ ] T9.1 数据模型与配置加密
  - Acceptance: channels、sender_contexts、message_logs 表；secret 字段进 keyring/
    server 回退存储；支持 Telegram、Lark、iLink provider。
  - Verify: migration check + secret 不落 DB 明文字段测试。
  - Files: `crates/db/migrations/*`, channel config models

- [ ] T9.2 Channel manager 生命周期
  - Acceptance: start/stop/restart、健康状态、重连退避、错误上报；应用退出优雅停止。
  - Verify: manager unit tests + fake provider。
  - Files: `src-tauri/src/chat_channel/manager.rs`

- [ ] T9.3 command_dispatcher
  - Acceptance: 支持命令文法、鉴权、sender 绑定、审计日志；未知命令/越权返回友好
    响应；不直接执行危险操作。
  - Verify: 表驱动 parser/authorization tests。
  - Files: `chat_channel/command_dispatcher.rs`

- [ ] T9.4 session_bridge
  - Acceptance: Agent/permission/delegation/git 事件格式化投递；外部回复能路由回正确
    会话；消息格式多语言预留。
  - Verify: formatter snapshot tests + fake channel roundtrip。
  - Files: `chat_channel/session_bridge.rs`, `message_formatter.rs`

- [ ] T9.5 Telegram provider
  - Acceptance: 长轮询或 webhook 方案明确；支持分片长消息、附件/图片基础处理、
    重连退避、命令回复。
  - Verify: stub HTTP tests + sandbox/真实 bot 冒烟（可手动）。
  - Files: `chat_channel/providers/telegram.rs`

- [ ] T9.6 Lark provider
  - Acceptance: WS/REST 接入、签名/鉴权、消息分片、按钮交互（审批）基础支持。
  - Verify: stub tests + 手动企业测试记录。
  - Files: `chat_channel/providers/lark.rs`

- [ ] T9.7 iLink / Weixin provider
  - Acceptance: 二维码登录、WS/REST、登录过期提示、基础文本命令与审批。
  - Verify: stub tests + 手动扫码冒烟。
  - Files: `chat_channel/providers/ilink.rs`, QR dialog

- [ ] T9.8 权限审批路由
  - Acceptance: Agent permission/question/delegation approval 能发送到绑定 sender；
    外部批准/拒绝回写 pending state；超时与重复点击幂等。
  - Verify: fixture e2e：外部批准权限后会话继续。
  - Files: permission bridge, sender context service

- [ ] T9.9 必达队列与消息日志
  - Acceptance: 发送失败进入队列；重试退避；用户可在设置页查看最近日志；不会无限
    堆积（上限/清理策略）。
  - Verify: fake provider fail/retry tests。
  - Files: `chat_channel/message_queue.rs`, log service, settings UI

- [ ] T9.10 日报 scheduler
  - Acceptance: 可配置每日摘要时间、项目/会话范围；生成任务状态/Git 变更/未决审批
    摘要；时区正确。
  - Verify: scheduler time tests + formatter snapshot。
  - Files: `chat_channel/daily_report.rs`

- [ ] T9.11 设置页 Chat Channels 分区
  - Acceptance: provider 列表、添加/编辑/删除、测试发送、事件订阅开关、命令权限、
    日报设置、消息日志；与 Phase 7 i18n/导航兼容。
  - Verify: component tests + 手动测试发送。
  - Files: `frontend/src/components/settings/chat-channel-settings.tsx`

- [ ] T9.12 真实/Stub 端到端冒烟
  - Acceptance: Telegram 至少真实冒烟一次；Lark/iLink 若无真实凭证则 stub e2e；
    审批、命令、通知三条链路均覆盖。
  - Verify: e2e record + tests。
  - Files: e2e fixtures/docs

- [ ] T9.13 五轴审查 → 修复 → 全门验证 → 合并
  - Acceptance: G6 traceability 项完成/裁剪记录齐全。
  - Verify: `pnpm run check`, `pnpm run lint`, `cargo test --workspace`,
    `cd frontend && pnpm vitest run`
