# Report: Phase 0 — 基线稳定化

日期：2026-06-12

## H1: SQLx / cargo workspace

结论：基线编译失败来自 SQLx 离线缓存过期，同时 `scripts/prepare-db.js` 在
Windows 上生成了 `sqlite:C:\...` 形式的 DATABASE_URL，`cargo sqlx prepare`
无法稳定打开数据库文件。

修复：

- 安装并使用 `sqlx-cli 0.8.6`（sqlite feature）。
- 将 prepare-db 脚本中的 SQLite URL 规范化为 `sqlite:///C:/...`。
- 重新运行 `pnpm run prepare-db` 生成 `.sqlx` 缓存。

验证：

- `pnpm run prepare-db`
- `pnpm run prepare-db:check`
- `cargo test --workspace`

结果：三项均通过。

## H2: 4 个前端测试

逐例判定：

| 测试                                      | 判定                                                                                                                  | 处理                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `UseSessionComposerDraftScratch.test.tsx` | 断言过期。draft scratch 的 Codex executor profile 现在包含 `reasoning_effort: null`。                                 | 更新期望对象，保留行为断言。                                     |
| `sessionComposerTypeahead.test.ts`        | 断言过期。`/review` 描述来自 slash command presentation 覆盖层，当前文案为 `Review code with optional instructions`。 | 更新命令描述期望。                                               |
| `sessionComposerSubmit.test.ts`           | 断言过期。结构化 composer token 的稳定格式是显式 `[@:label](path)`，不是旧式裸 `@path`。                              | 用 `formatSessionComposerCommand` 构造文件 token fixture。       |
| `UserMessage.test.tsx`                    | 断言过期。发送后 chips 应覆盖显式文件 token 与 `$` token。                                                            | 用显式 `[@:App.tsx](src/App.tsx)` 和 `[$:plan]($plan)` fixture。 |

验证：

- `cd frontend && pnpm exec vitest run src/components/tasks/follow-up/UseSessionComposerDraftScratch.test.tsx src/components/tasks/follow-up/sessionComposerSubmit.test.ts src/components/tasks/follow-up/sessionComposerTypeahead.test.ts src/components/NormalizedConversation/UserMessage.test.tsx`
- `cd frontend && pnpm vitest run`

结果：窄集与前端全量测试均通过。

## H3: CLAUDE.md / AGENTS.md

按 requirements.md 约束，本阶段不恢复也不提交 `CLAUDE.md` / `AGENTS.md` 的删除。
它们仍作为会话开始前已存在的用户态修改保留，等待产品负责人确认意图。

## H4: 保存点

待完成：在全门验证通过后，将在途修改和本阶段修复切分为不超过 3 个原子提交，
并保持 `CLAUDE.md` / `AGENTS.md` 删除不进入提交。
