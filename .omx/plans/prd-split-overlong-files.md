# PRD: Split Overlong Files

## Goal
Reduce maintenance risk from oversized source files by decomposing clearly overlong modules into smaller units without changing behavior. Preserve the current worktree in a baseline commit before any refactor.

## User Stories

### US-001 Baseline preservation
As a maintainer, I want the current worktree committed before structural refactors so that the pre-refactor state is recoverable and reviewable.

Acceptance criteria:
- All current tracked and intended untracked changes are captured in a baseline commit.
- The baseline commit uses the repository Lore commit format.
- Refactor work starts only after the baseline commit exists.

### US-002 Overlong file identification
As a maintainer, I want the codebase screened for clearly overlong real source files so that refactor effort is spent only where complexity justifies it.

Acceptance criteria:
- Generated files, assets, and reference folders are excluded from refactor candidates.
- Candidate selection is based on file size plus cohesive split boundaries.
- The chosen files are documented before edits begin.

### US-003 Safe decomposition
As a maintainer, I want selected large files split into smaller modules so that the code is easier to navigate and review.

Acceptance criteria:
- Extractions preserve public behavior and existing external imports/exports unless a safe local rewrite is preferable.
- New modules follow existing repository structure and naming conventions.
- No new dependency is introduced.

### US-004 Regression protection
As a maintainer, I want targeted regression coverage and verification around touched areas so that the refactor does not silently change behavior.

Acceptance criteria:
- Existing tests are reused where sufficient.
- Missing coverage around the touched seams is added only when necessary.
- Required checks pass after the refactor.

## Non-goals
- Feature work unrelated to file decomposition
- Large architectural redesigns
- Generated file or asset cleanup
