# Task Statement

修复以下问题：
1. 首页删除确认多嵌套一层，大外层去掉。
2. “已删除项目 xx” toast 没有跟随主题变化。
3. AI 输出完毕且主窗口失焦时，没有在桌面右下角弹出自定义通知窗口。
4. AI 回复渲染时先出现重复字符，再快速恢复正常。
5. 同一会话多轮对话时，Codex 在“AI 正在思考中”停留过久，首个输出出现慢。
6. 创建新工作区时，偶发只有 `.git` 无其他文件。

# Desired Outcome

- 首页删除确认只保留一层居中确认 UI，删除成功提示与主题联动。
- AI 完成后，主窗口失焦时稳定出现桌面右下角自定义通知。
- 流式回复不再出现重复字符的中间态。
- 同一会话多轮对话的首包延迟显著下降，避免不必要的整段重载/持久化阻塞。
- worktree 创建后稳定 materialize，避免仅 `.git` 的损坏目录。

# Known Facts / Evidence

- 仓库已有相关改动：`WelcomePage.tsx`、`sonner.tsx`、`DesktopToastWindow.tsx`、`desktop_toast.rs`、`Markdown.tsx`、`useConversationHistory.ts`、`EntriesContext.tsx`、`crates/git/src/lib.rs`、`crates/services/src/services/worktree_manager.rs` 等文件已被修改。
- 当前工作树很脏，存在大量用户/既有改动，不能回退非本次问题相关内容。
- 桌面通知状态在 `src-tauri/src/state.rs` 与 `src-tauri/src/commands/desktop_toast.rs`。
- 流式会话逻辑集中在 `frontend/src/hooks/useConversationHistory/useConversationHistory.ts`、`frontend/src/contexts/EntriesContext.tsx`、`frontend/src/components/NormalizedConversation/Markdown.tsx`。
- worktree / workspace 创建逻辑集中在 `crates/git`、`crates/services`、`crates/local-deployment`、`src-tauri/src/commands/workspaces.rs` / `sessions.rs`。

# Constraints

- 不回退用户已有未提交改动。
- 优先根因修复，避免渲染层临时遮盖。
- 需要最终提供验证证据。

# Unknowns / Open Questions

- 删除确认“多嵌套一层”是 `DialogContent` 外层还是手写 overlay/card 再包了一层。
- 桌面通知不弹是 ready 事件时序、焦点判定，还是窗口显示/事件投递问题。
- 重复渲染来自 markdown 渲染器、流补丁应用，还是 entries 持久化回放竞争。
- 多轮慢的主要瓶颈是流订阅建立、历史重载，还是持久化抖动。
- `.git only` 是 git worktree add 本身失败后被当作成功，还是后续 copy/materialize 步骤异常。

# Likely Touchpoints

- `frontend/src/components/welcome/WelcomePage.tsx`
- `frontend/src/components/ui/sonner.tsx`
- `frontend/src/components/desktop-toast/DesktopToastWindow.tsx`
- `src-tauri/src/commands/desktop_toast.rs`
- `src-tauri/src/state.rs`
- `frontend/src/components/NormalizedConversation/Markdown.tsx`
- `frontend/src/hooks/useConversationHistory/useConversationHistory.ts`
- `frontend/src/contexts/EntriesContext.tsx`
- `crates/git/src/lib.rs`
- `crates/services/src/services/worktree_manager.rs`
- `crates/local-deployment/src/container.rs`
- `src-tauri/src/commands/workspaces.rs`
- `src-tauri/src/commands/sessions.rs`
