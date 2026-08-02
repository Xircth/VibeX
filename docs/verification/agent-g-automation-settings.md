# Agent G: Automation settings and desktop journey

## Scope and source state

- Worktree: `.worktrees/plugin-v2-tool-runtime`
- Branch: `codex/plugin-v2-tool-runtime`
- Agent G start SHA: `b75288d068c05715ac812448c31f436ee239ca03`
- The worktree was clean before Agent G changes.

The settings page uses Automation v2's versioned launch spec and the canonical
`BackendTransport`. It does not call the legacy prompt/executor/cron API. The
backend remains authoritative for project paths, next-run calculation, run
terminal states, shared-root validation, and execution evidence.

## RED/GREEN log

| Public seam | RED observation | GREEN behavior |
| --- | --- | --- |
| Manual create | The old settings page crashed against the v2 transport and emitted the legacy DTO. | A real Composer value produces canonical prompt blocks, Agent intent, branch, and default `worktree_per_run`. |
| Schedule preview | There was no IANA timezone editor or backend preview action. | The builder emits a cron expression and displays only `automation_preview_next_runs` results. |
| Agent and PluginAction | Mode/config and Office actions were not part of the Automation draft. | The page reuses `SessionControlsFields` and `PluginActionEditor`; editable action evidence is persisted in the launch spec. |
| Templates | The seven backend templates were only counted in hidden text. | Every template is keyboard-operable and opens an editable, disabled draft without saving or running it. |
| Run lifecycle | Run Now was disabled and there was no history. | The page renders backend `running`, terminal, `skipped`, and `interrupted` states, supports cancellation, and never infers a terminal state. |
| Failure projection | Tauri returned placeholder `0` / `null` values. | SQLite `last_run_status` and `unseen_failure_count` are projected through `AutomationView`. |
| Saved branch | Editing a saved non-default branch silently selected the current branch. | The editor preserves the backend launch branch and submits that branch unless the user changes it. |
| Draft path authority | Saving a draft could resolve a Workspace and check out the selected branch. | Saving only reads the project repository root; Workspace creation, branch checks, and checkout remain execution-time responsibilities. |
| Desktop journey | No user-level Automation v2 fixture existed. | A fake clock/Agent drives the production settings UI through Office PluginAction, isolated worktree, Conversation/Turn, Artifact, and `completed`. |

Tests observe DOM behavior and transport calls. They do not inspect component,
Lexical, React Query, or scheduler private state.

## Desktop journey evidence

The fixture is served by the normal Vite desktop frontend from
`frontend/e2e/agent-g/index.html`. It mounts the production
`AutomationsSettings`, Composer, session controls, branch picker, and
PluginAction editor.

- [Full WebM recording](agent-g-assets/agent-g-automation-journey.webm)
- [Empty state and seven templates](agent-g-assets/01-empty-templates.png)
- [Editable Office PluginAction draft](agent-g-assets/02-office-draft.png)
- [Worktree, Conversation/Turn, Artifact, succeeded](agent-g-assets/03-worktree-artifact-succeeded.png)
- [Dirty shared-root rejection](agent-g-assets/04-dirty-shared-root.png)
- [Overlapping skip and restart Interrupted](agent-g-assets/05-skip-and-interrupted.png)

macOS has no supported `tauri-driver` WebDriver backend. As with the existing
Agent E evidence, Chromium runs real desktop React components with the backend
boundary faked; native engine, SQLite, workspace, launch, reconciliation, and
cancel windows are covered by the Rust suites.

## Accessibility

The completed journey was scanned with axe-core 4.12.1 under reduced-motion:

- violations: `0`
- incomplete checks: `0`
- passing rule groups: `21`

The scan initially caught low-contrast small text and non-transactional primary
buttons. The final UI uses full foreground contrast for small operational
evidence, text state in addition to color, labeled icon buttons, keyboard
selectors, live status roles, and explicit shared-root risk text.

## Verification

- Agent G target Vitest: 2 files, 11 tests passed.
- Full frontend Vitest: 195 files, 986 tests passed.
- `cargo test -p automation`: 24 tests passed.
- `cargo test -p db --test automation_v2_migration`: 4 tests passed.
- `cargo test --workspace`: passed; 7 environment-dependent tests remained
  explicitly ignored (five external executable/registry probes and two PTY
  timing probes).
- `pnpm run prepare-db:check`: passed.
- `pnpm run generate-types:check`: passed.
- `pnpm run frontend:check` and `pnpm run frontend:lint`: passed.
- `pnpm run check` and `pnpm run lint`: passed, including workspace Clippy with
  warnings denied.
- Final release addendum: `pnpm run test:web:e2e` passed all four optimized
  journeys, including Office PluginAction, isolated worktree, real Turn
  terminal evidence, Artifact output, dirty shared-root rejection, overlapping
  skip, and restart Interrupted recovery.
