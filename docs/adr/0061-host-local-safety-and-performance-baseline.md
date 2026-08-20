---
status: accepted
date: 2026-08-20
decision-makers:
  - VibeX maintainers
---

# Host 以内存、锁、命令、Git 与性能为本地安全基线

VibeX 是本地优先的 Host。鉴权、配置文件机密和远程数据泄露不构成本机运行的默认
威胁模型。本 ADR 记录 2026-08-20 对 Host 家族（Desktop 与 `vibex-server`）的静态
审查结论，并固定三类决定：哪些能力是全信任产品假设，哪些是必须修复的缺陷，后续
加固按什么顺序落地。审查覆盖 `crates/`、`src-tauri/`、`frontend/` 热路径，对照
ADR-0026、ADR-0048、ADR-0060。未做运行时压测或漏洞 PoC。

本决定不改变 Plugin 全信任模型（ADR-0048）、Agent 安装走用户环境（ADR-0060），
也不引入 Marketplace 沙箱。它约束的是：非全信任输入不得进入 Host 的 shell 字符串、
未校验 ref、无界缓冲或任意本机路径；可靠性缺陷不得以「本地应用」为由保留。

## Context

用户启用的 ACP Agent 与 VibeX Plugin Package 与 Host 同权。仓库 setup / cleanup /
archive / dev-server 脚本故意经 `sh -c` / `cmd /C` 执行。交互式 PTY 在 Workspace
中打开真实登录壳。这些不是漏洞。

真正的边界是 **非全信任输入**：恶意或 Agent 写入的 Git 仓库、ACP 输出与终端流、
Registry / 自定义分发归档、导入的 Conversation bundle、Windows `.cmd` 参数、
前端传入的绝对路径。它们不得被 Host 当成已引用 argv、已约束路径或已消毒 HTML。

审查按六项进行：内存安全、锁安全、数据处理安全、命令执行安全、Git 操作安全、
前后端性能。下面先给出信任模型，再按项列出发现，最后给出加固顺序与不可回退的
控制。

## Decision

### 1. 信任模型

1. 用户启用的 ACP Agent、已安装或已启用的 VibeX Plugin Package、用户编写的仓库
   脚本、交互式 PTY，均为全信任本机代码。Host 不为它们声称 OS 级隔离。
2. Workspace-less Conversation 在领域上是能力受限的低权限模式（ADR-0006）。ACP
   `CreateTerminal` 的 program / cwd / env 目前未执行该约束；后续实现必须补上，
   不得把「低权限」只写在文案里。
3. Plugin `isolated` 残留路径（Seatbelt / Landlock / 写整个临时目录）不是安全边界，
   与 ADR-0048 冲突。不得把它宣传成沙箱；后续要么删除，要么另开 ADR 定义独立
   package class。
4. 鉴权、配对、token、配置文件机密不在本基线内。本机文件被 **Agent 输出或恶意
   仓库** 读到，属于本基线（路径约束与 WebView 资源加载），不属于「远程数据泄露」。

### 2. 缺陷与产品假设的划分

**产品假设（不单列漏洞，除非实现偏离假设）：**

- ACP Agent 及其拉起的子进程（含终端）。
- 全信任 Plugin Worker / App / 声明的 Runtime。
- 用户仓库脚本经 shell 执行。
- 在 Workspace 目录打开真实 shell。
- 用户确认后的 force-push、reset、revert all。

**必须修复的缺陷：** 意外注入、无界资源、锁身份错误、同步阻塞异步运行时、以及
Git/归档/UI 字符串在未经校验时进入 Host 副作用。

### 3. 内存安全

Rust 热路径没有随意 `transmute`。`unsafe` 集中在 CEF、Landlock/seccomp、Win32 job、
`getifaddrs`、`std::env::set_var`。内存风险是无界缓冲和「先整文件读再截断」。

已核实的缺陷：

1. ACP `CreateTerminal.output_byte_limit` 在 `crates/agents/src/terminal.rs` 被
   `as usize` 后当作历史上限。未传时默认 512 KiB；Agent 传入 `u64::MAX` 时
   `trim_output_history` 永不丢弃。`yes` / `cat /dev/zero` 可把 Host 打到 OOM。
   必须设硬上限（4–16 MiB），忽略更大的 Agent 值。
