# Tasks: Phase 10 — Project Boot 与附加体验

执行环境：worktree `../VibeX-project-boot`，分支 `feature/project-boot`。

- [ ] T10.1 包管理器检测
  - Acceptance: 检测 pnpm/npm/yarn/bun、版本、可执行路径；给出推荐；缺失时提示安装。
  - Verify: fake PATH 表驱动测试。
  - Files: `src-tauri/src/commands/project_boot.rs`, package manager detector

- [ ] T10.2 模板注册表
  - Acceptance: 注册 Vite React、Next、shadcn、基础 TS、已有目录初始化等模板；
    每个模板定义命令、文件变更预览、可选 MCP/Skills。
  - Verify: registry schema tests。
  - Files: project boot registry modules

- [ ] T10.3 Project Boot 页面
  - Acceptance: 首屏就是可用生成器；双栏或分步配置（框架、样式、图标、字体、
    radius、包管理器、目录）；实时预览；无营销页。
  - Verify: component tests + 视觉截图。
  - Files: `frontend/src/pages/ProjectBoot.tsx`,
    `frontend/src/components/project-boot/*`

- [ ] T10.4 实时预览与 preview_proxy 接线
  - Acceptance: 配置变更更新预览；预览失败显示错误和重试；不执行危险脚本。
  - Verify: preview state tests + 手动预览冒烟。
  - Files: project boot preview components, preview bridge

- [ ] T10.5 脚手架执行
  - Acceptance: 流式日志、取消、失败清理提示、重试；成功后写入项目库并可一键打开
    工作区；重复目录有确认。
  - Verify: 临时目录生成 Vite+shadcn 项目测试或手动冒烟。
  - Files: backend commands, frontend create dialog

- [ ] T10.6 预配置 Skills/MCP 安装接线
  - Acceptance: 生成项目时可选择安装推荐 Skills/MCP；展示将写入的配置；失败不回滚
    已生成项目但给出修复指引。
  - Verify: fixture install tests。
  - Files: Project Boot backend + Phase 5 installers

- [ ] T10.7 系统托盘与窗口状态
  - Acceptance: 托盘菜单（显示/隐藏、退出、打开设置）；窗口尺寸/位置/最大化状态、
    缩放持久化；多显示器异常有 fallback。
  - Verify: 桌面手动冒烟；preferences/window state tests。
  - Files: `src-tauri/src/commands/windows.rs`, Tauri setup

- [ ] T10.8 快速消息库
  - Acceptance: 表/命令/UI 支持模板 CRUD、分类、变量占位、composer 插入；与 i18n
    和 settings nav 兼容。
  - Verify: CRUD tests + composer 插入测试。
  - Files: quick message migration/service, `quick-messages-settings.tsx`

- [ ] T10.9 Experts 最小集
  - Acceptance: 专家配置 CRUD（名称、描述、system prompt、默认 Agent/model、启用）；
    `/` 命令或 composer 可插入；会话启动时可注入。
  - Verify: service tests + composer source tests。
  - Files: experts service/settings/composer integration

- [ ] T10.10 空状态与新手引导补齐
  - Acceptance: 项目空、文件树空、会话空、设置未配置等状态有明确下一步；Onboarding
    能引导到 Project Boot 或导入本地项目。
  - Verify: component snapshot + 手动首启冒烟。
  - Files: empty state components, onboarding dialog

- [ ] T10.11 Project Boot E2E
  - Acceptance: 创建 Vite+shadcn 项目 → 自动加入 VibeX → 打开工作区 → 发起会话 →
    运行基础命令成功。
  - Verify: 手动或 Playwright/e2e 记录。
  - Files: e2e docs/scripts

- [ ] T10.12 Pets spec 决策（可选，需产品负责人确认）
  - Acceptance: 在实现前写单独 mini spec：目标、范围、资源、性能预算、是否影响核心
    工作流；未确认则不实施。
  - Verify: 用户确认记录或明确裁剪记录。
  - Files: `docs/specs/codeg-alignment/10-project-boot-extras/pets-spec.md`

- [ ] T10.13 五轴审查 → 修复 → 全门验证 → 合并
  - Acceptance: G7-G8、F8、可选 G10 traceability 项完成/裁剪记录齐全。
  - Verify: `pnpm run check`, `pnpm run lint`, `cargo test --workspace`,
    `cd frontend && pnpm vitest run`
