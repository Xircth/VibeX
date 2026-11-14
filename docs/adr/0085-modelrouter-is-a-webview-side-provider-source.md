---
status: accepted
date: 2026-11-11
decision-makers:
  - VibeX maintainers
---

# ModelRouter 是网页层的 Provider 来源，Host 不认识 VibeX 账号

VibeX 账号、额度和模型网关由产品站点运营（站点仓库 ADR-0012）。桌面端要让用户在付款后
一步把网关接进某个 Agent，同时不让账号成为使用 VibeX 的前提。

已决定：ModelRouter 在桌面端只是又一种「得到 Model Provider preset 的方式」，和新建、
导入并列。

- 入口是 Agent 设置里 Provider 工具栏的一个文字按钮，只出现在
  `MODEL_ROUTER_AGENTS` 列出的 Agent 上。首次引导的开屏页另提供可选的账号登录组件，
  用户可以直接继续本地使用；账号不占侧栏，也不作为 Agent 认证的替代。
- 账号登录用站点的桌面授权：网页层申请授权、打开系统浏览器，站点在登录后自动授权，
  桌面轮询领取结果，不要求用户输入或核对 VibeX 验证码。引导与账号设置共用此流程，
  显示等待、网络错误、过期与重试，并在取消时中止轮询与令牌接收。
  令牌存在网页层 `localStorage`，只发往站点。
- 网页层直接调用站点（`frontend/src/features/model-router/account.ts`）。不新增 Host
  command，不经过 Remote Protocol，Host、Server 和各 crate 不出现账号概念。
- 接入动作复用现有命令：通用 Agent 走 `agent_model_provider_save` 加
  `agent_model_provider_bind`，OpenCode 走 `opencode_provider_connect`。写入的是一条名为
  「VibeX ModelRouter」的普通 preset，之后可以像其他 preset 一样编辑、停用、删除；
  再次接入会更新这一条而不是新增。
- 官方订阅与 Provider 互斥的规则不变（ADR-0064）：已用官方账号登录的 Agent 在接入前
  照常确认。

## Considered Options

- **Host 持有账号令牌并代理站点接口** — 要新增一组 Host command、凭据存储和远程协议
  字段，并且让 Remote/WebUI/移动端都要处理「Host 登录了谁」。当前的引导与设置入口都不需要它。
- **站点付款后经 `vibex://` 深链把密钥推给桌面** — 密钥会出现在 URL 和系统日志里，
  而且浏览器与桌面不在同一台机器时无法完成。
- **网页层直连站点，复用 preset 命令** — 选定。

## Consequences

- 未登录、离线或站点不可达时，桌面其余功能不受影响；ModelRouter 对话框显示无法连接。
- 令牌在网页层存储，与本机其它 VibeX 设置同一信任边界；用户可在站点「安全授权」撤销。
  经 Remote/WebUI 打开的设置页有各自的登录状态。
- 每个 Agent 的 `model` 字段格式不同（Pi、Grok 是带协议的 JSON），映射集中在
  `preset.ts` 并有测试。新增支持的 Agent 时，站点 `ROUTER_AGENTS` 的协议顺序与这里
  必须同时改。
- DeepSeek Harness 没有可复用的 preset，Antigravity 走 Gemini 协议，网关不提供；两者
  不显示入口，站点也不出售。
- 以后的账号权益（配置迁移、云中继）若需要 Host 参与，另立 ADR，不扩展本决定。
