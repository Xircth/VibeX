---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# 三窗格冲突编辑器：冲突是工作区事实，解决只写工作区

冲突解决从「把冲突文件名交给 AI」升级为用户可以逐块处理的三窗格编辑器，入口
落在工作区 Git 面板。宿主新增读取索引三个 stage 与写回解决结果的能力，但
**不自动提交、不自动 continue、不自动推送**。

本决定不改变 [ADR-0068](0068-workspace-default-surfaces-and-activity.md) 的面板
模型，也不放宽自动化不得自动合并推送的约束。

## Context

冲突能力今天到 `crates/git/src/conflict_ops.rs` 为止：

```rust
is_rebase_in_progress / detect_conflict_op / get_conflicted_files
abort_rebase / continue_rebase / abort_conflicts
```

`ConflictOp` 有 `Rebase | Merge | CherryPick | Revert` 四种，但只有 rebase 能
`continue`；merge / cherry-pick / revert 只能 abort。

**不存在**的能力（全仓库确认）：读取冲突文件的 stage 1/2/3（base / ours /
theirs）、写回解决后的内容、标记已解决（只有通用 `git add`）、三方合并的数据
类型。

UI 侧有两个组件，都不解决冲突：
- `ConflictBanner` 提供 Resolve / Open in Editor / Abort 三个回调，「Open in
  Editor」只是用 `useOpenInEditor` 打开第一个冲突文件的普通编辑器——用户面对的
  是带 `<<<<<<<` 标记的原始文本。
- `GitConflictResolutionDialog` 把冲突文件名拼成 prompt 发给 Agent。

而且这两个都挂在**会话侧**（`FollowUpConflictSection`）。工作区 Git 面板
（`GitPanel`，模式 `diff | log | branches | issues | prs`）里没有冲突分区：一个
处于冲突态的工作区，在它自己的 Git 面板上看不出来。

前端能力边界也需要先确认：本地 Monaco 是 0.55.1，`widget/` 下只有
`codeEditor` / `diffEditor` / `multiDiffEditor`，**没有 `mergeEditor`**。
`createDiffEditor` 可用，三窗格合并控件不可用。

## Decision drivers

1. 冲突是工作区的状态，应该在工作区的 Git 面板上看得见。
2. 解决冲突的最小可信单位是「这一块取哪边」，不是「这个文件交给谁」。
3. 写回的边界越窄越安全。

## Decision

### 1. 宿主提供三个 stage 与冲突块，前端不解析冲突标记

`crates/git` 新增读取能力：对一个冲突路径返回 base（stage 1）、ours（stage 2）、
theirs（stage 3）三份内容，以及各自是否存在（新增/删除冲突时某个 stage 会缺
失，缺失就是缺失，不用空串顶替）。

冲突块的切分同样由宿主给出，基于 git 的三方合并结果，**不由前端去 parse
`<<<<<<<` / `=======` / `>>>>>>>`**。前端解析标记会在文件本身含有这类文本时
出错，而且每个前端入口都要重写一遍。

### 2. 写回只做两件事：写文件、标记已解决

新增写回能力：把解决后的完整内容写入工作区文件，以及把该路径标记为已解决
（`git add`）。

**不做**：不 commit、不 `--continue`、不 push。continue 与 abort 仍是用户在
Git 面板上的显式动作。这与自动化路径的既有约束一致——宿主不替用户决定一次
合并是否完成。

`continue` 能力需要从只支持 rebase 补齐到覆盖 `ConflictOp` 的四种；今天
merge / cherry-pick / revert 解决完冲突后无路可走，只能 abort，这是必须一起
修的缺口，否则三窗格编辑器在这三种操作下解决完了仍然卡住。

### 3. 三窗格由两个 DiffEditor 加一个可编辑 CodeEditor 组成

本地 Monaco 没有合并控件，**不为此引入新的编辑器依赖**。布局：

- 左：base ↔ ours 的 `DiffEditor`（只读）
- 右：base ↔ theirs 的 `DiffEditor`（只读）
- 下/中：结果区，可编辑的 `CodeEditor`，初值是 git 的三方合并输出

