---
status: proposed
date: 2026-10-21
decision-makers:
  - VibeX maintainers
---

# Kiro、Auggie、TRAE、Command Code 与 ZCode 走现有 ACP 管线

Kiro、Auggie、TRAE 与 Command Code 有官方 ACP。ZCode 没有官方 ACP，会话经固定
版本的社区桥 `zcode-acp-server@0.72.0` 接入，启动参数是 `server`。五者都进入
`AgentKind` 与 `BuiltInProfileCatalog`。安装、鉴权、会话、取消和错误走现有
管线。不实现 `app-server` 客户端，也不复制凭据。

## 分发

- Auggie 与 Command Code 用 npm 托管安装，和 Qoder 一样。Command Code 在
  Windows 上探测 `command-code`、`cmdc`、`commandcode`，不探测裸 `cmd`。
- Kiro 只托管 Linux zip。macOS DMG 与 Windows MSI 不能被现有归档安装器解包，
  也不执行未签名的安装脚本。这两个平台仍列入可运行平台，以便 PATH 上的
  `kiro-cli` 能启动 `kiro-cli acp`。
- TRAE 的公开制品是单个二进制的 gzip。安装器增加通用的单文件 gzip 解压，
  不为 TRAE 单独写安装器，也不下载 `code_mode_host` 旁路文件。
- ZCode 的桥用 npm 托管安装。官方 ZCode 运行时单独发现：桌面安装包里的
  `zcode.cjs`，否则 PATH 上的 `zcode`。桥的启动文件必须解析到 JavaScript
  入口，再由已验证的 Node.js 22（含 `node:sqlite`）执行。不把裸 `zcode` 当作
  ACP 程序，也不探测不带 `server` 的桥。

## 鉴权

Kiro 同时有官方账号和 `KIRO_API_KEY`。选择账号时清掉 API Key。Auggie 的
`AUGMENT_SESSION_AUTH` 与 TRAE 的 `TRAECLI_PERSONAL_ACCESS_TOKEN` 是同一账号的
无浏览器令牌，不是另一套官方 API，因此不出现在 API Key 模式里。Command Code
的 BYOK 文件格式未核实，只提供官方登录。ZCode 只提供官方订阅模式。登录留在
官方 ZCode。没有核实过的无浏览器令牌，也不发明登录命令。Start Plan 的桌面
验证码不在这里完成。

## 会话

ZCode 的 `session/new` 只是占位。新建会话在第一条 prompt 之前确认 `mode`，
即使用户没有改选择，也发送 `session/set_config_option`。已保存且仍被通告的
模式优先，否则用 `build`。确认超过 60 秒、模式未被通告或应答与请求不一致时，
会话失败并且不发送 prompt。恢复与加载不重复这个确认。不设置进程级
`ZCODE_ACP_MODE`。

Fork、附件和原生历史格式未核实。能力跟随 ACP 通告。不扫描 ZCode 的 SQLite。
macOS 与 Linux 的官方运行时发现尚未在本机执行；Windows 发现逻辑已移植，但没有
对真实安装跑过会话。
