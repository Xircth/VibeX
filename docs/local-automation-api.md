# VibeX 本机自动化 API

> **定位（2026-07-04 决策，方案 B）**：VibeX 的 web 服务是一个**仅本机**（`127.0.0.1`）的自动化控制 API，
> 供本机脚本、快捷指令、编辑器集成等调用。它**不是**远程/多用户部署形态——不提供浏览器 UI、不监听外部地址、
> 无 Docker。远程可达性由 IM 通道承担。

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
