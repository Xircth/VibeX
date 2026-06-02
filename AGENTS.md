<!-- AUTONOMY DIRECTIVE - DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" - PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT.
<!-- END AUTONOMY DIRECTIVE -->

# VibeX Agent Contract

This file is the operating contract for all agents working in this repository.
Follow it before local habits, generic framework advice, or convenience-driven
shortcuts.

VibeX is a local-first desktop workbench for AI coding agents. The product must
feel calm, inspectable, precise, and reliable under dense engineering workflows.
Do not ship vague AI-dashboard design, patch-style fixes, or code that only
works on the happy path.

## Non-Negotiable Principles

- Fix root causes in the owning data flow, protocol, state machine, component,
  or storage boundary. Do not mask symptoms with render-layer guards, duplicate
  filtering, or cosmetic suppression.
- Preserve user work. The worktree may already contain unrelated edits. Never
  revert, reset, or overwrite changes you did not make unless the user explicitly
  asks for that operation.
- Prefer deletion, simplification, and reuse over new abstractions. New layers
  must earn their cost.
- No new dependencies unless the user explicitly asks or the technical case is
  documented and unavoidable.
- Every meaningful change needs verification. Do not claim completion from
  confidence alone.
- If a change touches UI, it must also satisfy the VibeX design system in
  `PRODUCT.md`, `DESIGN.md`, and `.impeccable/design.json`.
- If a change touches generated types, migrations, or protocol boundaries, the
  generated artifacts and compatibility checks are part of the work.

## Project Structure

- `crates/`: Rust workspace crates. Important areas include `server`, `db`,
  `executors`, `services`, `utils`, `deployment`, and `local-deployment`.
- `frontend/`: React, TypeScript, Vite, Tailwind, Dockview, and Tauri-facing UI.
  Source lives in `frontend/src`.
- `shared/`: generated TypeScript types. Do not edit `shared/types.ts` by hand.
- `src-tauri/`: Tauri commands and desktop runtime integration.
- `assets/`, `dev_assets_seed/`, `dev_assets/`: packaged and local development
  assets.
- `npx-cli/`: files published to the npm CLI package.
- `scripts/`: local development and database helpers.
- `docs/`: specifications, audits, implementation notes, and project documents.
- `code-reference/` and `code-referance/`: local reference projects only. Do not
  commit, upload, or rewrite these directories.

## Command Surface

Install:

```powershell
pnpm i
```

Desktop development:

```powershell
pnpm run dev
```

Frontend-only development:

```powershell
cd frontend
pnpm run dev
```

Backend development:

```powershell
pnpm run backend:dev
pnpm run backend:dev:watch
```

Verification:

```powershell
pnpm run frontend:check
pnpm run frontend:lint
pnpm run frontend:build
pnpm run backend:check
pnpm run backend:lint
pnpm run check
pnpm run lint
cargo test --workspace
```

Generated data:

```powershell
pnpm run generate-types
pnpm run generate-types:check
pnpm run prepare-db
pnpm run prepare-db:check
```

Use the narrowest meaningful verification during iteration, then run the broader
gate before reporting a complete change.

## Git Workflow

Follow the principles from `git-workflow-and-versioning`.

- Use trunk-based development as the default mental model. Keep branches short
  lived and changes easy to merge.
- Treat commits as save points. A completed, verified slice should be
  committable on its own.
- Keep commits atomic. Do not mix feature work, refactors, formatting churn, and
  unrelated bug fixes.
- Target small reviewable diffs. Around 100 changed lines is ideal, around 300
  is acceptable for one logical change, and around 1000 means split the work
  unless it is a generated or deletion-heavy diff.
- Before committing, inspect `git status --short`, review the staged diff, check
  for secrets, and run relevant verification.
- Never use destructive commands such as `git reset --hard`, `git checkout --`,
  or branch deletion unless the user explicitly asks for them.
- If committing, use the repository's Lore-style decision record when requested
  or when the change is substantial:

```text
<intent line: why this change exists>

<body: context, constraints, and approach>

Constraint: <external constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <future warning>
Tested: <verification run>
Not-tested: <known gaps>
```

## Shared Types and API Contracts
- Do not manually edit `shared/types.ts`.
- Change Rust source types first, derive or update `TS` annotations as needed,
  then run `pnpm run generate-types`.
- For CI-style validation, run `pnpm run generate-types:check`.
- Keep Rust and TypeScript API contracts aligned. A frontend workaround for a
  backend contract mismatch is not an acceptable final fix.
