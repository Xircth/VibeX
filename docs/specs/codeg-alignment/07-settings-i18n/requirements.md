# Requirements: Phase 7 — 设置体系与国际化 (settings-i18n)

## Objective

补齐产品化短板：i18n 框架 + 10 语言、网络代理配置、外观深度（主题色/缩放/
字体）、启动前偏好（preferences.json）、备份/恢复、设置信息架构对齐 Codeg
13 分区中本阶段应有的部分。

对应差距：F1–F7。

## Acceptance Criteria (EARS)

1. i18n（F1）：THE 前端 SHALL 集成 i18n 框架（Vite 生态：react-i18next），
   所有用户可见文本走翻译键；语言包覆盖 Codeg 同列表 10 语：en、zh-CN、
   zh-TW、ja、ko、es、de、fr、pt、ar；语言设置项持久化并即时生效；缺键回退
   en 并在 dev 模式告警。提交门：硬编码中文扫描（CI 脚本 grep CJK in tsx，
   白名单机制）零新增。
2. 代理（F2）：THE SYSTEM SHALL 提供代理设置（启用开关 + URL + 连通性验证），
   后端应用到 6 种 env 形式（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 大小写），作用
   于应用自身 HTTP 客户端与 Agent 子进程 env（接 Phase 1 env 合并优先级）。
3. 外观（F4）：THE 外观设置 SHALL 支持：主题模式（系统/亮/暗）、≥6 种主题色
   预设、缩放（75%–175%）、字体预设（含 JetBrains Mono/Fira Code 等可变字体，
   UI 与等宽分开选择）。全部即时预览 + 持久化。
4. 启动前偏好（F5）：THE 桌面端 SHALL 在 Tauri 初始化前读取
   `~/.vibex/preferences.json`（含 disable_hardware_acceleration），设置页可改
   并提示重启生效。
5. 备份（F6）：THE SYSTEM SHALL 支持一键备份（数据库 + 配置 → 单文件压缩包）
   与恢复（校验版本、二次确认）。
6. 文档（F7）：README 提供 en 主文 + zh-CN 翻译（其余语言占位结构建立，
   docs/readme/）。
7. 信息架构：设置导航重组为与 Codeg 对齐的分区结构（通用/外观/Agents/MCP/
   Skills/快捷键/版本控制[Phase5]/系统网络；聊天频道与 Web 服务分区由
   Phase 8/9 挂入），路由稳定可深链。

## Framework Equivalence

Codeg 使用 `next-intl`，但 VibeX 当前不是 Next.js 应用。本 Phase 的要求是对齐
`next-intl` 带来的能力，而非强行引入 Next.js 专用运行时：

- namespace 翻译键与类型检查；
- locale detection、持久化、即时切换；
- 缺键 fallback 与开发期告警；
- ICU 风格参数化、复数、日期/数字格式；
- RTL `dir` 切换；
- 翻译完整性检查。

默认实现为 `react-i18next` + 自定义完整性脚本。若产品负责人要求必须使用
`next-intl`，需要先创建单独框架 ADR，因为这可能牵涉 React Router/Vite 架构调整。

## Edge / Error Cases

- ar 语言 RTL：布局不破（dir 属性切换，关键页面抽查）。
- 翻译键缺失：回退链 locale→en→键名，不渲染空白。
- 代理 URL 非法：保存前校验 + 连通性测试按钮（测试失败仍允许保存，标注）。
- 恢复备份版本高于当前应用：拒绝并提示升级。

## Boundaries

- Always：新 UI 文本一律走键；翻译文件按分区组织（settings.json、
  conversation.json…）避免单文件巨石。
- Ask first：无。
- Never：机器翻译质量不过关时静默上线（非 en/zh 语言首版标注 beta）。

## Success Criteria

- 语言切换全界面生效（抽查 5 个页面 × 3 语言）；代理设置后 Agent 子进程 env
  生效（集成测试断言）；外观四项即时生效；备份/恢复往返成功；全门绿 +
  impeccable 无新增违规。
