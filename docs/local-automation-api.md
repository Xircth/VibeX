# VibeX 本机自动化 API

设置页「Web 服务」启动的是 Remote Protocol 的 `ServerRuntime`，并托管与 Host
家族相同的前端。平行的薄 REST（`/api/conversations`、SSE 事件流、回合/权限/取消）
已随 [ADR-0056](adr/0056-chat-channel-and-remote-access-codeg-parity.md) 从启动路径删除，
不再作为产品入口。

同机脚本、快捷指令和编辑器集成应使用版本化远程协议，而不是下面这些已移除端点：

| 已移除 | 替代 |
|---|---|
| `GET /`、`GET /health` | `GET /health`（`ServerRuntime`） |
| `GET/POST /api/conversations` | Remote Protocol conversation commands |
| `GET /api/conversations/{id}/events` | durable attach / WebSocket |
| `POST /api/conversations/{id}/turns` | conversation start-turn command |
| `POST /api/conversations/{id}/permissions/{permission_id}` | conversation permission command |
| `POST /api/conversations/{id}/cancel` | conversation cancel command |

- Remote Protocol：[v1](protocol/v1/README.md)
- Headless Host：[Headless Server Deployment](deployment/headless-server.md)
- 桌面启动与绑定：[ADR-0056](adr/0056-chat-channel-and-remote-access-codeg-parity.md)
