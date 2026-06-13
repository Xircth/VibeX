# Spec: Tahoe Design System Convergence

## Objective

Make `DESIGN.md` the single source of truth for VibeX frontend design and
converge the implementation toward a macOS Tahoe 26 style while preserving
Windows desktop compatibility.

The user is a power-user developer working in a dense desktop workbench. The UI
should feel like a native pro tool: compact, readable, keyboard-friendly, and
calm. Liquid Glass is a shell material for navigation and controls, not a
decorative content treatment.

## Assumptions

1. VibeX remains a Tauri + React + Tailwind + Radix desktop app.
2. No new UI framework dependency is required for this convergence.
3. `DESIGN.md` becomes authoritative; older audits and generated design files
   are historical or migration references.
4. macOS Tahoe is the visual target; Windows retains platform-specific window
   controls and must degrade gracefully when transparency is unavailable.
5. The first implementation wave is limited to design truth sources, global
   tokens, accessibility fallbacks, UI primitives, and Settings as the sample
   migrated surface.

## Acceptance Criteria

1. WHEN future contributors look for frontend design guidance THEN they SHALL be
   directed to `DESIGN.md` as the single current source of truth.
2. WHEN a surface is navigation or controls chrome THEN it MAY use the shared
   Liquid Glass material and SHALL have reduced-transparency and high-contrast
   fallbacks.
3. WHEN a surface is content, including conversation, file tree rows, diff
   content, editors, tables, lists, or dashboards, THEN it SHALL use opaque
   content tokens and SHALL NOT use glass blur as decoration.
4. WHEN shared UI primitives render buttons, inputs, cards, dialogs, popovers,
   dropdowns, selects, switches, or toasts THEN they SHALL use the Tahoe token
   roles and compact desktop sizing.
5. WHEN Settings pages render THEN their sidebar, titlebar, grouped sections,
   sticky action areas, and active navigation rows SHALL match the Tahoe design
   rules and preserve Windows custom controls.
6. WHEN platform-specific Windows window controls need non-token colors THEN the
   exception SHALL be documented in code or tokens as a Windows chrome exception.
7. WHEN users enable reduced motion, reduced transparency, or higher contrast
   THEN blur, animation, and low-contrast glass effects SHALL degrade without
   losing readability or function.
8. WHEN older style islands remain, including conversation, file tree, diff,
   Dockview, kanban, git, task previews, and terminal themes, THEN their
   migration status SHALL be tracked in `tasks.md` with explicit verification.

## Boundaries

- Always: preserve existing user work and dirty worktree changes.
- Always: prefer existing component boundaries, Tailwind tokens, Radix
  primitives, and Tauri platform APIs over new abstractions.
- Always: keep Windows behavior testable and explicit when macOS-style custom
  chrome is introduced.
- Ask first: adding a frontend dependency, replacing Tailwind/shadcn, changing
  Tauri window decoration strategy for the main window, or removing a major
  style island wholesale.
- Never: apply Liquid Glass to dense content as decoration.
- Never: introduce new one-off hard-coded palettes for product UI outside
  syntax, terminal, brand icons, or documented platform exceptions.
- Never: regress keyboard navigation, focus visibility, or accessible labels.

## Testing Strategy

- Static searches verify design-source convergence and prevent obvious
  hard-coded style regressions.
- Typecheck and lint verify that primitive and Settings migrations compile.
- Focused Vitest coverage is added only where behavior changes, such as window
  controls, settings navigation, or reduced-motion helpers.
- Visual verification should be done with the in-app browser or Playwright once
  the implementation wave reaches runnable UI changes.