逐块动作作用于结果区：取 ours、取 theirs、两者都取（按顺序）、手工编辑。
手工编辑与逐块选择共用同一个结果缓冲区，没有「选择模式」与「编辑模式」的
互斥——用户可以先选块再改字。

### 4. 独立面板，独立 panel id

新增 `PANEL_IDS.MERGE`，在 `PANEL_COMPONENT_MAP` 与 `usePanelMeta` 登记，
通过 `PanelActionsContext` 上的开启动作打开，面板 id 形如 `merge:${filePath}`。

不复用 `PANEL_IDS.PREVIEW` 加一个 `mode: 'merge'`。预览面板的参数
（`PreviewPanelParams`）是围绕单文件内容与 diff 建的，合并需要三份内容加
一个可写缓冲区与未保存状态，塞进去会让预览面板承担两种生命周期。

### 5. 冲突分区进 Git 面板

`GitPanel` 的 diff 模式在暂存区之上增加冲突分区，仅在
`detect_conflict_op` 返回非空时出现。分区列出冲突路径与各自的已解决状态，
点击打开合并面板，底部是 continue / abort。

会话侧的 `ConflictBanner` 保留，它服务的场景不同（Agent 跑完一次合并后就地
提示）。它的「Resolve」改为打开合并面板，「Open in Editor」移除——打开一个
带冲突标记的原始文件不是一个应该保留的动作。

### 6. 交给 Agent 仍然可用，粒度收到块

`GitConflictResolutionDialog` 不删。它从「整个工作区的冲突文件列表」改为可以
从合并面板对**当前文件或当前块**发起，prompt 里带上 base / ours / theirs 的
实际内容而不只是文件名。

人和 Agent 走同一条写回路径：Agent 的产出也落到结果缓冲区，由用户确认后写回。
不新增一条 Agent 直接写工作区的冲突解决通道。

### 7. 未保存的解决结果不静默丢弃

结果缓冲区在面板关闭时若有未写回内容，必须显式确认。合并冲突的中间状态重建
成本很高，静默丢弃是不可接受的。

## Consequences

- `crates/git` 增加 stage 读取、冲突块切分、写回与标记已解决四类能力，以及
  merge / cherry-pick / revert 的 continue。IPC 层同步新增命令。
- 新增一个 Dockview 面板类型，`PANEL_IDS` 与相关注册表变化。
- `GitPanel` 的 diff 模式多一个条件分区；冲突态第一次在工作区侧可见。
- 三窗格用两个 DiffEditor 拼装，与真正的合并控件相比缺少一些交互糖（例如
  块级导航高亮的连贯性）。这是为不引入新依赖付的确定成本。
- 二进制文件与超大文件的冲突不适用三窗格。这类路径只提供「取 ours / 取
  theirs」两个整体动作，不进编辑器。
- 子模块冲突不在范围内。

## Considered Options

- **引入独立的合并编辑器库**：否决。前端已有 Monaco 与 `@git-diff-view/react`
  两套 diff 渲染，再加第三套会让 diff 呈现在三个地方各不相同。
- **升级 Monaco 到含 mergeEditor 的版本**：否决。`mergeEditor` 是 VS Code 工作台
  的一部分而非 `monaco-editor` 发行包的公开控件，靠升级拿不到；且为一个面板
  升级编辑器内核会波及所有编辑面。
- **前端解析冲突标记做三窗格**：否决。文件内容与冲突标记无法可靠区分，且解析
  逻辑会在每个入口重复。索引里的三个 stage 才是 git 的事实。
- **解决后自动 continue**：否决。用户可能只想解决一部分文件后停下检查；自动
  continue 会把一次可回退的中间状态变成不可回退的提交。
- **只扩展现有 AI 对话框，不做手工编辑**：否决。冲突解决必须有不依赖 Agent 的
  路径——Agent 不可用或判断错误时，用户需要能自己处理。
