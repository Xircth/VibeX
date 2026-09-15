---
status: proposed
date: 2026-09-14
decision-makers:
  - VibeX maintainers
---

# Windows Desktop 内存归因与性能预算

## Context

Windows 用户报告仅打开两个会话时，任务管理器按 VibeX 分组显示约 1.6 GB，
其中标为 Agent 的进程约 500 MB。本报告把这个现象当作需要可重复测量的性能问题，
而不是把分组数值直接等同于某一个进程的泄漏。

任务管理器的应用分组包含 WebView2 browser、renderer、GPU、utility、storage 和
network service 进程，也包含 VibeX 拉起的 ACP/CLI、Node、`cmd.exe` 及其子进程。
因此截图中的约 1.6 GB 至少包括：主 WebView2 约 394 MB、另一个 WebView2
约 76 MB、GPU 约 81 MB、WebView2 manager 约 44 MB，以及多个 Node/ACP 进程。
截图没有提供 Private Bytes、Commit、共享页、进程父子树或退出后的残留情况，不能据此
判断是泄漏、缓存还是合理的工作集。

本 ADR 扩展 [ADR-0061](0061-host-local-safety-and-performance-baseline.md) 的静态
基线，专门规定 Windows 的归因、资源预算和改进顺序。它不改变 ADR-0033 的共享
Application Core，也不削弱流式输出、虚拟列表、事件持久化、多窗口 Host 隔离或
按需使用 CEF 的用户体验。

当前实现中已存在若干控制，后续工作不能把它们回退成无界实现：

- 流式事件落库间隔目前为 80 ms；不能恢复为每 8 ms 写一次数据库。
- Agent 持久化 channel 容量为 8192，UI broadcast 和 recent-events 也有界。
- 打开会话使用最近 80 行的 `project_open`，时间线分页 API 上限为 200；前端仍有
  初始 `detail()` 路径，分页接入尚未完成。
- 时间线使用 virtualizer、`requestAnimationFrame` 批量 row-ops 和 memo 组件。
- PTY scrollback 上限为 512 KiB，但在途输出、订阅者和子进程生命周期仍需测量。

## Diagnosis

### 进程与 WebView2

1. `src-tauri/src/app_windows.rs` 为每个额外应用窗口生成 `app-*` label，并为其
   设置独立 `data_directory`。`settings_window.rs` 会按调用方复用或创建设置窗口。
   每个独立 WebView 环境可能带来额外 renderer、browser/manager、GPU 或 utility
   工作集。打开设置、第二个应用窗口或预览窗口时，分组内存自然上升。
2. `tauri.windows.conf.json` 使用离线 WebView2 安装包；WebView2 多进程开销是产品
   运行时组成部分，不能只通过压低 Rust 主进程 RSS 解决。
3. CEF Browser Runtime（ADR-0007）仅在浏览器预览能力启用时加载，并有自己的
   browser/renderer/helper 子进程。普通会话基线必须与 CEF 开启基线分开。

### ACP、Node 与子进程树

1. `crates/agents/src/manager.rs` 通过 `group_spawn_no_window` 启动每个 ACP 程序，
   stdio 连接并继承启动环境。内置 Claude、Codex、Pi 及 registry 的 npx/native-npx
   profile 可能经过 Node、npm shim、`cmd.exe` 或 vendor CLI；一个会话不应假定只
   对应一个进程。
2. Windows 的 `.cmd/.bat` 需要 `cmd.exe /d /c` 包装。包装、ACP adapter、MCP
   server、Agent 自己的 worker 会形成多层树。`kill_on_drop` 或仅终止 leader 不足以
   证明孙进程已经退出；必须记录 job/tree 生命周期并检查关闭后的残留。
3. Agent 安装探测已经有并发上限，但启动后每个连接、MCP server 和临时命令的并发
   仍可能扩散。截图中大量 Node runtime 可能是正常的 adapter fan-out，也可能是
   已关闭会话的孤儿，必须由 PID 树和退出后采样区分。

