# Requirements: Phase 9 — Chat Channels 接入 (chat-channels)

## Objective

实现 Codeg 的 Chat Channels：把 Telegram、Lark（飞书）、iLink（企业微信）
接到编码 Agent——从聊天软件发起任务、收流式进展通知、远程审批权限、续跑
会话、接收日报。

对应差距：G6。前置：Phase 8（事件总线/服务器形态）、Phase 1（auto-approve
路由）。

## Acceptance Criteria (EARS)

1. THE SYSTEM SHALL 支持三类内置频道后端：Telegram（Bot API 长轮询）、Lark
   （WS + REST）、iLink（WS + REST），设置页可添加/配置/启停多个频道实例，
   凭证走 keyring（Phase 5 基建）。
2. WHEN 绑定用户在频道中发送新任务命令，THE SYSTEM SHALL 在指定项目/Agent
   下创建会话并开始执行，回传会话链接与进展摘要。
3. WHEN 会话产生权限请求且发起者来自频道，THE SYSTEM SHALL 把请求推送到该
   频道（含选项按钮），用户应答路由回会话；auto-approve 设置（per sender）
   生效（Codeg sender_context 语义）。
4. WHEN 会话 turn 完成/失败，THE SYSTEM SHALL 推送格式化摘要（工具调用数、
   diff 统计、耗时），消息格式多语言（接 Phase 7 i18n）。
5. THE SYSTEM SHALL 支持定时日报（按频道配置，汇总当日会话/提交）。
6. THE 频道身份 SHALL 与发起人绑定（sender_context），未授权发送者的命令被
   拒绝并审计记录。
7. IF 频道网络断开，THEN 自动重连退避，期间事件入队（上限+丢弃策略），恢复
   后补投关键事件（权限请求必达或过期标注）。

## Edge / Error Cases

- Telegram 消息长度限制：分片 + 折叠详情链接。
- 凭证失效：频道标记错误态 + 设置页诊断。
- 同一会话多个频道订阅：每频道独立投递，应答以先到为准，其余标记已处理。

## Boundaries

- Always：所有入站命令做发送者鉴权；出站消息不含敏感路径/token。
- Ask first：无。
- Never：在频道层实现会话业务逻辑（只做桥接与格式化）。

## Success Criteria

- Telegram 真实 bot 全链路冒烟（建任务→进展→权限审批→完成摘要）；Lark/iLink
  以协议 stub 测试覆盖；全门绿。
