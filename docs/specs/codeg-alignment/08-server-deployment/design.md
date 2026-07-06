# Design: Phase 8 — Web 服务器模式与部署形态

> **⛔ 已裁决不实施（2026-07-04，方案 B）。** 见 [codeg-vs-vibex-gap-analysis-2026-07.md](../../codeg-vs-vibex-gap-analysis-2026-07.md) §P1-5。仅历史留档，勿据此立项。

## 所属层

- 新 crate：`crates/server`（Axum app、ws 事件桥、auth、静态服务、upload
  jail/quota、update、supervise）+ `src-tauri/src/bin/vibex_server.rs` 或
  独立 bin crate（按 tauri 特性裁剪决定，倾向独立 crate 避免拖 Tauri 依赖）
- 命令面同源：`src-tauri/src/commands/*` 重构出 transport 无关的 core 函数层
  （提取到 crates/services 或新 crates/api），Tauri 命令与 Axum handler 都是
  薄包装
- 前端：`frontend/src/lib/transport/{types,tauri,web,detect,index}.ts`、
  `tauriApi.ts` 改造、WS 事件流 + 重连
- 根目录：Dockerfile、docker-compose.yml、install.sh、install.ps1

## 参照实现（Codeg）

`bin/codeg_server.rs`（419 行：env、token、静态、监听）、`web/*`（handlers、
EventBroadcaster、upload_jail）、`supervise.rs`（init 进程、信号转发、试用
窗口回滚）、`update/*`（install/verify/runtime/state/version）、
`src/lib/transport/*`（接口形状直接对齐）、Dockerfile/compose/install 脚本
（结构移植改名）。

## 关键决策

1. **命令面同源**：现状 Tauri commands 直接调 services。重构原则：每个命令
   的业务体已在 crates 内的保持不动；在 commands 内联了逻辑的，先下沉。
   产出一张「命令 → core 函数」注册表，server 据此生成路由（POST
   /api/<command>，JSON in/out），事件走 WS 主题。Rejected: 维护两份手写
   handler（漂移必然发生）。
2. **事件桥**：Tauri emit 点抽象为 `EventSink` trait（Tauri 实现 → window
   emit；server 实现 → broadcast channel → WS fanout）。这是本阶段最深的
   重构点，先做 spike 验证事件量。
3. **传输层**：`Transport.call(cmd, payload)` + `Transport.subscribe(topic,
   cb) -> Unsubscribe`；detect：`window.__TAURI__` 存在 → Tauri。
4. **自更新**：GitHub Releases 资产命名约定 + sha256 校验；`--supervise`
   为父进程 fork/exec 子服务进程模型（Windows 禁用，明示）。

## 新依赖

`axum`、`tower-http`（静态/Trace）、`tokio-tungstenite`（axum ws 内置可免）、
`sha2`（校验）。均为 server crate 隔离依赖，不进桌面构建。

## 测试策略

- transport：契约测试（同一调用序列在两实现下行为一致，mock 后端）。
- server：axum TestClient 走 auth/命令路由/上传配额/jail 越权用例。
- EventSink：广播扇出 + 断线重放测试。
- supervise/update：Linux 容器内集成脚本（CI 可选 job）。

## 风险

- EventSink 重构触面广（所有 emit 点）：先 spike + 分批迁移，每批全量回归。
- 此阶段体量最大，允许拆为 8a（server+transport）/8b（docker+install+update）
  两个 worktree 串行。
