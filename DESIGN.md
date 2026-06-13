---
name: VibeX
description: Local-first AI coding agent orchestration workspace for developers.
platform: Tauri desktop with React, Tailwind, and Radix. macOS Tahoe is the visual target; Windows and Linux degrade gracefully.
colors:
  primary: "#5b8cc7"
  primary-foreground: "#f8fafc"
  shell-bg: "#eef1f5"
  content-bg: "#f6f8fb"
  panel-bg: "#fbfcfd"
  panel-translucent: "#fbfcfde6"
  glass-bg: "#ffffffb8"
  glass-border: "#ffffff8f"
  control-bg: "#eef0f4"
  active-bg: "#dceafa"
  text-strong: "#242936"
  text-primary: "#4f5a63"
  text-muted: "#7e8790"
  border-subtle: "#dde1e7"
  border-strong: "#c6ced8"
  success: "#86b300"
  warning: "#f2ae49"
  destructive: "#f51818"
  dark-shell-bg: "#151b23"
  dark-panel-bg: "#202733"
  dark-glass-bg: "#202733cc"
  dark-text-strong: "#e7ebef"
typography:
  display:
    fontFamily: "IBM Plex Sans, Noto Emoji, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "0"
  headline:
    fontFamily: "IBM Plex Sans, Noto Emoji, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  title:
    fontFamily: "IBM Plex Sans, Noto Emoji, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: "0"
  body:
    fontFamily: "IBM Plex Sans, Noto Emoji, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "0"
  label:
    fontFamily: "IBM Plex Sans, Noto Emoji, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "0"
  mono:
    fontFamily: "IBM Plex Mono, Noto Emoji, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  sm: "4px"
  md: "6px"
  card: "8px"
  panel: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  input-default:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  card-default:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "12px"
---

# Design System: VibeX Tahoe

`DESIGN.md` is the single current source of truth for frontend design in
VibeX. Older audits, generated `.impeccable` output, and files with "legacy" in
their names are migration references only.

## 1. North Star

VibeX is a native-feeling desktop workbench for developers orchestrating agents,
worktrees, terminals, previews, diffs, files, and settings. It should feel calm,
dense, inspectable, fast, and deeply keyboard-friendly.

The visual target is macOS Tahoe 26, adapted to a Tauri app and kept compatible
with Windows. "Native" means the app follows platform behavior and hierarchy
even when it cannot use native AppKit controls directly.

## 2. Two-Layer Model

VibeX has two visual layers.

### Navigation And Controls Layer

This layer may use Liquid Glass. It includes titlebars, sidebars, toolbars,
command palettes, dropdown menus, popovers, toasts, floating rails, and window
controls.

Use shared glass roles:

- translucent fill over the app shell;
- 1px hairline border;
- subtle shadow only for floating surfaces;
- `backdrop-filter` with reduced-transparency fallback;
- no glass-on-glass stacking.

### Content Layer

This layer is opaque. It includes conversations, file tree rows, diff content,
editors, terminals, tables, forms, cards, dashboards, settings groups, logs, and
markdown/code content.

Use shared content roles:

- tinted opaque panel surface;
- 1px border;
- compact radius;
- restrained shadow only for floating or dragged states;
- no decorative blur or gradients.

## 3. Platform Rules

- macOS is the visual target.
- Windows custom controls are allowed for frameless Tauri windows and may use
  documented Windows chrome exception colors, such as the close-button red.
- The main window may keep native decorations unless a later task explicitly
  changes the window strategy.
- Do not claim an element is a titlebar or drag region unless the Tauri window
  configuration actually supports that behavior.
- Settings must remain reachable by keyboard.

## 4. Color

The palette is a restrained technical neutral system with one calm blue accent
and semantic status colors.

### Named Rules

**State-Only Accent Rule.** Workbench Blue is for selected, focused, primary,
or live state. It is not decorative fill.

**Tinted Neutral Rule.** Avoid pure black and pure white for app surfaces. Use
tinted neutral tokens so surfaces adapt across light, dark, contrast, and
transparency modes.

**Semantic Status Rule.** Success, warning, destructive, running, paused,
queued, and disabled states use semantic tokens. Do not create a local blue,
green, amber, red, purple, or gray palette inside a component.

**Exception Rule.** Syntax highlighting, terminal ANSI colors, brand icons, and
document/media canvases may use explicit colors, but the exception must be
obvious from context or documented in the token layer.

