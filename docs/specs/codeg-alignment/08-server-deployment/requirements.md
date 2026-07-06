# Requirements: Phase 8 — Web 服务器模式与部署形态 (server-deployment)

> **⛔ 已裁决不实施（2026-07-04，方案 B）。** 见 [codeg-vs-vibex-gap-analysis-2026-07.md](../../codeg-vs-vibex-gap-analysis-2026-07.md) §P1-5。
> VibeX 的 web 服务正式定位为**本机自动化 API**（`web_service.rs` 绑定 127.0.0.1，token 鉴权），
> 不做独立 `vibex-server` 二进制 / 浏览器 UI / Docker / 远程访问 / 自更新监督器。
> 远程可达性由 IM 通道（P0-1）承担。本规格仅作历史留档，**任何执行 Agent 不得据此立项**；
> 未来重开需新的产品决策 + 真实需求证据。

## Objective

让 VibeX 像 Codeg 一样可以脱离桌面环境运行：独立 `vibex-server` 二进制
（Axum HTTP + WebSocket，token 鉴权），前端传输层抽象（同一套代码支持 Tauri
IPC 与 HTTP/WS），Docker 镜像与安装脚本，supervisor + 原地自更新。

对应差距：G1–G5、G9。

## Acceptance Criteria (EARS)

1. THE 仓库 SHALL 产出 `vibex-server` 二进制：Axum HTTP + WS，服务静态前端
   （`VIBEX_STATIC_DIR`），命令面与桌面端同源（共享 Rust core，不复制业务
   逻辑），配置 env：`VIBEX_PORT`(默认 3080)/`VIBEX_HOST`/`VIBEX_TOKEN`
   （未设则随机生成并打印 stderr）/`VIBEX_DATA_DIR`。
2. THE 前端 SHALL 引入传输抽象层（`frontend/src/lib/transport/`）：
   `Transport` 接口（call/subscribe/reconnect），TauriTransport 与
   WebTransport 两实现，运行时自动检测；既有 `tauriApi.ts` 调用全部改走
   transport（机械替换，行为不变）。
3. WHEN 浏览器访问 vibex-server，THE SYSTEM SHALL 要求 token 登录，之后核心
   工作流可用：项目列表、会话（含 Agent 流式事件，经 WS 推送）、文件树、
   git 变更、终端。
4. THE 事件订阅 SHALL 支持断线重连：WS 断开后自动重连并重放订阅（带快照
   语义，对齐 Codeg Subscribe-with-Snapshot）。
5. Docker（G4）：THE 仓库 SHALL 提供多阶段 Dockerfile（前端构建 → Rust 构建
   → slim 运行时，含 git/ssh）与 docker-compose.yml（/data 卷、token env、
   项目目录挂载示例）。
6. 安装脚本（G5）：install.sh（Linux/macOS，平台/架构检测、版本参数、目录
   参数）与 install.ps1（Windows）。
7. Supervisor + 自更新（G3）：`vibex-server --supervise` 模式下，原地更新
   （下载→校验→换二进制→重启）失败时自动回滚备份版本；试用窗口
   `VIBEX_UPGRADE_TRIAL_SECS`（默认 60s）内未健康启动即回滚；设置页提供
   更新检查/执行/回滚入口（Linux/macOS；Windows 桌面端走 Tauri updater，
   server 自更新禁用并明示）。
8. 上传配额（G9）：`VIBEX_UPLOAD_MAX_TOTAL_BYTES` 上限 + 严格模式
   `VIBEX_UPLOAD_QUOTA_STRICT`（语义对齐 Codeg：无效值 fail-open WARN /
   strict 退出码 2）；上传路径越权防护（jail）。
9. THE Web 模式下不可用的桌面特性（窗口管理等）SHALL 优雅降级隐藏，不报错。

## Edge / Error Cases

- token 错误：401 + 前端登录页重试；WS 未认证拒绝升级。
- 静态目录缺失：启动失败并打印清晰指引。
- 自更新下载校验失败：保持现版本，UI 报错。
- 多实例共用 data dir：SQLite busy 处理 + 启动警告。

## Boundaries

- Always：业务逻辑只在共享 core；server 与 Tauri 命令面同源映射（宏或注册表，
  不手抄两份）。
- Ask first：无。
- Never：在 web handler 里内联业务逻辑；token 写日志。

## Success Criteria

- 桌面回归无损（transport 切换后全量 vitest + 冒烟）；浏览器（无 Tauri）走通
  核心工作流；`docker compose up` 一键起服务并可访问；自更新+回滚在 Linux
  容器内验证；全门绿。
