# Plugin Platform Implementation Status

本文档记录 2026-08-13 工作树中可由源码与测试证明的事实。当前产品采用 ADR-0046 的
Full Trust 模型：安装或启用插件就是信任决定，不再提供 capability permission、scope、
Trusted Native 或 App sandbox 的用户门禁。

## 已落地

- v4 package 把 README summary、`contents/`、根 `config.json`、Worker/App 入口、Runtime
  dependencies 和 integrations 放在同一 identity/digest 下。Host 严格校验结构、引用、路径和
  Runtime 完整性；这些是兼容性与防损坏校验，不是权限授权。
- `/plugins` 是产品插件入口：单列已安装列表、Loading/空状态、搜索、添加插件、开发连接和独立
  详情页。详情页只用“内容/配置”表达用户价值；README、可折叠内容树、滚动预览与 schema form
  均来自包本身，不暴露 generation、handler 或 contribution count 等内核术语。
- Codex/Claude Code 原生插件仍位于对应 Agent 设置页底部的默认折叠区域，并使用原生插件的
  列表/预览模型；它们只展示 Skills、MCP、Runtime、Hooks 与 Workflows，不冒充 VibeX 产品扩展。
- SQLite v4 registry 保存 package、activation intent、candidate/active/draining/retired generation、
  contribution、Runtime artifact 与精确 Runtime lock。Candidate Worker 成功后才发布；失败保留旧代，
  rollback 会重新发布保留包。
- Worker 使用 Host 管理的固定 Node 版本、独立进程、stdio JSON protocol、frame/output/timeout
  上限、LIFO dispose 与 kill-on-drop。它继承用户环境并可直接使用 fs/network/child_process；进程
  边界用于崩溃隔离、热重载和 generation 生命周期，不是安全边界。
- App entrypoint 运行在生命周期 iframe 中，但不使用 sandbox、CSP 或 Permissions Policy；包代码可
  使用浏览器与同源 Host 能力。MessagePort/token/sequence 仍用于稳定 open/invoke/revoke 生命周期。
- 启用产品插件时，Host 自动安装并 probe 缺失的声明式 Runtime，然后再发布 Worker generation。
  Runtime 以 `id + version + target + digest` 内容寻址并可多版本并存；前端不再自行编排安装顺序。
- `vibex-plugin init/validate/build/test/dev/install --link/uninstall/pack/doctor` 已接入真实 Host
  Dev Protocol。CLI 不再提供 `--grant`；linked install 与 candidate reload 都直接使用 Full Trust。
- 所有 `assets/plugins/<name>/.vibex-plugin/plugin.json` 内置包由通用 materializer 自动发现、按内容
  指纹发布并保留用户 `config.json`。Host 不再包含 Office ID、目录或类型分支。
- VibeX Office 只依赖公共 package/SDK：README、三类 Skills、六个 Workflows、file opener、preview
  provider、OfficeCLI Runtime 和 Worker 都位于插件包内；核心已删除 OfficeRuntime、Office IPC、
  Office React preview 与 Office 专用 materializer。
- macOS 开发启动器在替换 CEF 主进程和 Helper 后会重新 ad-hoc 深度签名并严格验证 App bundle，
  避免系统把 `com.vibex.app` 判为损坏并 SIGKILL 相关进程。

## 当前产品边界

Full Trust 有意降低第三方插件接入复杂度：插件与 VibeX 本体拥有同一用户权限，可以读取文件、
访问网络、启动进程并读取环境变量。产品必须在安装入口清楚标注“仅安装你信任的插件”，但不再
展示逐能力授权弹窗。未来若重新引入隔离，必须通过新的 ADR 和 manifest major，而不能悄悄改变
现有插件语义。

## 尚未完成

1. 公共 Marketplace、publisher 签名、撤回、自动更新与发现服务尚未实现；当前支持 builtin、
   snapshot/ZIP 与 developer link。
2. 稳定 App 插槽目前有 file opener、preview provider 与插件详情 surface；command、toolbar、status、
   composer 等 bb 已有插槽仍需逐个落地公共 schema 与 Host API。
3. CLI 与 Rust Host 尚未使用同一个 validator 实现，仍需共享 schema/fixture corpus，保证坏包诊断一致。
4. Runtime descriptor 的 `timeoutSeconds` 与 `versionPattern` 尚未完整执行；目前 probe 仍以 argv 和版本
   包含关系为主。
5. Runtime 版本变化的 candidate 需要通用“预安装到候选 digest 后再原子发布”API；当前自动准备覆盖
   常规启用，不能覆盖所有更新拓扑。
6. Remote 还需要完整的 install/update/uninstall、Artifact identity 与无 Host 绝对路径契约。
7. `PluginAction` 旧类型仍存在于会话/自动化兼容 API；产品 UI 已改称 Workflow，但内核迁移尚未完成。
8. 仍需 macOS/Linux/Windows 打包 E2E、Host crash/restart、Runtime failure、tampered archive 与真实
   linked-dev journey 的发行环境验证。

## 验证口径

- Rust：plugins/control-plane/Worker/Runtime/App surface/Office/SQLite targeted tests 与 cargo check。
- Frontend：产品插件、Agent 原生插件、App surface、路由与 CEF dev runner targeted tests。
- SDK/CLI：typecheck、build、unit tests，以及真实 loopback Host protocol smoke。

本页只随可重复运行的证据更新；类型声明、按钮或目标文档不能单独算作完成。
