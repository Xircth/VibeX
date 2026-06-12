# Tasks: Phase 7 — 设置体系与国际化

执行环境：worktree `../VibeX-settings-i18n`，分支 `feature/settings-i18n`。

- [ ] T7.1 i18n 框架决策与基建
  - Acceptance: 记录 `next-intl`（Codeg）与 `react-i18next`（Vite 等价实现）取舍；
    初始化 provider、locale detector、fallback chain、RTL dir、语言持久化。
  - Verify: `cd frontend && pnpm vitest run src/i18n`
  - Files: `frontend/src/i18n/*`, `frontend/src/main.tsx`, `docs/specs/.../design.md`

- [ ] T7.2 翻译键组织与完整性脚本
  - Acceptance: 按域拆分 `settings`, `conversation`, `workbench`, `dialogs`,
    `toasts`, `errors`；缺键检测、冗余键检测、CJK 硬编码扫描白名单进入 CI。
  - Verify: `pnpm run i18n:check`（新增脚本）; CJK 扫描零新增。
  - Files: `frontend/src/i18n/locales/*`, `scripts/i18n-check.*`, package scripts

- [ ] T7.3 Codeg 语料迁移工具与首批语言包
  - Acceptance: 可从 Codeg `src/i18n/messages/*.json` 生成 VibeX locale 初稿；
    en、zh-CN 人工校对；zh-TW/ja/ko/es/de/fr/pt/ar 结构完整并标注 beta。
  - Verify: 迁移脚本 snapshot；缺键检查通过。
  - Files: `scripts/import-codeg-locales.*`, `frontend/src/i18n/locales/**`

- [ ] T7.4 文本替换批 1：设置域
  - Acceptance: settings shell、Agents、MCP、Skills、Shortcuts、Editor、Appearance、
    System 中用户可见文本全部走翻译键。
  - Verify: `rg -n "[\\u4e00-\\u9fff]" frontend/src/pages/settings frontend/src/components/settings`
    仅白名单命中；设置页三语言冒烟。
  - Files: settings pages/components

- [ ] T7.5 文本替换批 2：conversation 域
  - Acceptance: Phase 2 会话渲染、工具卡、输入区、错误/空状态、toast 文案走翻译键。
  - Verify: conversation 相关测试 + CJK 扫描。
  - Files: `NormalizedConversation`, `conversation-thread`, `tasks/follow-up`

- [ ] T7.6 文本替换批 3：workbench/dialogs/toasts/errors
  - Acceptance: 工作台、Git、文件树、预览、全局 dialog/toast/error helper 文案走键；
    错误消息支持参数化。
  - Verify: 全前端 CJK 扫描零新增（白名单仅示例内容/测试 fixture）。
  - Files: `frontend/src/components`, `frontend/src/hooks`, `frontend/src/lib/*Errors.ts`

- [ ] T7.7 网络代理后端
  - Acceptance: 配置支持 enable + URL；保存后应用到 `HTTP_PROXY`,
    `HTTPS_PROXY`, `ALL_PROXY` 及小写形式；Agent 子进程 env 合并优先级接 Phase 1。
  - Verify: Rust env 工厂表驱动测试 + spawn env 集成测试。
  - Files: `src-tauri/src/network/proxy.rs` 或等价模块、config model、commands

- [ ] T7.8 网络代理 UI
  - Acceptance: System/Network 设置中有启用、URL、验证按钮、保存/丢弃、错误提示；
    验证失败可选择仍保存并标注。
  - Verify: component test + 手动代理 URL 冒烟。
  - Files: `frontend/src/pages/settings/SystemSettings.tsx` 或新 `SystemNetworkSettings.tsx`

- [ ] T7.9 外观深度：主题色、缩放、字体
  - Acceptance: 主题模式、≥6 主题色预设、75%-175% 缩放、UI/等宽字体独立选择；
    JetBrains Mono/Fira Code/Inter/Geist 等可变字体接入；即时预览 + 保存/丢弃。
  - Verify: Appearance 设置测试 + 桌面三主题冒烟 + 无布局溢出。
  - Files: `AppearanceSettings.tsx`, `appearance-provider`, CSS variables, package deps

- [ ] T7.10 `preferences.json` 启动前偏好
  - Acceptance: 桌面启动前读取 `~/.vibex/preferences.json`；支持
    `disable_hardware_acceleration`、初始 theme/scale/font；设置页修改并提示重启。
  - Verify: Rust preference read/write 测试 + 手动重启冒烟。
  - Files: `src-tauri/src/preferences.rs`, Tauri entry setup, settings UI

- [ ] T7.11 备份/恢复
  - Acceptance: 一键导出数据库 + 配置 + preferences 为压缩包；恢复前校验版本、
    预览内容、二次确认；高版本备份拒绝恢复。
  - Verify: 备份恢复往返集成测试（临时 app data dir）。
  - Files: backup service, settings UI, commands

- [ ] T7.12 设置信息架构重组
  - Acceptance: 导航按 Codeg 对齐：General、Appearance、Agents、Model Providers、
    MCP、Skills、Shortcuts、Version Control、System/Network；Chat Channels 和
    Web Service 作为 Phase 8/9 挂载点；深链稳定。
  - Verify: route smoke + settings nav component test。
  - Files: `frontend/src/pages/settings/*`, router config

- [ ] T7.13 README 与 docs/readme 结构
  - Acceptance: 根 README 以英文为主，`docs/readme/README.zh-CN.md` 完成；
    zh-TW/ja/ko/es/de/fr/pt/ar 文件结构建立并注明 beta/待校对。
  - Verify: 链接检查（相对链接存在）+ 人工审阅。
  - Files: `README.md`, `docs/readme/*`

- [ ] T7.14 RTL 与多语言视觉抽查
  - Acceptance: ar 下 `dir=rtl`，设置页、会话页、工作台关键布局不破；按钮文本不溢出。
  - Verify: 浏览器/桌面截图：en、zh-CN、ar 各 5 页。
  - Files: CSS logical properties 修复

- [ ] T7.15 全量门与追踪矩阵更新
  - Acceptance: F1-F7 与 traceability #13/#14/#22 标记完成/裁剪；所有新增文本走键。
  - Verify: `pnpm run frontend:check`, `pnpm run frontend:lint`,
    `cd frontend && pnpm vitest run`, `pnpm run frontend:build`,
    `cargo test --workspace`
