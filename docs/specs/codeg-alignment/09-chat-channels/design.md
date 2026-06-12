# Design: Phase 9 — Chat Channels 接入

## 所属层

- 新模块：`crates/services/src/chat_channel/`（manager、backends/{telegram,
  lark,ilink}、command_dispatcher、session_bridge、message_formatter、
  scheduler、event_subscriber）
- 存储：`chat_channels`、`chat_channel_sender_contexts` 表
- 命令面 + 设置页分区「聊天频道」

## 参照实现（Codeg）

`src-tauri/src/chat_channel/*`（20+ 文件）整体结构移植：manager 生命周期、
command_dispatcher 命令文法、session_bridge 双向桥、message_formatter 多语言
格式化、scheduler 日报、sender_context auto-approve。后端协议实现
（telegram.rs/lark.rs/weixin.rs→ilink）按 VibeX HTTP 客户端工厂（Phase 7
代理）适配。

## 要点

1. 事件来源：订阅 Phase 8 EventSink 广播（频道模块是普通订阅者，不侵入
   runtime）。
2. 命令文法对齐 Codeg：/new、/resume、/approve、/status 等（i18n 化帮助文本）。
3. 退避重连 + 关键事件必达队列（权限请求持久化，重启恢复——复用 Phase 1
   pending permissions 表）。

## 新依赖

`teloxide-core` 或裸 reqwest 实现 Bot API（倾向裸 reqwest，依赖面小，Codeg
亦为自实现）；Lark/iLink 为 WS+REST 自实现（tokio-tungstenite）。

## 测试策略

- dispatcher：命令解析/鉴权表驱动。
- backends：HTTP/WS stub 服务器回放协议样本。
- bridge：事件→消息格式化快照（多语言）。
- scheduler：时间注入测试。

## 风险

- iLink/Lark 协议文档可得性：以 Codeg 实现为协议参照。
- 长轮询在代理环境：走统一 HTTP 工厂。
