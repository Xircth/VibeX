# VibeUltra Desktop Branding Design

## Goal

将当前项目的桌面端品牌统一为 `VibeUltra`，并保留 `frontend/` 作为 Tauri 内嵌界面。移除独立 Web/PWA 暴露面，但不破坏桌面端构建链路。

## Scope

### In scope

- 将桌面端用户可见品牌名更新为 `VibeUltra`
- 将 `src-tauri/tauri.conf.json` 中的 `productName` 与窗口标题更新为 `VibeUltra`
- 使用 `C:/Users/Administrator/Downloads/VibeUltra_background.png` 生成桌面应用图标
- 使用 `C:/Users/Administrator/Downloads/VibeUltra.png` 作为应用内部品牌图
- 在设置页增加内部品牌展示
- 更新前端中用户可见的品牌文案与页面标题
- 移除 `frontend/index.html` 中独立 Web/PWA 相关 icon 与 manifest 引用

### Out of scope

- 不修改 `Vibe-kanban-originbase/**`
- 不修改 npm 包名、CLI 命令名、Rust crate 名、Tauri `identifier`
- 不修改外部仓库 URL、npm 包名、缓存目录名等技术标识
- 不删除旧资源文件，优先解除引用，降低回归风险

## Constraints

- 当前“桌面端”依赖 `frontend/` 提供 UI，不能真正删除 `frontend/`
- 需要保持现有 Tauri 构建方式可用
- 遵循 KISS/YAGNI：只改当前明确需要的品牌展示点，不做额外架构调整
- 遵循 DRY：复用统一 `Logo` 组件承载内部品牌图与品牌名

## Design

## 1. 品牌入口统一

通过以下入口统一品牌：

- `frontend/src/components/Logo.tsx`
- `frontend/src/pages/settings/SettingsLayout.tsx`
- `frontend/src/components/welcome/WelcomePage.tsx`
- `frontend/src/components/layout/StatusBar.tsx`
- `frontend/src/contexts/ProjectContext.tsx`
- `src-tauri/tauri.conf.json`

`Logo` 组件改为“图标 + 文本”的轻量组合组件，供导航栏、工具栏等位置复用；设置页头部额外展示一次内部品牌图，满足“内部页面使用无背景版”的要求。

## 2. 图标策略

- 无背景图：复制到前端源码目录，供 React 界面导入使用
- 有背景图：用于生成 Tauri bundle icon 文件

优先使用现有 Tauri 工具链生成标准输出文件，避免手工拼装 `ico` / `icns`，减少平台兼容性风险。

## 3. Web 独立入口处理

保留 `frontend/index.html` 作为 Tauri WebView 宿主页，但移除：

- favicon 引用
- apple-touch-icon 引用
- `site.webmanifest` 引用

这样仍可支持桌面端加载前端产物，同时避免继续暴露独立 Web/PWA 品牌入口。

## 4. 用户可见文案处理原则

仅修改“用户可见品牌文案”，例如：

- 欢迎页标题
- 对话框欢迎语
- 状态栏品牌名
- 页面 `<title>`
- PR 默认标题中的品牌后缀

不修改技术语义字符串，例如：

- 包名 `vibe-kanban`
- 远程仓库 URL
- 外部依赖名 `vibe-kanban-web-companion`

## 5. 风险与缓解

- 风险：误改技术标识导致构建或集成失效
  - 缓解：仅替换用户可见文本；技术标识保留
- 风险：图标文件格式不完整导致 Tauri 打包失败
  - 缓解：使用 Tauri icon 生成命令生成标准文件
- 风险：品牌文本遗漏
  - 缓解：实现前后分别执行全文检索与定向测试

## Verification

- 新增品牌回归测试，检查关键展示位与 Web icon/manifest 引用是否符合预期
- 运行 `node --test frontend/tests/branding-desktop-only.test.js`
- 运行 `pnpm run frontend:check`
- 运行 `pnpm run backend:check`

## Notes

- 根据仓库根 `AGENTS.md`，本次不执行 `git commit`
- 设计文档与计划文档仅作为本次实现记录保存在 `docs/plans/`
