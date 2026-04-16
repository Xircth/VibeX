# PRD: Ralph UI Fixes

## Goal
Repair four user-visible regressions in the current desktop UI:

1. Existing-session follow-up messages should stream immediately after send.
2. Relevant titles and descriptions should display Chinese copy instead of English or mojibake.
3. File-tree copy actions should be grouped under a single top-level `复制` menu.
4. The `计量统计` module should report accurate data.

## User Stories

### US-001 会话流式渲染
As a user reopening a session from history, I want follow-up output to appear incrementally after I send a message so that I can see the hook/session is actively working.

Acceptance criteria:
- After sending from an existing session, the conversation list does not stay on a generic loading-only state until completion.
- Incremental entries or process updates become visible while the run is ongoing.
- Existing new-session behavior does not regress.

### US-002 中文界面文案
As a Chinese-speaking user, I want touched feature titles and descriptions to render in Chinese so that the UI is consistent and understandable.

Acceptance criteria:
- Affected labels in the modified modules use Chinese copy.
- Known mojibake strings in touched modules are corrected.

### US-003 文件树复制菜单
As a user opening the file-tree context menu, I want one `复制` entry with nested actions so that the menu is concise.

Acceptance criteria:
- The context menu no longer shows multiple flat copy-related actions.
- Hovering or clicking the top-level `复制` entry reveals the concrete options.
- Duplicate/copy-path actions still work.

### US-004 计量统计修复
As a user viewing `计量统计`, I want session/token/cost statistics to be accurate so that the dashboard is trustworthy.

Acceptance criteria:
- Statistics match the corrected aggregation logic and reference intent.
- Date filtering, per-session sorting, and totals remain internally consistent.
- No obvious NaN/negative/duplicated values are shown.
