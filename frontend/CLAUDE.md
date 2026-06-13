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
className="settings-surface rounded-[10px] text-foreground"

// Controls-layer overlays should share the app popover/dialog roles.
className="dialog-surface text-popover-foreground"
```
