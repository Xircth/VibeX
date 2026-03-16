## Styling Guidelines

### CSS Architecture

The project uses a **Legacy Design** system with Tailwind CSS. All routes are wrapped in `LegacyDesignScope`.

**Key CSS files:**
- `src/styles/legacy/index.css` — Main entry, Tailwind base + theme variables
- `src/styles/conversation.css` — AI conversation UI (uses `--conv-*` CSS variables)
- `src/styles/file-tree.css` — File tree panel (uses mossx bridge variables)
- `src/styles/diff-style-overrides.css` — Diff viewer overrides
- `src/styles/dockview-ayu.css` — Dockview theme (injected via `?raw`)

### Theme System

Dark/light mode is toggled via `.dark` class on the root element.

**CSS variable conventions:**
- Legacy theme: `--background`, `--foreground`, `--border`, `--muted`, etc. (HSL values)
- Conversation: `--conv-*` variables defined in `conversation.css`
- File tree: bridge variables mapping legacy tokens to mossx naming

**Rules:**
- Always use CSS variables or Tailwind classes for colors — never hardcode HEX values
- Dark mode variants use `.dark` selector prefix
- Diff overrides use `data-theme='dark'` attribute (legacy pattern from @git-diff-view)

### Tailwind Config

- Config file: `tailwind.legacy.config.js`
- shadcn/ui config: `components.json` points to `src/styles/legacy/index.css`

### Component Styling

```tsx
// Use Tailwind utility classes with theme tokens
className="bg-background text-foreground border-border"

// Dark mode responsive
className="bg-white dark:bg-gray-900"
```
