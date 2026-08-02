# Agent F — Automation v2 backend verification

## Scope and baseline

- Worktree: `.worktrees/plugin-v2-tool-runtime`
- Starting integration commit: `aa06fef6`
- Baseline dependency install: `pnpm install` passed with no lockfile change.
- Baseline Automation service tests: 12 passed.
- Baseline Conversation tests: 51 passed.
- Baseline DB Automation tests: 6 passed.
- Observed legacy behavior: five-field cron used the host's implicit local
  timezone; `in_place` was executable; a successful launch immediately marked
  its Run completed; there was no durable owner lease or transactional claim.

## RED/GREEN record

| Task | RED observed through public seam | GREEN |
| --- | --- | --- |
| T3.1 | `cargo test -p automation turn_launch_spec_matches_composer_input` failed because the package did not exist. | Composer and Automation inputs normalize through the same versioned `TurnLaunchSpec`; invalid PluginAction catalog references return stable errors. |
| T3.2 | A legacy `cron + prompt + executor + in_place` fixture had no v2 schema or safe migration. | Migration preserves original JSON evidence, creates v2 Automation/Run rows, disables shared-root legacy drafts, and changes orphan running Runs to `interrupted`. |
| T3.3 | Fixed-clock tests for ordinary time, DST gaps/ambiguity, disabled/manual, and bad zones failed before the schedule service existed. | `ScheduleService` and the Engine share `next_run_after`; schedules persist IANA zones and deterministic UTC occurrences. |
| T3.4 | Fake owner and concurrent tick tests showed no ownership/claim seam. | `OwnerLockPort`, `FileOwnerLock`, `ClaimStorePort`, a partial unique active-run index, and a transactional compare-and-advance claim prevent duplicate execution. |
| T3.5 | Fake Git tests had no worktree isolation service and accepted dirty/wrong-branch shared roots. | Default branches are exactly `automation/<automation_id>/run-<run_id>`; shared roots require clean state and the expected branch without checkout. |
| T3.6 | A successful `start_turn` could not remain running or follow all four durable terminal states. | `AutomationRunner` records workspace, Conversation, connection, Turn and resolved versions; Run stays running until completed/failed/cancelled/interrupted projection reconciliation. |
| T3.7 | Four cancellation windows and crash recovery initially had no public ports. | Every pre-send checkpoint stops later side effects and cleans acquired resources; startup interrupts orphans without resending and claims at most one catch-up per Automation. |
| T3.8 | Seven templates had no common validation path. | All seven are ordinary editable `AutomationDraft` values and pass the same validator; no template-specific execution branch exists. |
| Hardening | `launch_failure_settles_failed_and_releases_the_prepared_workspace` was RED: status remained running. | Every failed launch stage settles the Run failed and best-effort cancels/releases resources. |
| Review hardening | `leap_day_schedule_searches_beyond_one_year` was RED: a valid 2028 leap-day occurrence returned no preview. | The bounded Gregorian search covers eight years, so every valid five-field calendar combination reaches its next occurrence. |
| Review hardening | `legacy_automation_timezone_is_resolved_exactly_once` was RED when a later startup could overwrite the migrated zone. | Migration records a pending marker; the first DB startup resolves the host IANA zone and atomically marks the evidence resolved, so later startups preserve it. |

Tests observe `AutomationEngine`, `AutomationRunner`, `ScheduleService`,
`StartupReconciler`, and repository ports. They do not inspect scheduler
loops, mutexes, or map layout.

## Migration semantics

- The migration renames v1 tables to `automation_v1_legacy` and
  `automation_run_v1_legacy`; they remain immutable evidence.
- Every original Automation is captured in `automation_legacy_evidence`.
- Legacy arbitrary plugin action JSON is evidence only and is not converted
  into executable v2 PluginAction data.
- Legacy `in_place` becomes `shared_in_root`, disabled, with
  `migration_required`. It cannot be re-enabled until saved through the v2
  validation path with a resolved project root.
- Legacy running Runs become `interrupted` with `host_restarted`; startup
  never resends them.
- The migration records a `legacy_local_pending` evidence marker. The first
  startup resolves it once to the host IANA timezone and changes the marker to
  `resolved`; later startups never rewrite a legitimate persisted zone when
  the data directory moves between hosts.

## Stable public API

The `automation` crate owns transport-neutral types and ports:

- `TurnLaunchSpec`, `ComposerCanonicalInput`, `AutomationDraftInput`,
  `AutomationDraft`, `ScheduleSpec`, and `IsolationSpec`.
- `Clock`, `OwnerLockPort`, `ClaimStorePort`, `GitWorkspacePort`,
  `WorkspacePreparerPort`, `TurnLauncherPort`, `RunStorePort`, and
  `RecoveryStorePort`.
- `AutomationEngine::acquire/with_claim_store`, `AutomationService::tick`,
  `AutomationRunner::execute/observe_terminal`, `ScheduleService::preview`,
  and `StartupReconciler::reconcile`.

`TurnLaunchSpec` directly reuses `plugins::PluginAction` and
`plugins::PromptBlock`; no second PluginAction protocol was introduced.
The Tauri layer is a thin adapter for CRUD, manual launch, cancellation,
same-source next-run preview, real worktree preparation, and real
Conversation/Turn launch.

## Safety properties

- Only the process holding `automation-engine.lock` in the application data
  directory runs reconciliation or ticks.
- Due advancement and running-Run insertion share one SQLite transaction.
  A partial unique index is the durable per-Automation side-effect lock.
- Shared-root execution never checks out a branch and rejects dirty or
  unexpected branches.
- Plugin actions require a resolved managed `ToolInstallationLock`; PATH is
  not execution evidence.
- No Automation path merges, pushes, publishes, releases, or deploys.
- Run settlement uses `WHERE status = 'running'`, so terminal races are
  first-terminal-wins.

## Verification commands

- `pnpm install`: passed with no source or lockfile change.
- `cargo test -p automation`: passed, 24 tests.
- `cargo test -p db --test automation_v2_migration`: passed, 3 tests.
- `cargo test -p db legacy_automation_timezone_is_resolved_exactly_once`:
  passed.
- `cargo test -p db sqlite_claim_is_transactional_across_concurrent_ticks`: passed.
- `cargo test -p conversations`: passed, 51 tests.
- `pnpm run prepare-db:check`: passed.
- `pnpm run generate-types:check`: passed; `shared/types.ts` is current.
- `cargo test --workspace`: passed; only the repository's explicitly gated
  live-network/local-executable and PTY tests remain ignored.
- `pnpm run check`: passed.
- `pnpm run lint`: passed with frontend warnings capped at zero and Rust
  warnings denied.