2. ACP → Conversation 持久化使用两段 `mpsc::unbounded_channel`（连接 runner →
   manager pump，runtime sink → SQLite recorder）。持久化明确不丢事件；coalesce
   发生在 `recv()` 之后。快 Agent 加慢 SQLite 会在内存堆积信封。`broadcast(512)`
   只保护 UI。8 ms 窗口内的 `pending.text` 无字节上限。PTY / Agent 终端订阅同样
   无界；历史有 512 KiB cap，在途队列没有。必须改为有界 channel，在生产者侧
   coalesce，并对单 Turn 字节设顶。
3. `read_utf8_text_file` 与 `read_file_with_truncation`
   （`src-tauri/src/commands/file_tree.rs`）先 `std::fs::read` 再按 512 KiB 切片。
   `crates/git/src/diff_ops.rs` 的 `read_file_to_string` 同样先读完全部再与
   `MAX_INLINE_DIFF_BYTES`（2 MiB）比较。必须先 `metadata().len()` 或有界 `read`。

其它观察：Log hub 5_000 条 / 4 MiB 且 poison 可恢复；Agent stderr ring 8 KiB；
`recent_events` 2_000；插件协议帧 1 MiB；delegation 帧 16 MiB；WebSocket 1 MiB。
`MsgStore` 约 100 MiB × 每个脚本进程，有界但偏大。SQLite `cache_size=-65536`
（64 MiB）× `max_connections(20)` 理论上限约 1.2 GiB。`session_locks` 与
worktree 创建锁 HashMap 只增不删，长会话慢泄漏。Diff stream 累计 200 MiB 才
omit。edition 2024 下运行中 `set_var`（PATH 刷新、代理）是 data race，应在启动
单线程阶段改环境，或把 env map 传给子进程。

### 4. 锁安全

同一 Conversation 同时最多一个在途 Turn（见 CONTEXT.md Turn 定义）。实现有两处
锁身份/持有范围错误。

已核实的缺陷：

1. `crates/agents/src/terminal.rs` 的 `spawn_waiter` 在整个子进程生命周期持有
   `session.child` 再 `wait()`。`kill_terminal` / `release_terminal` 需要同一把
   锁才能 `kill()`。`kill_on_drop(false)` 使登记项 drop 后进程仍活着。UI 停止会
   等到进程自行退出。必须把 wait 与 kill 拆开，使用 `start_kill()` 或独立句柄。
2. `truncate_to_turn` / `rebind_session` 持有 `_turn_guard` 时调用
   `invalidate_agent_session` → `forget_conversation_runtime`，从
   `conversation_turn_locks` 删掉该 Conversation 的 mutex。并发 `start_turn` /
   `dispatch_next_queued_input` 会 `or_insert` 一把新锁，两个任务都以为自己独占。
   这正是 `cancel_turn` 注释所防的双在途 Turn。Delegation broker 已用 `Weak` +
   `strong_count` 做对。有 guard 时不得 remove；只在 `strong_count == 0` 时 prune；
   forget 必须在 guard drop 之后。
3. `start_turn_under_lock` 把 turn 锁拿到 ACP handshake / worktree / SQLite。
   `cancel_turn` 共用这把锁，取消可能等到 handshake 超时（约 60s）。锁只应覆盖
   idle-check → claim → 写入 active-turn 指针。

其它观察：connection `send_command` 先 clone sender 再 await，Delegation broker
的 std mutex 不跨 `.await`，这两处保持。Warmup mutex 跨整个 probe await，重入会
死锁。大量 `.lock().unwrap()`（MsgStore、delegation pending、filesystem watcher）
在临界区 panic 后会毒死 Host；log hub 已 `into_inner`。Windows isolated 路径
`mem::forget(job)` 配合 `KILL_ON_JOB_CLOSE` 会泄漏 job 且停不干净 worker。PTY 在
async API 上使用 `std::Mutex` 与 OS 线程，可能堵住 tokio worker。未发现经典
A→B / B→A 循环；风险是同锁重入和锁对象被换掉。

