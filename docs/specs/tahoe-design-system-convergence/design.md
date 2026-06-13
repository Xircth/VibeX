# Design: Tahoe Design System Convergence

## Tech Stack

- Desktop shell: Tauri 2.
- Frontend: React 18, TypeScript, Vite.
- Styling: Tailwind CSS, Radix/shadcn-style primitives, CSS custom properties.
- Icons: lucide-react where an icon exists.

No new dependency is required for the first implementation wave.

## Commands

```powershell
pnpm run frontend:check
pnpm run frontend:lint
pnpm run frontend:build
pnpm run check
pnpm run lint
cd frontend; pnpm exec vitest run
```

Use focused Vitest commands for touched areas before running broader gates.

## Project Structure

```text
DESIGN.md
  Current design source of truth.

frontend/CLAUDE.md
  Frontend contributor guidance. Must point to DESIGN.md.

frontend/src/styles/legacy/index.css
  Current effective global token and utility layer. The implementation may keep
  this path initially, but the contents should become Tahoe app-design tokens.

frontend/src/components/ui/*
  Shared primitives that define button, input, select, dialog, popover, menu,
  card, switch, and toast behavior.

frontend/src/pages/settings/*
  First migrated product area and reference surface for future migrations.

frontend/src/styles/conversation/*
frontend/src/styles/file-tree/*
frontend/src/styles/diff-overrides/*
frontend/src/styles/dockview-ayu.css
  Existing style islands. They migrate after the shared token and primitive
  baseline is stable.
```

## Design Model

VibeX uses a two-layer model:

1. Navigation and controls layer: titlebars, sidebars, toolbars, menus,
   popovers, command palettes, toasts, and floating window controls. This layer
   may use the shared Liquid Glass material.
2. Content layer: conversation messages, file trees, diff lines, editors,
   tables, dashboards, forms, cards, and logs. This layer stays opaque and uses
   restrained borders, type, and state tokens.

The app archetype is a pro desktop workbench. Density and scannability matter
more than marketing-style whitespace or decorative cards.

## Token Roles

The shared CSS layer should expose stable roles:

```css
.tahoe-glass {
  background: var(--surface-glass);
  border: 1px solid var(--border-glass);
  box-shadow: var(--shadow-glass);
  backdrop-filter: blur(18px) saturate(1.2);
}

.tahoe-content {
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
}
```

Implementation may alias these roles to existing class names such as
`.workspace-topbar`, `.settings-sidebar`, `.dialog-surface`, and
`.settings-surface` while the codebase transitions away from legacy naming.

## Code Style

Prefer shared classes and token roles over local color stacks:

```tsx
<section className="settings-surface rounded-[10px]">
  <header className="settings-section-header">
    <h2 className="settings-section-title">Appearance</h2>
  </header>
  <div className="settings-row">
    <Label htmlFor="theme">Theme</Label>
    <Select value={theme} onValueChange={setTheme} />
  </div>
</section>
```

Avoid:

```tsx
<section className="rounded-2xl border-2 bg-background/80 shadow-xl backdrop-blur-xl">
```

The first example states the product role. The second redefines a visual system
inside a component and risks applying glass to content.

## Platform Behavior

- macOS owns the left-side traffic lights when the OS titlebar is present.
- Windows custom titlebar controls are allowed only in frameless windows and may
  use documented Windows chrome exception colors for close hover/active states.
- The main window decoration strategy remains unchanged in the first wave unless
  explicitly approved. Documentation must not claim `.workspace-topbar` is the
  main titlebar while `tauri.conf.json` still uses native decorations.

## Accessibility

Global CSS must include fallbacks for:

- `prefers-reduced-motion`: disable broad motion, hover scale, long transitions,
  and nonessential animated effects.
- `prefers-contrast: more`: increase borders and text contrast for glass and
  content surfaces.
- reduced transparency support: collapse glass blur to solid panels. CSS media
  support varies, so an `.app.reduced-transparency` or equivalent class may be
  kept as a runtime fallback.

All icon-only controls touched by the migration need `aria-label` or equivalent
accessible text.

## Implementation Plan

1. Align truth sources so contributors no longer treat legacy audits or generated
   artifacts as current design authority.
2. Add Tahoe token aliases and accessibility fallbacks in the effective global
   CSS layer.
3. Migrate shared UI primitives to compact desktop sizing and shared popover,
   dialog, and content roles.
4. Migrate Settings as the first reference surface.
5. Migrate the remaining style islands in later waves: workspace chrome,
   conversation, file tree, diff, kanban, git/task/preview surfaces.
6. Run static, type, lint, build, and visual checks at each wave boundary.

## Risks And Mitigations

- Risk: renaming `legacy-design` breaks scoped Tailwind output.
  Mitigation: introduce Tahoe aliases first, then rename after tests and visual
  checks prove parity.
- Risk: primitive changes affect many surfaces.
  Mitigation: keep primitive edits conservative and verify Settings first.
- Risk: content islands depend on their own code/syntax palettes.
  Mitigation: treat syntax, diff, and terminal colors as documented exceptions
  behind global semantic token names before removing local palettes.
- Risk: Windows custom chrome loses platform conventions.
  Mitigation: preserve current close/minimize/maximize behavior and document
  Windows-specific colors as chrome exceptions.

## Success Criteria

- `DESIGN.md` is clearly the current design authority.
- Global CSS has shared glass/content/control roles and accessibility fallbacks.
- Shared primitives no longer default to web/SaaS-scale sizing or isolated
  popover/card styling.
- Settings uses the migrated model consistently enough to serve as the reference
  surface for later pages.
- Remaining style islands are explicitly tracked as incomplete rather than
  silently acting as alternate design systems.

## Open Questions

- Whether the main window should eventually move from native decorations to a
  custom Tahoe titlebar remains out of scope for the first wave.
- Whether `legacy-design` should be renamed in code or only aliased in this wave
  should be decided after the first primitive and Settings migration.

