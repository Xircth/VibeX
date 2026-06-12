# Requirements: Phase 0 — 基线稳定化 (baseline-stabilization)

## Objective

在开始任何 Codeg 对齐改造之前，把仓库恢复到「全部验证门绿色 + 在途工作已形成
保存点」的状态。修改-审查-测试循环要求基线可信，否则后续每个 Phase 的回归信号
都会被噪声淹没。

## User Stories

- 作为维护者，我希望 `cargo test --workspace` 能在干净 checkout 上编译并通过，
  以便任何 Phase 的回归都能被立即发现。
- 作为维护者，我希望前端测试套件全绿，以便后续 UI 改造能以测试锁定行为。
- 作为维护者，我希望在途的 agents 运行时/AgentSettings 工作被提交为保存点，
  以便 Phase worktree 能从包含它们的 master 切出，不产生合并冲突。

## Acceptance Criteria (EARS)

1. WHEN 在全新 shell 中运行 `cargo test --workspace`，THE SYSTEM SHALL 编译
   全部 crate 并通过全部测试（H1：当前 `db` crate 因 SQLx `query!` E0282 编译
   失败——根因是新增查询未进入 SQLx 离线缓存或 DATABASE_URL 未配置；修复必须
   落在仓库配置/缓存层，不允许把 `query!` 改成无校验的 `query_unchecked!` 来
   规避）。
2. WHEN 运行 `cd frontend && pnpm vitest run`，THE SYSTEM SHALL 全部 649 个
   测试通过。已知失败 4 例（H2）：
   - `UserMessage.test.tsx` > keeps structured composer tokens as chips after send
   - `sessionComposerSubmit.test.ts` > serializes file reference components before queueing backend text
   - `sessionComposerTypeahead.test.ts` > filters slash commands and keeps commands before skills
   - `UseSessionComposerDraftScratch.test.tsx` > loads draft scratch by target id
   修复方向：先判定是「实现回归」还是「测试过期」（在途修改将 executor 概念迁
   移到 agent 概念），对每例给出判定证据后再修，不允许直接删测试。
3. WHEN 修复完成，THE SYSTEM SHALL 将在途修改（crates/agents 运行时连接复用、
   AgentSettings 扩展、tauriApi、transcript 测试等）与测试修复一起形成不超过
   3 个原子提交（H4），每个提交通过全部验证门。
4. WHERE `CLAUDE.md`/`AGENTS.md` 已被删除（H3），THE SYSTEM SHALL 不在本阶段
   提交该删除，也不恢复文件；保持工作树该状态原样并在阶段报告中向产品负责人
   明示，等待其决定（这是会话开始前已存在的用户态修改）。
5. WHEN 全部完成，运行 `pnpm run check`（frontend:check + backend:check）与
   `pnpm run lint` SHALL 通过。

## Edge / Error Cases

- SQLx 修复若需要重新生成 `.sqlx` 缓存，必须运行 `pnpm run prepare-db` 并核对
  `pnpm run prepare-db:check` 通过；不得手工编辑缓存 JSON。
- 若 4 个失败测试中任何一个揭示的是真实运行时回归（而非断言过期），必须修复
  实现而非测试，并在提交信息中记录。

## Boundaries

- Always：每次修复后跑最窄相关测试，提交前跑全门。
- Ask first：无。
- Never：删除失败测试；`git reset --hard`；提交 CLAUDE.md/AGENTS.md 的删除；
  修改与基线修复无关的代码。

## Success Criteria

- `cargo test --workspace`、`pnpm vitest run`、`pnpm run check`、`pnpm run lint`
  全绿；`git status --short` 仅剩 `D CLAUDE.md`/`D AGENTS.md` 两行。

## Open Questions

- CLAUDE.md/AGENTS.md 删除是否符合产品负责人意图（阶段报告中提出）。