### 5. 数据处理安全

审查路径上没有把用户输入拼进 SQL。Workflow JSON Schema 有关键字白名单（禁止
`$ref`）。插件 ZIP 导入路径约束完整。缺口在路径逃逸、大小上限、以及把 Agent
输出当 WebView 资源。

已核实的缺陷：

1. `AstryxMarkdown` 的 `resolveLocalMarkdownImagePath` 接受 `file://` 和任意绝对
   路径，再交给 `convertFileSrc`。相对路径拼 `workspacePath` 时不拒绝 `..`。
   `tauri.conf.json` 的 CSP 为 null，capabilities 对 fs 为 `**`。Agent 或导入
   历史里的 `![](/etc/passwd)` 会在 WebView 加载。只允许 canonicalize 后落在
   Workspace 或 `.vibe-images` 下的路径。
2. Conversation 事件的 `normalized_json` / `raw_json` 追加无上限。bundle 导出计算
   checksum，导入不验证；无线长、无 JSON 深度限制。导入必须验 checksum，追加必须
   限制行字节、事件数和 JSON 大小。
3. 桌面 Agent zip 校验 symlink target；`tar -xf` 无 `--no-absolute-names`、无
   symlink 策略、无条目上限。`crates/server/src/agent_install.rs` 的 zip 连
   symlink 校验都没有，且 `find_staged_executable` 按文件名在解压树里挑选。
   所有 Agent 归档必须复用插件 ZIP 规则（`enclosed_name`、拒 `..`、拒绝对路径、
   校验 symlink、条目/深度/未压缩字节上限）。
4. `sanitize_file_path` 只拒绝 `..` 组件并要求绝对路径，不限制在 Workspace；注释
   中的父目录层级检查未实现。`effective_working_dir` 与图片 copy 的
   `agent_working_dir` 对 `..` 未丢弃。git `workdir.join(rel_path)` 可跟随 index
   中的 `../../../x`。Artifact 相对路径有测试，保持。文件监视与 tree walk 已
   `follow_links(false)`，保持。

其它观察：图片 20 MiB 字节上限且不解码，避开像素炸弹；类型只看扩展名并允许 SVG。
`FileIcon` 使用内部 SVG 表。Registry `icon_svg` 经 `sanitize_registry_svg` 拒绝
script / event / `url()`，是拒绝名单不是解析器。KaTeX 使用
`dangerouslySetInnerHTML`，应显式传入 `trust: false` 与 `maxExpand`。Mermaid 为
`securityLevel: 'strict'`。Plugin App iframe 按 ADR-0048 不是沙箱。SQLite 为 WAL +
`synchronous=NORMAL` + `busy_timeout=10s` + `BEGIN IMMEDIATE`；崩溃可能丢掉最后
一笔，一般不损坏。事件同时存 normalized、raw 和 `fold_json`，磁盘与 cache 叠三份。

### 6. 命令执行安全

Git 与 Agent 主路径使用 argv 数组，不把会话事件或 MCP JSON 拼进 Host `sh -c`。
意外注入集中在 Windows cmd、解压和「结构化 API 缺少约束」。

已核实的缺陷：

1. `crates/utils/src/process.rs` 在 Windows 把 `.cmd` / `.bat` 包成
   `cmd.exe /d /c <shim> <args>`。Rust `Command` 不按 cmd 规则引用参数，`&` `|`
   `>` `%VAR%` 由 cmd 解释。影响 `npm` / `npx` shim、原生 plugin import、经同一
   helper 的 Agent 终端。必须对 `.cmd` 参数做 `^` 转义，或只 `CreateProcess` `.exe`。
2. ACP `CreateTerminal` 不走 `RequestPermissionRequest`。Agent 自选 program、argv、
   任意 cwd 和 `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES`。对用户启动的 Agent 这是全
   信任；Workspace-less 的低权限根目录必须在此路径强制执行。
3. 交互 PTY 的 `shell` 前端有白名单，后端没有。远程 `TerminalCreate` 可传入任意
   可执行文件。后端必须与前端白名单一致。