## 5. Typography

Use IBM Plex Sans for product UI, IBM Plex Mono for paths/code-like metadata,
and Noto Emoji fallback. Product UI uses fixed compact sizes. Do not scale font
size with viewport width. Letter spacing is `0`.

- **Display:** app-level titles and rare dense page headers.
- **Headline:** panel titles and major settings sections.
- **Title:** card titles, list item titles, dialog headings, toolbar labels.
- **Body:** normal UI copy, list content, settings descriptions.
- **Label:** metadata, chips, timestamps, helper text.
- **Mono:** paths, branches, terminal data, code references, structured logs.

## 6. Radius, Elevation, And Motion

- 4px: small controls and inline tokens.
- 6px: standard buttons, inputs, selects, menu items.
- 8px: repeated cards and content groups.
- 14px: shell-scale panels, dialogs, sidebars, and floating glass surfaces.

Cards and panels are flat at rest. Shadows are reserved for popovers, dialogs,
toasts, dragged items, and floating shell chrome.

Motion must be subtle and state-driven. Avoid `transition-all`, hover scale,
large translate, rotate, and long-duration animation unless the interaction
needs it. Reduced Motion must keep the UI understandable.

## 7. Components

### Buttons

Default desktop controls are compact. Use 32px height for normal actions and
dense toolbar controls. Keep icon buttons square with stable dimensions. Primary
actions use Workbench Blue. Secondary actions stay neutral until hover/focus.

### Inputs

Inputs use a control surface, 1px border, 6px radius, visible focus ring, and
32px default height. Error state must include text, not color alone.

### Cards And Groups

Content cards use opaque surfaces. Do not use glass, radial gradients, or
large decorative shadows. Repeated cards use 8px radius. Shell-scale panels may
use 14px.

### Menus, Popovers, Dialogs, Toasts

These are controls-layer surfaces and may use shared glass material. Every one
must have a solid fallback for reduced transparency and increased contrast.
Avoid nesting a glass surface inside another glass surface.

### Sidebars And Toolbars

Sidebars and toolbars are stable navigation chrome. Active rows use a clear
accent treatment and readable labels. Toolbar actions are grouped by function
and frequency; secondary actions move to menus rather than crowding the bar.
The workspace topbar is product navigation chrome, not an operating-system
titlebar or drag region unless the Tauri window configuration explicitly makes
it one.

## 8. Accessibility

The design system must support:

- reduced transparency: glass collapses to solid panel;
- increased contrast: borders and foregrounds strengthen;
- reduced motion: nonessential transforms and long transitions stop;
- keyboard operation for primary workflows;
- accessible labels for icon-only controls;
- redundant state expression with icon/text/color where state matters.

## 9. Do

- Use tokenized roles from `frontend/src/styles/legacy/index.css` while that file
  remains the effective app-design scope.
- Keep controls compact and dimensions stable.
- Treat Settings as the first reference surface for migrated product UI.
- Use lucide icons for standard actions when an icon exists.
- Communicate state with text, icon, and color together.
- Keep content surfaces opaque.

## 10. Do Not

- Do not apply Liquid Glass to content.
- Do not stack glass on glass.
- Do not use generic SaaS dashboard patterns: oversized cards, decorative
  gradients, glass panels, or vague marketing composition.
- Do not use hard-coded `gray-*`, `bg-white`, `text-white`, pure black, direct
  hex values, or isolated local palettes for product UI.
- Do not use side-stripe borders greater than 1px.
- Do not use visible text to explain how to use the interface.
- Do not make one-off hero, landing, or marketing-style layouts inside the app.

## 11. Current Migration Map

- `frontend/src/styles/legacy/index.css`: current effective global token layer.
  The name is historical; the role is now Tahoe app-design scope.
- `frontend/src/components/ui/*`: shared primitives that must define compact
  control and overlay behavior.
- `frontend/src/pages/settings/*`: first full reference surface.
- `frontend/src/styles/conversation/*`: compatibility island to be aliased to
  global content/syntax tokens.
- `frontend/src/styles/file-tree/*`: compatibility island to be aliased to
  global content/status tokens.
- `frontend/src/styles/diff-overrides/*`: code/diff exception island to be
  routed through global syntax/diff tokens.
- `frontend/src/styles/dockview-ayu.css`: historical name; should keep using
  workspace token roles until renamed.
