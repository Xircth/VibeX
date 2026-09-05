# Codeg 对标补齐批次 — 实施计划

六项来自 Codeg 横向对比的改进。每项的事实来源是它自己的 ADR：

| # | 任务 | ADR |
|---|---|---|
| 1 | Qoder 接入为一等 Agent | [ADR-0072](../adr/0072-qoder-first-class-agent.md) |
| 2 | install.sh / install.ps1 | [ADR-0073](../adr/0073-one-line-install-and-release-asset-naming.md) |
| 3 | 失败分类与恢复可见性 | [ADR-0074](../adr/0074-turn-failure-taxonomy-and-recovery-visibility.md) |
| 4 | 计量改从 conversation_event 出 | [ADR-0075](../adr/0075-usage-accounting-from-conversation-events.md) |
| 5 | 三窗格冲突编辑器 | [ADR-0076](../adr/0076-three-pane-merge-conflict-editor.md) |
| 6 | Office 插件技能来源与预览寿命 | [ADR-0077](../adr/0077-office-plugin-skill-provenance-and-preview-lifecycle.md) |

## 先决事实（动工前必须实测确认）

这四条在审查中没有确认，凭文档或类比推断会把错误写进实现：

1. **Qoder CLI 的可执行名与 ACP 启动参数。** 官方 ACP 文档给 `qoder --acp`，
   Zed 页面写 `qoder acp`，阿里云文档验证的是 `qodercli --version`。
2. **Qoder 会话历史的落盘位置与格式。** 未确认前 `default_history_sources`
   返回空。
3. **officecli 1.0.140 是否提供 `load_skill` 子命令，以及可用的 skill id。**
   不提供就先升版本，不退回手写。
4. **Agent 是否在 `acp::Error.data` 里给结构化限流字段。** 决定任务 3 的
   `rate_limited` 首版覆盖率。抽样 Claude Code / Codex / Cursor / Kimi 各一次
   真实限流。

## 顺序与依赖

三条独立轨，可并行；轨内有序。

**轨 A — 分发与接入（任务 1、2）**

1. 资产命名模块，`host-family-release.yml` 与 `npx-cli` 改为从它推导。修掉
   `VibeX-*-server.tar.gz` 与 `vibex-host-family-*.tar.gz` 对不上的现存缺陷。
2. `install.sh` / `install.ps1`，两级校验，缓存目录与 npx 共用。
3. Release 工作流增加端到端安装冒烟。
4. `AgentKind::Qoder` + `qoder_profile()` + `BUILT_INS` + 图标 + onboarding 位。

顺序理由：任务 2 的第 1 步是修缺陷，越早越好；任务 1 与它无耦合，放在同轨只是
因为都属分发接入面。

**轨 B — 会话诚实性（任务 3、4）**

1. `error.code` 类型化并从 Rust 导出，前端改为穷尽消费生成类型。
2. 补 `rejected` / `service_error` 分类与各自的动作差异。
3. `AgentConnectionStatus::Recovering` 接到恢复窗口与重绑窗口；映射表扩展。
4. `prepare_session` 成功路径发 `AgentBindingRecovered{Loaded|Resumed|CreatedNewSession}`。
5. 清理：仍无生产来源的枚举变体删除，不留空位。
6. `rate_limited`：按先决事实 4 的抽样结果决定首版是否成立。
7. 计量聚合读模型（事件 → 按目录/按 Agent/按模型），带来源标记。
8. 厂商日志扫描器改为按 `external_session_id` 对齐，降级为分项补充。
9. 端到端 usage RFD 消费。
10. `KanbanUsageDashboard` 消费新形状，缺失显示为缺失。

顺序理由：3 在 4 之前，因为两者都要动 `shared/types.ts` 与投影，串行做只需一次
类型再生成。第 7 步是任务 4 的性能前提，不能留到最后。

**轨 C — 工作区能力（任务 5、6）**

1. `crates/git`：stage 1/2/3 读取、冲突块切分、写回、标记已解决。
2. `continue` 从只支持 rebase 补齐到覆盖 `ConflictOp` 四种。
3. IPC 命令 + `PANEL_IDS.MERGE` + 面板注册。
4. 三窗格组件（两个只读 `DiffEditor` + 可编辑结果区）。
5. `GitPanel` diff 模式的冲突分区；`ConflictBanner` 的 Resolve 改为打开合并面板，
   移除「Open in Editor」。
6. `GitConflictResolutionDialog` 粒度收到文件/块，prompt 带三个 stage 的内容。
7. 预览租约可续租 + 空闲判据改为「最后一次续租至今」（平台级，非 Office 专属）。
8. `idleTimeoutMinutes` 由宿主读取并生效。
9. Office 技能改为构建期从 officecli 生成；删手写副本；更新
   `content.index.json` 与 `targets`。
10. README 改写为真实闭环；修 `ncli` → `officecli`。

顺序理由：第 7、8 步是 `process_preview_host.rs` 的缺陷修复，独立于技能生成，
先做可以尽早解除「看到第 5 分钟被杀」。第 9 步依赖先决事实 3。

## 受测的接缝

- 资产名：CI 产出名与 `npx-cli` / 安装脚本解析出的名逐平台一致。
- 安装脚本：摘要不匹配时中止且清理；两级校验都覆盖。
- 失败分类：`-32600` / `-32602` 不出现重试按钮；`-32603` 出现；无证据的失败
  落 `unknown` 并原样显示 message 与 `rpc_{n}` 码位。
- 分类不看文本：构造一个 message 含 "rate limit exceeded" 但无结构化证据的失败，
  断言分类仍为 `unknown`。这条是 ADR-0058 的回归锁。
- 恢复：一次 `session/load` 成功后，已存在的加载失败通知被删除。
- 计量归属：worktree 与 project-root 指向同一仓库时，会话归属由
  `workspace_id` 决定而非路径匹配。
- 计量诚实：未提供分项 token 的 Agent 显示「未提供」，不显示 0；
  `context_used` 不与 token 分项相加。
- 冲突：新增/删除冲突下某个 stage 缺失时，三窗格不用空串顶替。
- 冲突：解决并标记后不自动 commit、不自动 continue。
- 合并面板关闭时有未写回内容必须显式确认。
- 预览租约：持续续租的预览超过原 5 分钟仍存活；停止续租后按
  `idleTimeoutMinutes` 回收。
- Office 技能：产物与锁定版本 officecli 的 `load_skill` 输出一致。

## 明确不做

- 无人值守任务引擎（Codeg `work_task`）。用户已决定暂不做。
- Forge（PR/Issue 双向写回）、Folder Links 多根工作区、桌面宠物、Project Boot。
- 为 Qoder 做托管安装（无可锁定摘要前）。
- Office 的一次性渲染降级路径（`officecli view html`，已被 watch 取代）。
- 用文本匹配补齐限流分类。
- 自动 continue / 自动提交冲突解决结果。

## 已知会引起用户困惑的变化

需要在发布说明里主动讲，否则会被当成 bug：

- 计量数字**变小**（未对齐的日志条目失去归属、缺失不再显示为 0）。
- 一次成功自愈后，失败通知会**自行消失**。
- `rejected` 类失败**没有重试按钮**。
- 连接不跨 Conversation 复用带来的进程数增加已在 ADR-0071 生效，本批次不改。