### Rust、数据库与文件系统

1. SQLite 使用 WAL、`cache_size=-65536`（每连接约 64 MiB 的 page-cache 上限），
   pool `max_connections=8`。理论上 page-cache 上界约 512 MiB，但实际 RSS 受页面
   触达、SQLite 分配器和 Windows 文件缓存影响，不能把它直接当成已发生的占用。
   多连接也会放大 page cache、连接状态和写者争用。
2. ACP 输出经过 recorder、projector、数据库、IPC、前端 store 多次序列化或复制。
   快速流配合慢写者会在队列、`pending.text`、JSON 和 React 状态中同时保留同一内容。
3. 会话打开已经限制初始投影，但前端初始仍调用 `conversationApi.detail()`；长会话的
   older-page、gap backfill 和 eventsSince 仍可能重放大量事件。单 Turn 中的快照刷新
   与队列字节上限也需要在 Windows 长流上验证。
4. Git status、directory children、watcher 初始 walk 和部分 diff/file read 仍有同步
   或整文件读取路径。它们会占用 tokio worker、线程栈和文件缓存，表现为 UI 卡顿或
   额外 commit，而不是单一 RSS 泄漏。
5. PTY 使用每会话 reader/input 线程和订阅者列表；scrollback 只有历史上限，在途数据、
   关闭竞态和 Windows shell 子进程树仍可能增长。

### 前端事件、轮询与渲染

1. `conversation-events` 是进程级事件，挂载的时间线先接收再按 conversation id
   过滤。多个面板会重复创建监听、闭包和中间对象。
2. timeline reducer 在 upsert 时仍可能复制整张 rows 数组，并在渲染帧中排序；流式
   Markdown 每个 token prepare 会放大 CPU、临时字符串和 React 提交。
3. Git、文件树、workflow、Attention/Automation、插件状态及会话 follow-up 仍有
   1 秒至 30 秒不等的轮询。不可见窗口、后台设置页和重复挂载会继续轮询。
4. virtualizer 和 rAF 批处理是正确的体验基础，应优化其输入频率和结构共享，而不是
   关闭虚拟化或停止流式显示。

## Decision

### 1. 建立 Windows 资源预算和归因闭环

发布构建以 Windows 11 x64 为主基线，记录 0、1、2、5 个会话，idle、流式、长历史、
设置窗口、第二应用窗口、PTY、Git 大仓库和 CEF 预览八类场景。每个场景记录启动后
1/5/30 分钟的：

- 每个 PID 的 Working Set、Private Bytes、Commit、CPU、handles、线程数、父 PID、
  job id、启动命令和退出时间；按 WebView2、Rust、Agent/ACP、Node、MCP、PTY、CEF
  分类，不能只报告任务管理器分组总和。
- 前端 `performance.mark`、长任务、帧耗时、挂载面板数、事件批量大小和 store 行数。
- Agent/ACP/PTY channel 深度、单 Turn 字节数、丢弃/背压次数、子进程存活数。
- SQLite pool 实际连接数、page-cache 命中/估算、WAL 大小、查询耗时和内存分配采样。

使用 Windows Performance Recorder/Analyzer 或 ETW、Process Explorer/WMI 进程树和
WebView2 diagnostic API 采样；采样工具本身的开销要单独记录。没有采样数据的结论必须
标记为假设。

初始预算（发布前可根据基线校准，但必须保留可比性）：

- 无 CEF、无额外窗口、idle 的主应用 Private Bytes ≤ 350 MB。
- 两个 idle 会话相对单会话的增量 ≤ 150 MB；流式期间 30 分钟内内存趋于平台，
  不允许持续线性增长。
- 关闭会话后 10 秒内其 ACP/Node/MCP/PTY 子树为零；异常退出后由回收器在 60 秒内
  收敛，且有日志可定位。
