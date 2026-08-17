# 聊天通道与远程访问 CodeG 对标实施计划

**状态：** 决策完成，在 `feat/host-family-distribution` 落地。

**日期：** 2026-08-17。

**决策依据：** [ADR-0056](../adr/0056-chat-channel-and-remote-access-codeg-parity.md)、
[ADR-0054](../adr/0054-host-family-distribution-and-client-surfaces.md)。

**完成标准：** 两条用户路径真实可走完，有测试覆盖关键分支。没有
「UI 有开关、进程没听」「命令写了 help、执行是空字符串」的残缺实现。

## P0 — 远程访问可用

- [x] `start_web_server` 按 `allow_lan` 绑定 `127.0.0.1` 或 `0.0.0.0`
- [x] 状态返回全部可达 `http://` 地址；默认端口 3080
- [x] 注入 frontend `dist` / `VIBEX_STATIC_ROOT`，浏览器打开即 UI
- [x] Host 管理员 token 走 `SqliteTokenHashStore`；生成/复制/显示隐藏
- [x] 桌面设置可创建 Workstation / Companion 配对二维码
- [x] 端口占用自动探测；配置自动保存
- [x] 启动路径使用 `ServerRuntime`，不再把薄 REST 当产品入口

## P1 — IM 工作闭环

- [x] Host 命令：`folder` `agent` `task` `sessions` `resume` `cancel`
      `approve` `deny` `search` `today` `status` `help` `ping`，以及已选
      会话上的无前缀 follow-up
- [x] 权限出站后可用 IM `/approve` `/deny` 互斥答复
- [x] 连接态投影到设置页状态灯
- [x] Telegram inline 按钮（folder/agent/approve）+ callback_query
- [x] 设置页：状态灯、命令目录
- [x] IM 命令与设置页中英（出站卡片仍待全面 i18n）

## P2 — 超过 CodeG 的渠道深度

- [x] Telegram Topic 模式（总题忽略纯文本；一题一会话键）
- [x] 微信 iLink 扫码入站（企业微信群机器人仍可出站）
- [x] 每通道日报（按配置时刻发送）
- [x] 独立事件 Webhook 投递入口（`post_event_webhooks`）
- [x] 设置页独立 Webhook 编辑与 IM 出站中英切换

## 验证

```bash
cargo test -p server --lib chat_inbound
cargo test -p server --lib web_service
cd frontend && pnpm exec vitest run src/pages/settings/ChatChannelSettings.test.tsx src/pages/settings/WebServiceSettings.test.tsx
```
