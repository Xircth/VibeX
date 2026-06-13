# Tasks: Tahoe Design System Convergence

## Phase 1: Truth Source And Token Baseline

- [x] Task T1.1: Make `DESIGN.md` the single current design authority.
  - Acceptance: Contributor docs and design audit artifacts point to
    `DESIGN.md` for current Tahoe rules; older `.impeccable` and audit content
    is marked historical or migration-only.
  - Verify: `rg "Legacy Design|Developer Flight Deck|single source|DESIGN.md|bg-white dark:bg-gray-900" frontend/CLAUDE.md docs/ui-design-audit.md .impeccable/design.json`
  - Files: `frontend/CLAUDE.md`, `docs/ui-design-audit.md`,
    `.impeccable/design.json`, `DESIGN.md`.

- [x] Task T1.2: Add Tahoe token aliases and global accessibility fallbacks.
  - Acceptance: Effective global CSS exposes glass, content, control, popover,
    semantic status, and syntax/diff exception roles; reduced motion,
    transparency, and high contrast have global fallbacks.
  - Verify: `rg "prefers-reduced-motion|prefers-contrast|reduced-transparency|surface-glass|tahoe-content|tahoe-glass" frontend/src/styles/legacy/index.css`
  - Files: `frontend/src/styles/legacy/index.css`.

- [x] Task T1.3: Clarify legacy naming transition.
  - Acceptance: `LegacyDesignScope` remains compatible, but code comments or
    aliases make clear that it now hosts the Tahoe app-design token layer.
  - Verify: `rg "Tahoe|legacy-design|LegacyDesignScope" frontend/src/components/legacy-design frontend/src/App.tsx frontend/tests`
  - Files: `frontend/src/components/legacy-design/LegacyDesignScope.tsx`,
    `frontend/src/App.tsx`, affected tests if snapshots assert the old name.

## Phase 2: Shared Primitives

- [x] Task T2.1: Migrate compact control primitives.
  - Acceptance: Button, input, select, switch, and card primitives use compact
    desktop sizing, tokenized surfaces, visible focus rings, and restrained
    radii.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/components/ui/button.tsx`,
    `frontend/src/components/ui/input.tsx`,
    `frontend/src/components/ui/select.tsx`,
    `frontend/src/components/ui/switch.tsx`,
    `frontend/src/components/ui/card.tsx`.

- [x] Task T2.2: Migrate overlay primitives.
  - Acceptance: Dialog, popover, dropdown menu, tooltip, and sonner toast share
    the navigation/control glass material with solid fallbacks and no nested
    glass-on-glass styling.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/components/ui/dialog.tsx`,
    `frontend/src/components/ui/popover.tsx`,
    `frontend/src/components/ui/dropdown-menu.tsx`,
    `frontend/src/components/ui/tooltip.tsx`,
    `frontend/src/components/ui/sonner.tsx`.

## Phase 3: Settings Reference Surface

- [x] Task T3.1: Migrate Settings shell and Windows chrome.
  - Acceptance: Settings titlebar/sidebar use shared glass roles, active sidebar
    rows match `DESIGN.md`, and Windows controls keep native close behavior with
    documented platform exception colors.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/pages/settings/SettingsLayout.tsx`,
    `frontend/src/components/settings/WindowControls.tsx`,
    `frontend/src/components/settings/AppTitleBar.tsx`,
    `frontend/src/styles/legacy/index.css`.

- [x] Task T3.2: Migrate core Settings pages.
  - Acceptance: Appearance, Editor, Shortcut, and System settings use opaque
    grouped content surfaces, compact rows, and non-glass sticky action areas.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/pages/settings/AppearanceSettings.tsx`,
    `frontend/src/pages/settings/EditorSettings.tsx`,
    `frontend/src/pages/settings/ShortcutSettings.tsx`,
    `frontend/src/pages/settings/SystemSettings.tsx`.