- 可见时间线交互的 p95 帧时间 ≤ 16.7 ms；流式文本 p95 事件到绘制延迟 ≤ 100 ms。
- 事件 backlog 在停止流式后 5 秒内回到零；任何单个输出 buffer、文件读取和 diff
  预览都必须有字节上限。

这些数值是工程门槛，不是对当前截图的反推；若真实硬件分布需要调整，必须在 ADR 更新
基线、原因和前后对比。

### 2. Windows WebView 生命周期

- 在不违反 ADR-0033/0054 Host 隔离的前提下，同一 Host 的设置页和附加页面复用已有
  WebView 环境；禁止预创建隐藏窗口。窗口关闭时卸载重组件路由和订阅，重新打开再懒加载。
- 保留需要独立 profile 的窗口语义，但为每个环境分配 owner、创建/销毁时间、profile
  路径和内存指标；连续空闲超过阈值的非主窗口释放可重建资源。
- 将重型 Markdown、Git diff、文件预览、画布和插件诊断改为按路由/面板懒加载；状态
  放在共享 store，卸载视图不复制完整会话数据。
- 评估 WebView2 的缓存目录、预加载脚本和 GPU 策略，任何禁用 GPU 或清空缓存的改变
  必须以帧时间和 Private Bytes 的 A/B 数据为依据，不能为了 RSS 牺牲滚动和输入体验。

### 3. ACP/Node/PTY 子进程治理

- 为每次 Agent connection 建立 Windows Job Object，设置 kill-on-close，并把 adapter、
  MCP、shell 和 vendor worker 纳入同一 job。关闭、取消、窗口退出和 Host shutdown
  都走幂等的 terminate-and-wait；不能只调用 leader 的 `kill_on_drop`。
- 给进程记录 `conversation_id`、connection id、parent PID、job id、启动来源和退出
  原因；启动后短时间内退出的 shim/`cmd.exe` 不应留下不可追踪的 Node 子树。定期扫描
  VibeX-owned job，发现无 owner 的进程立即回收并计数。
- 优先直接启动可执行文件，只有 Windows shim 必须时才使用 `cmd.exe /d /c`；对 npx
  profile 复用已安装 runtime，避免每个会话重复启动探测/下载 worker。Agent 安装探测
  继续遵守 ADR-0026 的有界并发。
- ACP 持久化和 UI channel 采用生产者侧 coalesce、按 Turn 字节上限和有界等待；将
  backpressure 作为可观测指标。PTY 在途输出、订阅者和 scrollback 均有硬上限，关闭
  时先停止 reader/input，再回收整个 shell job。
- 修复 terminal waiter 持锁等待、取消无法及时 kill、以及 runtime lock 在 guard
  存在时被移除的问题；这些是生命周期和内存稳定性的一部分，按 ADR-0061 加固顺序处理。

### 4. 数据库、投影和 IPC

- 完成 timeline page 接入：首次只取有限行/字节和 cursor，older page 增量追加；不再
  将完整 `turns` 与 timeline 同时经 IPC 发送。长 Turn 按事件数或时间刷新 snapshot，
  gap backfill 只读取缺口。
- 以实测连接数和查询并发为依据，把 desktop/server 的 pool 分层：单 writer + 少量
  reader 优先；降低不必要的 page-cache 乘数，设置 WAL/checkpoint 策略，并验证冷/热
  查询的延迟预算。不可在没有 A/B 数据时简单把 cache 设为零。
- 对事件行、fold JSON、Markdown 和工具输出采用结构共享/引用游标，避免 recorder →
  projector → IPC → React 的完整 clone。单个事件、Turn 和 find-in-conversation 扫描
  都有大小或分页限制。
- 事件订阅改为按 conversation/Host 的共享 broker：一个底层监听服务多个面板，面板
  只收到自己的批次；保留 rAF 合并和断线 eventsSince 补偿。

