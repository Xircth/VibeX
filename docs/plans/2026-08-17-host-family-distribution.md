# Host 家族分发实施计划

**状态：** 决策完成；P0 在 `feat/host-family-distribution` 落地。

**日期：** 2026-08-17。

**决策依据：**

- [ADR-0054：Host 家族分发与三种客户端表面](../adr/0054-host-family-distribution-and-client-surfaces.md)
- [ADR-0055：官方产品 MCP 随 Host 分发、由官方插件激活](../adr/0055-official-product-mcp-activation.md)
- [ADR-0033](../adr/0033-shared-application-core-and-versioned-remote-transport.md)
- [ADR-0041](../adr/0041-native-kotlin-compose-android-companion.md)
- [ADR-0046](../adr/0046-full-stack-plugin-platform-and-isolated-sdk.md)

**本阶段不做：** Apple Developer ID、公证、Windows Authenticode。桌面安装包可
以未身份签名发布；Server 家族用 SHA-256，有 updater 私钥时再附 minisign。

## P0 — 本切片

完成标准：一个版本可以打出 Server 家族目录；配对能按 Workstation / Companion
展开 scopes；`vibex-mcp` 只在 `vibex.collaboration` 启用后注入。

- [x] ADR-0054 / ADR-0055 与本计划
- [x] `DevicePermissionPreset` 与配对展开
- [x] `vibex.collaboration` builtin 插件
- [x] 官方 MCP 门接入桌面与 `vibex-server` injector
- [x] `scripts/package-host-family.js` 与无身份证书的 Host 家族 workflow
- [x] CONTEXT / README / headless 部署文档

## P1

- [x] Chat inbound 由 Host 启动（`server::start_chat_inbound`），`vibex-server` 可收 Telegram
- [x] `vibex.workflow-creator` builtin，启用后注入 `vibex-workflow-mcp`
- [x] Companion 契约与 Android 产品目录（preset 已在配对测试中锁定）
- [x] 桌面远程访问启动 `ServerRuntime`（Remote Protocol），不再用平行 REST/SSE 业务面
- [x] `host_application_core` 供桌面远程监听与 `HeadlessServer` 共用

## P2

- [x] Workstation 通过同一 Application Core 获得 plugin/workflow/automation 命令
- [x] Docker / Compose，默认 loopback
- [x] Host 原地升级：校验 SHA-256，快照数据目录，再替换兄弟二进制
- [x] `npx vibex` 明确为 Host family `vibex-server` 启动器

## 验证

P0：

```bash
cargo test -p remote-protocol
cargo test -p server device_pairing
cargo test -p plugins bundled_collaboration
cargo test -p server --lib
# desktop injector
cargo test -p vibex companion_injection
node --test scripts/package-host-family.test.js
```
