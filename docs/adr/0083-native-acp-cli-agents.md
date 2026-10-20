---
status: proposed
date: 2026-10-20
decision-makers:
  - VibeX maintainers
---

# Kiro、Auggie、TRAE、Command Code 走现有 ACP 管线；ZCode 不接入

这四个 CLI 都有官方 ACP。它们作为内置 Agent 加入 `AgentKind` 与
`BuiltInProfileCatalog`，安装、鉴权、会话、取消和错误都走现有管线。ZCode
没有官方 ACP，不加入。

## 分发

- Auggie 与 Command Code 用 npm 托管安装，和 Qoder 一样。Command Code 在
  Windows 上探测 `command-code`、`cmdc`、`commandcode`，不探测裸 `cmd`。
- Kiro 只托管 Linux zip。macOS DMG 与 Windows MSI 不能被现有归档安装器解包，
  也不执行未签名的安装脚本。这两个平台仍列入可运行平台，以便 PATH 上的
  `kiro-cli` 能启动 `kiro-cli acp`。
- TRAE 的公开制品是单个二进制的 gzip。安装器增加通用的单文件 gzip 解压，
  不为 TRAE 单独写安装器，也不下载 `code_mode_host` 旁路文件。

## 鉴权

Kiro 同时有官方账号和 `KIRO_API_KEY`。选择账号时清掉 API Key。Auggie 的
`AUGMENT_SESSION_AUTH` 与 TRAE 的 `TRAECLI_PERSONAL_ACCESS_TOKEN` 是同一账号的
无浏览器令牌，不是另一套官方 API，因此不出现在 API Key 模式里。Command Code
的 BYOK 文件格式未核实，只提供官方登录。

## 不接入 ZCode

`zcode` 无参数进入 TUI，`app-server` 是它自己的协议。官方用法文档没有 ACP。
社区桥接会读本地配置并带来服务条款风险，不能塞进 ACP 会话管线。