### 5. 前端调度与 I/O

- reducer 使用 keyed structural sharing 和增量排序；只在顺序变化时重排，流式文本按
  16–50 ms 或字节阈值批量 prepare Markdown。保留 virtualizer、memo、可见区域优先和
  贴底行为。
- 将轮询改为事件唤醒优先、指数退避并受 `document.visibilityState`、窗口焦点、路由和
  网络状态控制。不可见设置页、后台面板和重复 hook 不运行高频 timer；恢复可见时先做
  一次带 cursor 的增量同步。
- 所有 Git、directory children、watcher 初始 walk 和大文件/diff 读取进入
  `spawn_blocking` 或专用受限线程池；优先复用 filesystem watcher，取消重复 `git status`
  和全目录扫描。读文件先检查 metadata/流式上限，避免“读完整文件后再截断”。
- 对大型仓库、`node_modules`、`target`、生成目录继续跳过并设置条目/时间预算；预算
  超时返回可恢复的 partial 状态，不阻塞 UI。

### 6. 发布构建与回归门槛

- 性能测试只使用 release Windows 包和用户环境中的 Agent；Vite dev server、调试符号、
  开发工具或安装器进程不能混入产品基线。
- CI 增加进程树清理、关闭后零孤儿、长流 30 分钟 plateau、双会话增量、WebView 多窗口
  和大仓库 I/O 的 smoke/perf 场景。失败时上传脱敏后的指标摘要，不上传命令行中的 token。
- Desktop 与 `vibex-server` 共用的 Application Core、事件协议和资源上限必须同时验证，
  不能只修桌面端。

## Priority and rollout

**P0：先消除错误归因和失控增长。** 加入 Windows PID/job/内存 telemetry；确保关闭
Agent、MCP、PTY 会回收整棵树；为 ACP/PTY/文件读取设硬上限；完成 timeline 首屏分页；
将所有 Git/目录同步路径移出 tokio worker。

**P1：降低稳定工作集和事件放大。** 接入共享 conversation event broker、结构共享
store、Markdown 批处理、可见性轮询；按连接实测调小 SQLite pool/page cache；统一
WebView 窗口复用和重路由懒加载。

**P2：按需优化高成本能力。** CEF/预览生命周期、WebView 缓存策略、filesystem watcher
聚合、Agent runtime 复用和更细的 ETW 诊断，在 P0/P1 预算稳定后逐项 A/B。

每个阶段都必须在 0/1/2/5 会话及 settings/PTY/CEF 组合场景通过预算；任何体验回归
（输入延迟、滚动帧率、流式可见性、取消响应）都阻止扩大 rollout。

## Consequences

这项决定把“VibeX 分组占用”拆成可行动的组件预算，维护者可以知道内存来自 WebView、
数据库、事件复制还是 Agent 子树。它会增加 Windows telemetry、job 管理、性能夹具和
发布前测试的维护成本，也可能降低后台轮询频率或延迟非可见页面刷新；这些变化通过事件
唤醒、cursor 增量同步和懒加载保持用户可见的实时体验。

以下方案明确拒绝：为降低总和而移除 WebView2/Tauri、禁用流式输出、关闭时间线虚拟化、
把所有 Host 窗口强行合并为一个 profile、或用浏览器 iframe 替代 CEF。它们会破坏已有
的窗口隔离、交互延迟、协议能力或 ADR-0007/0033/0054 的产品约束。

## Open measurements

在获得 Windows release trace 前，以下问题保持未证实：1.6 GB 中 WebView2 共享页和
Private Bytes 的比例；Node 进程是每会话 fan-out 还是已关闭会话孤儿；SQLite page cache
是否接近理论上限；CEF 是否参与截图；以及长 Turn 是否存在线性增长。任何实现 PR 都应
附带这些字段的前后测量，并回链本 ADR 的预算结果。

