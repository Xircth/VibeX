# Tasks: Phase 0 — 基线稳定化

- [x] T0.1 运行 `pnpm run prepare-db`，重生成 SQLx 离线缓存；验证
      `pnpm run prepare-db:check` 与 `cargo test --workspace` 编译通过
  - Acceptance: db crate 编译错误消失，workspace 测试可运行
  - Verify: `cargo test --workspace`
  - Files: `crates/db/.sqlx/*`（生成物）、必要时 `.env`/scripts
- [x] T0.2 逐例判定 4 个失败前端测试：实现回归 vs 断言过期，记录证据
  - Acceptance: 每例有判定结论（git 证据 + 实际/期望值差异）
  - Verify: 判定记录写入阶段报告
  - Files: 4 个测试文件 + 被测实现
- [x] T0.3 按判定修复 4 例（改实现或改断言），全套前端测试绿
  - Acceptance: `pnpm vitest run` 全量通过
  - Verify: `cd frontend && pnpm vitest run`
  - Files: 视判定而定
- [x] T0.4 将在途修改 + 基线修复切分为 ≤3 个原子提交（Lore 记录格式），
      不包含 CLAUDE.md/AGENTS.md 删除
  - Acceptance: 每个提交单独通过 `pnpm run check`；`git status --short`
    仅剩两行 D 记录
  - Verify: `git log --stat`、`git status --short`
  - Files: git 历史
- [x] T0.5 全门验证：`pnpm run check`、`pnpm run lint`、`cargo test --workspace`、
      `pnpm vitest run`
  - Acceptance: 全绿
  - Verify: 命令输出
