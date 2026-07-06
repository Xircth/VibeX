# Tasks: Phase 8 — Web 服务器模式与部署形态

> **⛔ 已裁决不实施（2026-07-04，方案 B）。** 见 [codeg-vs-vibex-gap-analysis-2026-07.md](../../codeg-vs-vibex-gap-analysis-2026-07.md) §P1-5。以下任务全部作废，勿执行。

执行环境：worktree `../VibeX-server-deploy`，分支 `feature/server-deploy`。
可拆为 8a（transport/server）与 8b（Docker/update）两段串行。

- [ ] T8.1 EventSink/CommandCore spike
  - Acceptance: 列出所有 Tauri emit/invoke 点；设计 `EventSink` trait 与 command core
    注册表；识别无法浏览器化的桌面能力并列降级策略。
  - Verify: 产出决策记录，含命令清单与事件量评估。
  - Files: `docs/specs/codeg-alignment/08-server-deployment/transport-spike.md`

- [ ] T8.2 命令面同源重构第一批：项目/会话/设置
  - Acceptance: Tauri command 与 HTTP handler 调同一 core 函数；无业务逻辑复制。
  - Verify: existing command tests + 新 core tests。
  - Files: `src-tauri/src/commands/*`, `crates/services/*`

- [ ] T8.3 命令面同源重构第二批：Git/文件/终端/Agent
  - Acceptance: 高风险命令分批迁移；桌面行为不变；浏览器模式不支持项返回
    `UnsupportedInWebMode`。
  - Verify: affected Rust tests + 桌面冒烟。
  - Files: command modules, service modules

- [ ] T8.4 `crates/server` Axum app
  - Acceptance: token auth、静态前端资源、health、version、command routes、CORS
    策略；日志不泄露 token。
  - Verify: Axum integration tests。
  - Files: `crates/server/*`, workspace Cargo config

- [ ] T8.5 WebSocket 事件桥
  - Acceptance: 支持订阅、初始快照、断线重连、事件 cursor、背压/队列上限；与
    Tauri event 使用同一 EventSink。
  - Verify: WS integration test（重连、丢包恢复、订阅过滤）。
  - Files: server ws handlers, event sink impl

- [ ] T8.6 前端 transport 层
  - Acceptance: `tauriApi` 收口为 transport interface；支持 Tauri IPC、HTTP+WS、
    未来 remote 三模式；契约测试覆盖错误归一。
  - Verify: frontend transport tests + 桌面全量回归。
  - Files: `frontend/src/lib/transport/*`, `frontend/src/lib/tauriApi.ts`

- [ ] T8.7 浏览器模式 UI 降级与登录页
  - Acceptance: `/login` 或等价入口；token 保存/退出；桌面专属能力隐藏或显示解释；
    URL 深链可刷新。
  - Verify: browser preview/manual smoke。
  - Files: router, auth provider, login page

- [ ] T8.8 上传 quota 与 jail
  - Acceptance: 上传目录隔离、单文件/总量 quota、路径穿越拒绝、清理策略；与 Codeg
    upload_jail 语义对齐。
  - Verify: path traversal/security tests。
  - Files: server upload handlers

- [ ] T8.9 Dockerfile 与 docker-compose
  - Acceptance: 多阶段构建；持久化 volume；端口/token/env 文档；健康检查；最小
    镜像体积记录。
  - Verify: `docker build` + `docker compose up` 冒烟。
  - Files: `Dockerfile`, `docker-compose.yml`, docs

- [ ] T8.10 install.sh / install.ps1
  - Acceptance: 下载 release、校验、安装/升级、卸载提示；Windows PowerShell 与
    Linux/macOS shell 分支；失败可恢复。
  - Verify: dry-run tests 或脚本 lint；手动 dry run。
  - Files: `install.sh`, `install.ps1`

- [ ] T8.11 Supervisor + 自更新 + 回滚
  - Acceptance: server 模式可原地更新；下载校验、换装、回滚、版本锁；设置页能
    显示进度与错误。
  - Verify: 临时目录升级/回滚集成测试。
  - Files: update/supervisor modules, settings UI hook

- [ ] T8.12 Web 服务设置页
  - Acceptance: 启用状态、端口、访问地址、QR 码、token 重置、复制链接、服务日志；
    与 Phase 7 settings nav 挂载。
  - Verify: component tests + 本机浏览器访问冒烟。
  - Files: `frontend/src/components/settings/web-service-settings.tsx`

- [ ] T8.13 浏览器端核心工作流冒烟
  - Acceptance: 登录 → 打开项目 → 查看会话 → 发送消息 → 接收流式事件 → 查看文件/
    diff → 设置代理/外观关键流程可用或正确降级。
  - Verify: Playwright 或手动浏览器冒烟记录。
  - Files: e2e scripts/docs

- [ ] T8.14 五轴审查 → 修复 → 全门验证 → 合并回 master
  - Acceptance: G1-G5、G9 traceability 项完成/裁剪记录齐全。
  - Verify: `pnpm run check`, `pnpm run lint`, `cargo test --workspace`,
    `pnpm run frontend:build`, Docker 冒烟