- For SQLx or database-related changes, update migrations and run the relevant
  prepare/check command.

## Frontend Engineering Rules

Follow `impeccable` for frontend and product UI work.

Before UI edits:

- Load product context with the impeccable context loader when not already known.
- Treat this app as `product`, not brand marketing.
- Use `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, and
  `docs/ui-design-audit.md` as the design source of truth.

Implementation rules:

- Prefer existing components, tokens, CSS hooks, and shadcn primitives before
  adding one-off Tailwind stacks.
- Main token surface is `frontend/src/styles/legacy/index.css`. Reuse its shell,
  panel, card, control, border, text, active, hover, and shadow vocabulary.
- Keep UI dense but calm. VibeX is a developer workbench, not a marketing page.
- Use lucide icons for recognizable actions. Use text only when the action would
  be ambiguous without it.
- Keep controls stable on hover. Do not change dimensions, border width, or text
  wrapping on hover.
- Prefer app-managed state and pointer flows over native browser assumptions in
  hostile desktop surfaces such as Dockview plus Tauri/WebView.
- When touching file-tree drag behavior, verify both file-tree to file-tree moves
  and file-tree to editor/composer drops in the desktop runtime.
- For browser-only checks, remember that Tauri bridge errors are expected unless
  the desktop shell is running.

Design bans:

- No pure `#000`, `#fff`, `bg-black`, raw `bg-white`, or generic `gray-*`
  surfaces when a tinted product token exists.
- No colored side-stripe borders greater than 1px on cards, callouts, markdown,
  file rows, or alerts.
- No gradient text or `background-clip: text`.
- No decorative glassmorphism, gradient-orb backgrounds, or generic AI SaaS
  hero/card patterns.
- No nested cards. Use full-width bands, panels, rows, or clear repeated cards.
- No layout-property animation such as `height`, `width`, `margin`, or
  `max-height`. Use opacity, transform, or measured non-animated layout.

UI verification:

- Run `npx impeccable detect --fast --json frontend/src/components frontend/src/styles`
  after UI cleanup or polish work.
- Run `pnpm run frontend:check` and `pnpm run frontend:lint` for TypeScript UI
  changes.
- Run `pnpm run frontend:build` when Tailwind arbitrary classes, CSS imports,
  route-level chunks, or production bundling could be affected.
- For visible UI changes, start the app or frontend dev server and inspect in a
  browser or desktop shell. Capture screenshots when layout, state, or visual
  polish is the point of the work.

## Overall UI and Product Design Rules

- Make state visible before making it beautiful. Agent status, queue state,
  workspace selection, diff state, execution ownership, and review state must be
  readable at a glance.
- Use one product vocabulary across workspace, Dockview, file tree, conversation,
  settings, dialogs, Kanban, previews, and toasts.
- Blue is functional. Use it for selected, focused, primary, live, or drag-target
  state, not decorative fill.
- Cards use 8px radius by default. Controls use 6px. Shell-scale panels,
  composers, and dialogs may use 12px to 14px.
- Resting panels and cards should usually be flat with a 1px border. Shadows are
  for floating surfaces, dragged items, dialogs, popovers, toasts, and meaningful
  hover lift.
- Do not use color alone for status. Pair color with labels, icons, or structure.
- Preserve keyboard focus styling and WCAG AA contrast.

## Backend and Runtime Development Rules

Follow `spec-driven-development` for backend work that is complex, cross-module,
or behaviorally ambiguous.

For non-trivial backend features, create or update a spec under `docs/specs/`
before implementation:

```text
docs/specs/<slug>/requirements.md
docs/specs/<slug>/design.md
docs/specs/<slug>/tasks.md
```

Requirements:

- Write user stories and EARS-style acceptance criteria.
- Include normal, edge, and error cases.
- Define compatibility expectations for existing sessions, workspaces, and
  persisted state.

Design:

- Name the owning crate, module, command, database table, protocol, and frontend
  boundary.
- Document data models, validation, lifecycle events, cancellation behavior,
  retries, and error mapping.
- List alternatives considered when the design is not obvious.

Tasks:

- Split implementation into 2 to 4 hour increments.
- Sequence foundation work before dependent UI or API consumers.
- Include tests and verification in the task list, not as an afterthought.

Backend implementation rules:

- Keep business logic in the owning service or runtime layer. Do not move core
  behavior into UI components, command handlers, or stringly typed glue.
- Treat external process output, filesystem paths, environment variables, CLI
  responses, and provider events as untrusted boundary data.
