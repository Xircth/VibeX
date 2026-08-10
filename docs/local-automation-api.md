# VibeX 本机自动化 API

> 本文只描述桌面应用内嵌的 legacy loopback automation API：它默认监听
> `127.0.0.1:17891`，供同机脚本、快捷指令和编辑器集成调用。它不是 VibeX Remote
> Protocol，也不是 `vibex-server` 的部署说明。版本化远程协议见
> [Remote Protocol v1](protocol/v1/README.md)，Headless Host 见
> [Headless Server Deployment](deployment/headless-server.md)，远程产品化范围见
> [P0/P1 改进计划](plans/2026-08-09-remote-productization-p0-p1.md)。

VibeX 的远程访问不再由本文定义，也不只依赖 IM 通道。legacy API 与 Remote Protocol
必须保持不同的端口、认证、DTO 和生命周期，不能把下面的旧端点当作未版本化远程后门。

## 启用与鉴权

- 在 **设置 → Web 服务** 开启服务、设置端口（默认 `17891`）、生成访问 token。
- 服务只绑定回环地址 `127.0.0.1:<port>`；外部主机无法访问。
- 除 `/` 与 `/health` 外，所有 `/api/*` 请求都需带 token，二选一：
  - `Authorization: Bearer <token>`
  - `x-vibex-token: <token>`

## 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 服务标识 |
| GET | `/health` | 健康检查（无需 token）|
| GET | `/api/conversations` | 列出会话 |
| POST | `/api/conversations` | 创建会话 |
| GET | `/api/conversations/{id}/events` | 会话事件流（SSE）|
| POST | `/api/conversations/{id}/turns` | 发起一个回合（发送消息）|
| POST | `/api/conversations/{id}/permissions/{permission_id}` | 响应权限请求 |
| POST | `/api/conversations/{id}/cancel` | 取消在途回合 |

## 示例

```bash
TOKEN=<在设置页生成>
BASE=http://127.0.0.1:17891

# 列出会话
curl -s -H "x-vibex-token: $TOKEN" "$BASE/api/conversations"

# 向某会话发起一个回合
curl -s -X POST -H "x-vibex-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"运行测试并修复失败"}' \
  "$BASE/api/conversations/<conversation_id>/turns"
```

> 权威端点定义见 [web_service.rs](../src-tauri/src/commands/web_service.rs) 的 `router()`。
