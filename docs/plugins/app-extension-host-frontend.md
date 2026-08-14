# Frontend App Extension Host

本文档记录 `/plugins` 自定义 App surface 的当前 Full Trust contract。ADR-0046 已取代早期的
opaque-origin/CSP/sandbox 权限设计。

## Surface descriptor

`AppSurfaceHost` 只消费 Contribution Registry 中的 `app_surface` descriptor。前端不接收 package
绝对路径；`plugin_surface_open` 根据 plugin、surface 与 generation 从已发布 package 读取入口。

```json
{
  "pluginId": "acme.dashboard",
  "id": "project-health",
  "generation": 8,
  "metadata": {
    "slot": "plugin.detail.panel",
    "appEntrypoint": "app",
    "route": "/dashboard",
    "handler": "surface.createSession"
  }
}
```

## Full Trust document

Host 使用 `srcdoc` 作为 mount 容器，但不设置 iframe `sandbox`、CSP 或 Permissions Policy。插件可
加载外部或包内脚本/样式/媒体、访问网络、使用浏览器 API，并在同一用户权限下运行。iframe 的目的
是提供独立 DOM 与可撤销 lifecycle，不是隔离恶意代码。

bootstrap 使用一次性 `MessagePort` 提供可选的结构化 Host bridge。消息仍校验 protocol、mount
token、严格 sequence、request ID、有限 JSON 和 method 名，避免 stale generation、重复响应或错误
payload 破坏生命周期。插件在 Full Trust 下可以绕过 bridge，因此这些校验不是安全授权。

## 生命周期

以下事件关闭本地 port、撤销 Host session 并卸载 iframe：

- component unmount 或 plugin disable；
- contribution generation、plugin identity 或 surface identity 变化；
- document load failure、bridge protocol error 或显式 revoke。

失败只替换当前 surface 为错误面并允许重试，不影响插件详情或主应用。theme、locale、direction、
reduced-motion 与可访问名称通过 bootstrap context/bridge 同步；Escape 可请求把焦点退回 Host。

## Transport

Desktop 与 Remote 共用 `AppSurfaceHostTransport`：

- `plugin_surface_open`：创建 generation-bound session 并返回 document；
- `plugin_surface_invoke`：调用同 generation Worker handler；
- `plugin_surface_revoke`：释放 session。

当前文档上限为 2 MiB。后续多文件 package asset 应使用 generation-bound asset URL，而不是把 Host
文件路径暴露给前端。