- Prefer structured types and explicit enums over string parsing.
- Keep cancellation, stop, retry, and cleanup paths first-class. These workflows
  are central to VibeX.
- On Windows, background process launches must not open visible terminal windows
  unless the user explicitly requested an interactive window.
- Do not introduce queues, caches, retries, or compatibility shims without clear
  ownership and invalidation rules.

## Cleanup, Refactor, and Anti-Slop Rules

Follow `ai-slop-cleaner` for cleanup, refactor, deslop, simplification, and
quality repair work.

- Write a cleanup plan before editing code.
- Lock behavior first with existing tests or the narrowest useful regression
  test. If no test is possible, state the behavioral evidence you are preserving.
- Categorize the smell before touching code: dead code, duplication, needless
  abstraction, boundary violation, missing tests, weak naming, weak errors, or
  performance hazard.
- Execute one smell-focused pass at a time.
- Prefer deletion over addition.
- Do not keep dead code, no-op compatibility wrappers, unused flags, or comments
  that memorialize removed behavior.
- Do not accept "clean it later" as a quality strategy. If surrounding debt is
  out of scope, name it clearly in the final report.

Quality bar:

- Never avoid difficult code because it is messy.
- Never preserve unnecessary complexity just because it already exists.
- Never ship a workaround when the root cause is knowable.
- Never trade correctness for a prettier diff.

## Code Review and Quality

Follow `code-review-and-quality` before merging or declaring a substantial
change complete.

Review every change across five axes:

1. Correctness: requirements, edge cases, races, state consistency, tests.
2. Readability: names, control flow, locality, simplicity, useful comments.
3. Architecture: ownership, dependency direction, boundaries, abstraction cost.
4. Security: input validation, secrets, injection, auth, untrusted data.
5. Performance: hot paths, N+1 behavior, unbounded loops, re-renders, blocking
   work, bundle impact.

Review behavior:

- Findings first, ordered by severity, with file and line references when
  reviewing code.
- Do not rubber-stamp AI or human changes.
- Required issues must be fixed before merge unless explicitly deferred with a
  reason.
- Optional suggestions must be labeled as optional.
- Verify the verification. Passing tests are necessary but not sufficient.

## Testing Strategy

Frontend:

- Typecheck with `pnpm run frontend:check`.
- Lint with `pnpm run frontend:lint`.
- Build with `pnpm run frontend:build` when production bundling or CSS generation
  matters.
- Add focused Vitest or component tests for runtime logic and regression-prone
  state transitions.

Rust/backend:

- Check with `pnpm run backend:check` or `cargo check`.
- Lint with `pnpm run backend:lint`.
- Test with `cargo test --workspace` or a narrower package/test when iterating.
- Place unit tests near the code under `#[cfg(test)]` where practical.

Integration:

- For desktop behavior, prefer the Tauri app when browser-only behavior cannot
  prove the claim.
- For provider lifecycle changes, verify stop, retry, interrupt, completion, and
  next-send boundaries.
- For file and drag workflows, verify both source-side and destination-side
  behavior.

## Known Project-Specific Risk Areas

- Dockview plus Tauri/WebView can interfere with native HTML5 drag-and-drop.
  Inspect container interception before blaming business logic.
- Provider stop/resume bugs are lifecycle bugs until proven otherwise. Trace
  `turn/interrupt`, `turn/started`, `turn/completed`, `turn/error`, and stale
  UI state cleanup rather than changing labels.
- Conversation folding must respect provider or normalized event boundaries. Do
  not use paragraph-shape heuristics for process grouping.
- Kanban session-hub visual work should stay local to session-hub surfaces unless
  the user asks for a wider redesign.
- Process spawning issues on Windows usually belong in the shared process launch
  layer, not in each UI caller.

## Documentation Requirements

- Update `PRODUCT.md` or `DESIGN.md` when product or design principles change.
- Update `docs/ui-design-audit.md` when UI audits identify or resolve systematic
  issues.
- Add specs under `docs/specs/` for non-trivial backend or cross-layer features.
- Keep implementation notes concrete: files, commands, behavior, verification,
  and residual risks.

## Final Response Contract

When reporting completed work, include:

- Changed files.
- What was simplified, fixed, or added.
- Verification commands and outcomes.
- Known gaps or remaining risks.
- Anything intentionally not touched because it was out of scope or unrelated.

Do not claim the worktree is clean unless `git status --short` proves it.

<!-- OMX:RUNTIME:START -->
<!-- OMX:RUNTIME:END -->
<!-- OMX:TEAM:WORKER:START -->
<!-- OMX:TEAM:WORKER:END -->
