## Styling Guidelines

### Source Of Truth

`../DESIGN.md` is the single source of truth for current frontend design. It
defines the macOS Tahoe visual target, Windows compatibility rules, Liquid Glass
boundaries, token roles, accessibility fallbacks, and migration map.

### CSS Architecture

All routes are still wrapped in `LegacyDesignScope` for compatibility, but that
name is historical. Treat it as the active Tahoe app-design scope until the
class and Tailwind config can be renamed safely.

**Key CSS files:**

- `src/styles/legacy/index.css` - current app-design token layer and Tailwind base.
- `src/styles/conversation.css` - conversation compatibility island.
- `src/styles/file-tree.css` - file tree compatibility island.
- `src/styles/diff-style-overrides.css` - diff/syntax exception island.
- `src/styles/dockview-ayu.css` - Dockview compatibility theme injected via `?raw`.

### Theme System

Dark/light mode is toggled via `.dark` on the root element.

**Current variable conventions:**

- App tokens: `--surface-*`, `--text-*`, `--border-*`, `--shadow-*`, plus
  shadcn-compatible `--background`, `--foreground`, `--border`, `--muted`, etc.
- Conversation, file-tree, diff, syntax, and terminal variables are compatibility
  aliases. They should move toward the global token roles in `DESIGN.md`.

**Rules:**

- Use CSS variables or Tailwind token classes for product colors.
- Reserve Liquid Glass for navigation and controls chrome only.
- Keep content surfaces opaque.
- Document platform exceptions, syntax colors, terminal ANSI colors, and brand
  icon colors where explicit colors are unavoidable.
- Do not introduce new local palettes or hard-coded surface colors.
- Diff overrides may keep `data-theme='dark'` while the @git-diff-view adapter
  requires it.

### Tailwind Config

- Config file: `tailwind.legacy.config.js` while the compatibility scope remains.
- shadcn/ui config: `components.json` points to `src/styles/legacy/index.css`.

### Component Styling

```tsx
// Product UI should state its design role through tokens/classes.
<section className="settings-surface rounded-lg text-foreground" />

// Controls-layer overlays should share the app popover/dialog roles.
<div className="dialog-surface text-popover-foreground" />
```

All standard corner utilities resolve through `--radius` (`14px`). Use
`rounded-full` only for true circles, avatars, and status pills. Secondary and
outline actions plus selectors use the shared raised-control surface (light
fill + 1px hairline, no drop shadow); apply `.raised-control` to native
controls and do not recreate the fill or border locally.

For inputs, searches, and selects, enforce a single visual frame: exactly one
element or component owns the background, border, radius, shadow, and focus ring.
Layout/label wrappers must remain visually transparent. When a custom wrapper is
the frame, reset the nested native input to transparent, borderless, and
shadowless. Do not style both wrapper and child as controls, and do not use broad
descendant selectors for control chrome.

<!-- ASTRYX:START -->
Astryx v0.3.0 · 155 components
CLI: run every command as `pnpm exec astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then Tailwind utilities backed by tokens. No raw hex/px.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any style={{…}}, raw <div>/<span>, imported .css/@apply, or hardcoded/arbitrary value (bg-[#fff], p-[13px]) with the component or a token-backed utility.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands, API reference, integration authoring
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->
