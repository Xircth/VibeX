# Design: Phase 7 — 设置体系与国际化

## 所属层

- 前端：新 `frontend/src/i18n/`（init、locales/<lang>/*.json、useT 约定）、
  全组件文本替换（机械化大 diff，单独提交隔离）、设置页重组
- 后端：`crates/services` 新 proxy 模块、备份模块；`src-tauri` preferences
  启动前读取（参照 Codeg `preferences.rs`）；commands：proxy/backup/locale
- 资产：`@fontsource-variable/*` 字体包

## 参照实现（Codeg）

`src/i18n/*` + `messages/*.json`（键结构与 2,893 条目作为蓝本，按 VibeX 实际
界面裁剪）、`network/proxy.rs`、`appearance-settings.tsx`（色板/缩放/字体）、
`preferences.rs`、`backup-settings.tsx`。

## 关键决策

1. **react-i18next 而非 next-intl**：next-intl 绑定 Next.js 路由；VibeX 是
   Vite+React Router。react-i18next 是 Vite 生态标准。要求对齐的是 next-intl
   在 Codeg 中提供的能力（namespace、fallback、参数化、RTL、完整性检查），
   不是 Next.js 专用运行时。键结构对齐 Codeg 便于翻译复用——Codeg 的
   messages/*.json 可脚本迁移为初始语料（zh-CN/en 人工校对，其余 8 语先迁
   Codeg 既有翻译再补 VibeX 特有键）。
2. **文本替换策略**：按页面域分批（settings → conversation → workbench →
   dialogs），每批一个提交 + vitest 回归，避免一次性万行 diff 不可审查。
3. **缩放实现**：Tauri webview zoom（桌面）+ CSS `font-size` 根缩放回退。
4. **主题色**：CSS 变量层注入（legacy/index.css token 之上加 accent 层），
   禁止逐组件改色。
5. **代理**：reqwest ClientBuilder 统一工厂（services 内唯一 HTTP 客户端
   入口）+ agents spawn env 注入（Phase 1 优先级表中 proxy 层）。

## 新依赖

`react-i18next` + `i18next`；`@fontsource-variable/{inter,jetbrains-mono,
fira-code,geist,geist-mono}`；备份压缩用已有 zip 依赖（无则 `zip` crate，
记录）。

## 设置分区归属

| 分区 | 本 Phase 范围 | 依赖 Phase |
|---|---|---|
| General | 终端 shell、硬件加速、语言入口、基础保存/丢弃 | Phase 1 runtime settings |
| Appearance | 主题模式、主题色、缩放、字体、可变字体 | 无 |
| Agents | 保留既有 Agent 配置，新增 i18n/preflight 文案 | Phase 1 |
| Model Providers | 信息架构占位或最小 provider CRUD（若已存在则迁移） | Phase 1/5 |
| MCP | 文案与导航归位，功能增强在 Phase 5 | Phase 5 |
| Skills | 文案与导航归位，CRUD 在 Phase 5 | Phase 5 |
| Shortcuts | 文案国际化、深链保持 | 无 |
| Version Control | 导航挂载，实际功能在 Phase 5 | Phase 5 |
| System/Network | 代理、更新、备份/恢复、preferences | Phase 8 更新回滚可后挂 |
| Chat Channels | 导航挂载点，实际功能在 Phase 9 | Phase 9 |
| Web Service | 导航挂载点，实际功能在 Phase 8 | Phase 8 |

## 测试策略

- i18n：键完整性脚本测试（各语言文件键集合与 en 一致）；缺键回退测试。
- 代理：env 注入断言（spawn 假进程读 env）；URL 校验表驱动。
- preferences：读写往返 + 损坏文件回退默认。
- 备份：往返恢复集成测试（临时数据目录）。
- RTL：ar 下 snapshot 抽查。

## 风险

- 文本替换的回归面大：依赖分批提交 + 既有 vitest 全量回归；翻译键覆盖率
  脚本作为提交门。
- 字体包体积：可变字体子集化（latin + latin-ext + cjk 按需），核对 build
  产物体积。