4. GitHub 登录用 `osascript` 时按 C 风格 `\"` 逃逸；AppleScript 字符串转义是
   `""`。Windows 登录前缀 `set "KEY=value"` 不转义 value 中的 `"`。
5. ADR-0060 把用户 bin 放在 PATH 前面。被投毒的 `~/.local/bin/git` 或 `tar` 会赢过
   `/usr/bin`。这是用户环境安装的后果，Host 对 `git` / `tar` 应解析绝对路径并在
   调用时固定，而不是每次 `which`。

`ScriptRequest` 的 `sh -c` 是用户仓库脚本的有意行为；`working_dir` 仍须拒绝 `..`。
ACP Agent spawn 使用绝对锁定路径 + argv，插件 ZIP / runtime 归档路径约束，官方
MCP 注入使用 Host 定位的 `vibex-mcp` 二进制，这些保持。

### 7. Git 操作安全

工作树变更走 Git CLI 而非 libgit2，以避免默认覆盖未提交变更，见
`crates/git/src/cli.rs` 模块说明。`crates/git/tests/git_ops_safety.rs` 覆盖 rebase
不碰 untracked、脏树拒绝、untracked 覆盖风险。缺口是 hooks、ref 校验、环境继承
和主工作树。

已核实的缺陷：

1. `git_impl` 只设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never` 和
   `safe.directory=<path>`。没有 `core.hooksPath`、没有 `--no-verify`。commit /
   merge / rebase / checkout / pull / push / cherry-pick 会执行仓库
   `.git/hooks/*`（worktree 共享主仓库 hooks）。每次调用必须加
   `-c core.hooksPath=<空目录>`、`-c submodule.recurse=false`、
   `-c protocol.file.allow=never`；Host 发起的 commit 使用 `--no-verify`，除非
   产品明确要跑用户 hooks。
2. `git2::Branch::name_is_valid` 只用于 workspace 重命名和 branch prefix。
   checkout / create / delete / worktree add / reset / show / push refspec 把字符串
   当 argv 原样传递，且多数命令没有 `--`。以 `-` 开头的名字会被当成 git 选项。
   `+refs/heads/{branch}:refs/heads/{branch}` 在 `branch = "*"` 时变成对所有 heads
   的 force 更新。`fetch_branch` 用同样的 `+` refspec 更新 **本地** heads，当前无
   IPC 调用方，但不得再被接上。所有 ref 必须先 `name_is_valid`，拒绝 leading `-`、
   `:`、`*`、`..`，并在 ref 前加 `--`。
3. 若目标分支已在某工作树 checkout（通常是用户项目的 `main`），merge / rebase-back
   会 checkout 那棵树、squash-merge、commit，再 `update_ref` 把 task 分支指到
   squash SHA。隔离 worktree 不是唯一被修改的树。有 staged 则拒绝；不得再切用户
   主工作树，应在 throwaway worktree 或纯 ref 更新上完成。
4. `reset --hard`、`checkout HEAD -- .` + `clean -fd`、`worktree remove --force` +
   `remove_dir_all`、`branch -D` 都是一等 IPC。`revert_repo_all` 作用在注册的用户
   仓库路径。`restore_all` 后端没有脏检查。checkpoint 重置默认
   `perform_git_reset: true`、`force_when_dirty: false`。force-push 使用 `+` refspec
   而非 `--force-with-lease`。对用户主仓库的破坏性操作必须有独立确认通道，且不得
   默认作用在非 Host 管理的 worktree 上。
5. 父进程全部 `GIT_*` 被继承。`GIT_DIR` 覆盖 `-C`。从设了 `GIT_DIR` 的 shell 启动
   会打到错误仓库。每次调用应 `env_remove` 全部 `GIT_*`，再写入显式白名单。
6. libgit2 `set_verify_owner_validation(false)` 是 Windows 所有者不匹配的有意
   workaround，等于关闭 dubious-ownership。保持该 workaround 时，必须靠 hooksPath
   与 env 剥离补上。
7. `is_rebase_in_progress` 对相对 `--git-path` 做 `Path::exists()`，相对的是进程
   CWD 不是 worktree。worktree 创建锁 key 使用原始路径的 `to_string_lossy()`，
   macOS 上 `/var` 与 `/private/var` 不碰撞。`worktree prune` 在单路径锁下运行，
   可能清掉同一仓库其它正在创建的 metadata。锁 key 必须 canonicalize。

clone 走 libgit2 且拒绝非空目标目录。文件级 add / restore / clean 使用 `--`。
copy-into-worktree 拒绝 `..` 与绝对路径。rebase 拒绝脏 tracked 文件。这些保持。
Host 当前不调用 `submodule` 命令；若用户或仓库 config 打开 `submodule.recurse`，
系统 git 的 checkout / pull 仍会递归，因此每次调用仍须 `-c submodule.recurse=false`。

### 8. 性能

事件源、快照、增量 row-ops、时间线虚拟列表的方向保持。瓶颈是打开路径仍物化整条
时间线，以及 SQLite 单写者被 8 ms 流和同步 git 争用。

已核实的缺陷：

1. `conversation_detail_core` 每次 `ConversationProjector::project`，再把每条
   message 克隆进 `turns`，再经 IPC 发送整份 `DbConversationDetail`。前端只调用
   `detail()`。`conversation_timeline_page` 存在但先投影再内存切片，UI 未使用。
   打开必须只返回最近 N 行或按字节封顶的快照加 `last_sequence`；`turns` 不再上线。
2. 快照只在 Turn 终态刷新。长 Turn 期间每次 detail、gap backfill、incremental
   reload 都重放上一 Turn 之后的全部事件。增量 projector 在 settle 后被 drop
   （UI 从不 `close_conversation`）。一 Turn 内必须每 N 个事件或每 N 秒刷新
   `fold_json`。
3. `CONVERSATION_STREAM_FLUSH_INTERVAL` 为 8 ms，约 125 次 `BEGIN IMMEDIATE` /
   秒 / 活 Turn。窗口内 coalesce，但两个 Agent、git status 轮询和 detail 仍抢同一
   写者。`busy_timeout=10s` 时 UI 卡住而不是立刻失败。落库改为 50–100 ms；8 ms
   只留给 overlay 文本（若仍需要）。
4. `get_workspace_git_status` 等 async 命令直接调用 `GitService`，无
   `spawn_blocking`。`get_detailed_status` 跑 `git status`、两次 numstat、打开
   libgit2；无 numstat 的 untracked 会整文件读来数行。前端活跃轮询 3 s，≥120
   文件时 12 s。Diff stream 与 worktree manager 已经 `spawn_blocking`。所有 git
   面板命令必须 `spawn_blocking`；git status 应改走已有 FS watcher。`git_impl`
   每次 `ensure_available`（再跑 `git --version`），超时用 `thread::sleep(100ms)`
   忙等上限 60 s，必须改为缓存 git 路径与真正的超时。
5. `list_directory_children` 在 async 运行时递归扫描（`get_file_tree` 才
   `spawn_blocking`）。有 30_000 条目 / 1.2 s 预算，等待仍占运行时。Dock 面板走
   这条路径。Watcher 启动时 walk 全部目录；Linux 每目录一个 inotify；notify 回调
   里 `block_on`。Diff stream 每文件 2 MiB、累计 200 MiB 才 omit。

前端：TanStack virtualizer、rAF 批 row-ops、`AstryxMarkdown` / `CodeBlock` memo
保持。每次 upsert `rows.map` 整表拷贝，每帧对 timeline 排序，流式 markdown 每
token 重 prepare。`conversation-events` 是进程级再按 id 过滤。Git / children
（5 s）/ workflow（100–150 ms）在已有事件通道旁仍轮询。Find-in-conversation 打开
时全字符串扫描。

系统性模式：读模型仍是整条时间线；SQLite 单写者是全局时钟；`spawn_blocking` 使用
不一致；进程级 Tauri 事件而非每会话 channel；投影 clone 重。

远程 attach 在 `after_sequence == 0` 时最多 10_000 条原始事件；live gap 500。
Conversation 列表 `list_for_workspace` 无 LIMIT，`list_recent` 限制 500。

### 9. 加固顺序

按用户可感知故障排序，不按理论 CVE 排序：

1. Agent 终端 kill：`wait()` 不得持有 `Child` 锁。
2. Turn 锁身份：有 guard 时不得 `forget`；用 `Weak` prune。
3. Git：每次调用剥离 `GIT_*`，加 hooksPath / submodule.recurse / protocol.file；
   Host commit 使用 `--no-verify`。
4. 会话打开分页；打开路径去掉重复的 `turns`。
5. Git 面板与 `list_directory_children` 全部 `spawn_blocking`。
6. 流式落库 8 ms → 50–100 ms；Turn 中途刷新快照。
7. Windows `cmd /c` 参数引用；Agent tar/zip 复用插件 ZIP 规则。
8. 所有 ref 经 `name_is_valid`，ref 前加 `--`；禁止把 `*` 插入 refspec。
9. 有界 ACP / PTY channel；clamp `output_byte_limit`；有界 `fs::read`。
10. Markdown 图片限制在 Workspace；bundle 导入验 checksum。
11. Merge / rebase-back 不得 checkout 用户主工作树。
12. Git status 改 FS watcher；每会话事件 channel；store 原地更新。

同一条 Host 代码路径的 Desktop 与 `vibex-server` 必须一起改（ADR-0033）。不得只在
桌面或只在 server 打补丁。

### 10. 不可回退的控制

后续改动不得削弱：

- Git 工作树变更走 CLI argv，文件 pathspec 使用 NUL 或 `--`。
- rebase / merge 的脏树、untracked 覆盖、base-ahead 测试。
- 插件 ZIP 导入的 `enclosed_name`、拒 `..` / `\` / symlink、条目 / 深度 / 字节上限。
- 插件 digest 排除 `config.json`、拒绝包内 symlink、freeze 后重哈希。
- Workflow schema 关键字白名单与节点 / 深度上限。
- SQLite WAL、busy_timeout、热索引 `(conversation_id, event_kind, sequence DESC)`。
- 流 coalesce、增量 row projector、前端 dumb store（消灭双投影）。
- 时间线虚拟列表与 rAF 批处理。
- ACP 工具预览截断（16 KiB / 4 张图）、stderr ring、registry 体 4 MiB / icon 128 KiB、
  registry SVG 消毒。
- Artifact 相对路径约束及测试。
- ACP 客户端 `fs/read` / `fs/write` 返回 `method_not_found`。
- 安装并发有界（ADR-0026）。
- 文件树跳过 `node_modules` / `target` 等与扫描预算。

## Consequences

- Host 继续对用户启用的 Agent 和 Plugin 保持全信任，文档与 UI 不得声称第三方插件
  或 Agent 终端被隔离。
- Git、归档、Windows 进程包装、会话打开和 Turn 协调成为明确的加固面；实现偏离本
  ADR 第 3–8 节时，应按缺陷处理，而不是当作「本地应用可以宽松」。
- 会话打开改为分页后，前端不得再假设一次 `detail()` 含有全部 timeline；live
  row-ops 与 `last_sequence` 仍是权威增量。
- 禁用仓库 hooks 后，用户若依赖 pre-commit 在 VibeX 内运行，需要单独的产品决定；
  默认不在 Host 发起的 git 操作里执行仓库脚本。
- `isolated` 插件类若仍可安装，会与 ADR-0048 和本 ADR 同时冲突，必须在实现中删除
  或另开 ADR。
- 本 ADR 不取代 ADR-0001 的崩溃恢复语义、ADR-0044 的 Turn 控制面，或 ADR-0058 的
  辅助能力诚实原则；它只把那些领域里的资源与锁实现约束写清楚。

## 审查边界

- 静态审查，没有 fuzz，没有用大仓库或长会话压测。
- 未评鉴权、配对、token、配置文件机密。
- Headless `vibex-server` 与桌面共用 Application Core；Git 与解压问题两边都有，
  服务端 zip 更松，加固必须两边一起做。