- [x] Task T3.3: Migrate agent Settings pages.
  - Acceptance: Agent settings and agent config manager use the same grouped
    surfaces, compact control strips, and semantic status treatment as the core
    Settings pages.
  - Verify: `cd frontend && pnpm exec vitest run src/pages/settings/AgentSettings.test.tsx`
  - Files: `frontend/src/pages/settings/AgentSettings.tsx`,
    `frontend/src/pages/settings/AgentConfigManager.tsx`,
    `frontend/src/pages/settings/AgentSettings.test.tsx`.

- [x] Task T3.4: Migrate MCP and Skills settings.
  - Acceptance: MCP and Skills settings stop using local blue/card/sidebar
    dialects and adopt the Settings reference shell and surfaces.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/pages/settings/McpSettings.tsx`,
    `frontend/src/pages/settings/SkillsSettings.tsx`.

## Phase 4: Workspace Chrome

- [x] Task T4.1: Align workspace topbar, project rail, search palette, menus,
      and desktop toasts.
  - Acceptance: Workspace chrome uses shared glass only where it is navigation or
    controls; documentation no longer misstates main window titlebar behavior.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/components/layout/Toolbar.tsx`,
    `frontend/src/components/layout/ProjectRail.tsx`,
    `frontend/src/components/search/SearchPalette.tsx`,
    `frontend/src/components/desktop-toast/DesktopToastWindow.tsx`,
    `DESIGN.md`.

## Phase 5: Style Island Migration

- [x] Task T5.1: Alias conversation styles to Tahoe tokens.
  - Acceptance: `--conv-*` variables become compatibility aliases over global
    semantic/content/syntax tokens; message content remains opaque.
  - Verify: `rg "mossx|#[0-9a-fA-F]{3,6}|backdrop-filter|box-shadow: inset" frontend/src/styles/conversation`
  - Files: `frontend/src/styles/conversation/*`.

- [x] Task T5.2: Alias file tree styles to Tahoe tokens.
  - Acceptance: file-tree variables no longer depend on undefined brand tokens
    or local git palettes; glass remains limited to chrome zones.
  - Verify: `rg "--brand|mossx|#[0-9a-fA-F]{3,6}|box-shadow: inset" frontend/src/styles/file-tree`
  - Files: `frontend/src/styles/file-tree/*`.

- [x] Task T5.3: Alias diff styles to Tahoe syntax/diff tokens.
  - Acceptance: diff layout and syntax colors are documented code/diff
    exceptions behind global token names, not standalone palettes.
  - Verify: `rg "#[0-9a-fA-F]{3,6}|--diffs|--line-" frontend/src/styles/diff-overrides`
  - Files: `frontend/src/styles/diff-overrides/*`.

## Phase 6: Remaining Product Surfaces

- [x] Task T6.1: Migrate kanban and session hub surfaces.
  - Acceptance: usage dashboard, kanban columns, and session hub cards remove
    decorative gradients, heavy glass, border-2 cards, and broad `transition-all`
    motion.
  - Verify: `cd frontend && pnpm run check`
  - Files: `frontend/src/components/kanban/**`,
    `frontend/src/components/panels/DockviewKanbanPanel.tsx`.

- [x] Task T6.2: Migrate git, task preview, terminal, and miscellaneous
      hard-coded style outliers.
  - Acceptance: remaining direct blue/green/purple/orange/gray UI palettes are
    semantic tokens or documented syntax/terminal/brand exceptions.
  - Verify: `rg "bg-white|dark:bg-gray|text-blue|bg-blue|border-l-2|border-2|#[0-9a-fA-F]{3,6}" frontend/src/components frontend/src/pages frontend/src/styles`
  - Files: affected git, task, preview, terminal, and icon-adjacent modules.

## Phase 7: Verification

- [ ] Task T7.1: Run full design convergence verification.
  - Acceptance: typecheck, lint, build, focused tests, static style searches,
    and visual smoke checks pass or have documented follow-up gaps.
  - Verify: `pnpm run frontend:check`; `pnpm run frontend:lint`;
    `pnpm run frontend:build`; focused Vitest suites; browser/Playwright
    screenshots for Settings and workspace chrome.
  - Files: `docs/specs/tahoe-design-system-convergence/verification.md`.
