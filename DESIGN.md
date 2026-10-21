---
name: VibeX
description: Local-first AI coding-agent orchestration workspace, dressed as a native macOS Tahoe app.
register: product
platform: Tauri desktop (React + Tailwind + Radix). macOS Tahoe is the visual target; Windows and Linux degrade gracefully.
colors:
  # One user-configurable accent, reserved for state (selected / focused / primary / live).
  primary: "#1B1B1B"
  primary-foreground: "#ffffff"
  primary-control-foreground: "#ffffff"
  switch-checked-track: "#1d2530"
  switch-checked-thumb: "#ffffff"
  dark-switch-checked-track: "hsl(var(--primary))"
  dark-switch-checked-thumb: "hsl(var(--primary-foreground))"
  # Astryx neutral surfaces. Opaque, and the same hex on macOS and Windows.
  shell-bg: "#ffffff"
  content-bg: "#ffffff"
  panel-bg: "#ffffff"
  popover-bg: "#ffffff"
  control-bg: "#0000000d"
  raised-control-bg: "#ffffff"
  raised-control-hover: "#f5f5f5"
  active-bg: "#e5e5e5"
  text-strong: "#171717"
  text-primary: "#171717"
  text-muted: "#525252"
  border-subtle: "#00000014"
  border-strong: "#d4d4d4"
  success: "#86b300"
  warning: "#f2ae49"
  destructive: "#f51818"
  dark-primary: "#E7EBEF"
  dark-primary-foreground: "#0E1319"
  dark-shell-bg: "#1b1b1b"
  dark-content-bg: "#262626"
  dark-panel-bg: "#262626"
  dark-text-strong: "#fafafa"
  dark-border-subtle: "#ffffff1a"
materials:
  # Chrome and content are opaque. Blur must not change the resolved color.
  glass-titlebar: "opaque var(--surface-topbar), #f1f1f1 light / #1b1b1b dark"
  glass-sidebar: "opaque var(--surface-sidebar), the same hex as the title bar"
  glass-popover: "opaque var(--surface-popover), #ffffff light / #262626 dark"
  dark-glass-fill: "opaque #1b1b1b, the same hex on macOS and Windows"
  dark-highlight: "moonlight hsl(210 30% 80% / 0.12)"
  dialog-surface: "opaque #ffffff in light mode; opaque #262626 in dark mode"
  content-surface: "opaque #ffffff in light mode; opaque #262626 in dark mode"
  reduce-transparency-fallback: "fills are already opaque, so dropping blur does not change the color"
typography:
  display:
    fontFamily: "var(--font-ui)"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "var(--font-ui)"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "var(--font-ui)"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: "0"
  body:
    fontFamily: "var(--font-ui)"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "0"
  label:
    fontFamily: "var(--font-ui)"
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
  control: "14px"
  card: "14px"
  panel: "14px"
  sidebar: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
motion:
  curve: "ease-out (cubic ~0.22, 1, 0.36, 1); no bounce, no elastic"
  duration: "120-180ms for state, 200-260ms for surface reveal"
  reduced-motion: "crossfade or instant; never gate content visibility on a transition"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-control-foreground}"
    shadow: "0 1px 1px #0d121c14, 0 2px 4px #0d121c1a"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.raised-control-bg}"
    hoverBackgroundColor: "{colors.raised-control-hover}"
    border: "1px solid {colors.border-subtle}"
    shadow: "none"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.destructive}"
    border: "1px solid {colors.destructive}"
    shadow: "0 1px 1px #0d121c14, 0 2px 4px #0d121c1a"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  select-default:
    backgroundColor: "{colors.raised-control-bg}"
    border: "1px solid {colors.border-subtle}"
    shadow: "none"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  input-default:
    backgroundColor: "{colors.raised-control-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  switch-default:
    checkedBackgroundColor: "{colors.switch-checked-track}"
    checkedThumbColor: "{colors.switch-checked-thumb}"
    darkCheckedBackgroundColor: "{colors.dark-switch-checked-track}"
    darkCheckedThumbColor: "{colors.dark-switch-checked-thumb}"
    rounded: "{rounded.pill}"
  card-default:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "14px"
  sidebar-nav-row:
    rounded: "14px"
    height: "36px"
    selectedBackground: "{colors.primary}  # accent fill, contrasting label"
---

# Design System: VibeX Tahoe

`DESIGN.md` is the single current source of truth for frontend design in
VibeX. Older audits, generated `.impeccable` output, and files with "legacy" in
their names are migration references only.

**Creative North Star: "The Developer Flight Deck, built as a good Mac citizen."**

VibeX is a local engineering control surface for coordinating many agent sessions, worktrees, terminals, previews, and diffs without losing context. The density and calm of a flight deck stay; what changes is the finish — VibeX should now read as a **native macOS Tahoe app**, not a web dashboard wrapped in a window.

The macOS contract is a two-layer model:

- A **navigation/controls layer** for the window frame. Title bar, sidebars, status bar, and the tab strip use `#f1f1f1` in light and `#1b1b1b` in dark. The page inside that frame stays `#ffffff` / `#1b1b1b`.
- A **content layer** of crisp, **opaque grouped surfaces** (inset lists, cards, editors, menus, dialogs, and toasts). Light is `#ffffff`. Dark is `#262626`. Hierarchy comes from that one step and from grouping.

VibeX is a Tauri app (React + Tailwind + Radix), so "native" is an aesthetic and behavioral target, not a toolkit. The look is delivered through the tokenized shell classes in `frontend/src/styles/legacy/index.css` (`--surface-*`, `.settings-sidebar`, `.settings-surface`, `.workspace-topbar`). Reduced transparency drops blur and keeps the same hex. On Windows the custom title-bar controls take over where the OS chrome would otherwise sit.

**Key characteristics:**

- Dense information, quiet surfaces, visible state.
- Glass is structural, not decorative — chrome only, never content.
- One user-configurable accent (default Ink `#1B1B1B` in light, Pearl Ink `#E7EBEF` in dark), used only for selected / focused / primary / live.
- Light mode is the primary working scene. Dark mode uses the same Astryx roles: body `#1b1b1b`, lifted surface `#262626`. Ayu stays on status, syntax, and the terminal.
- Hierarchy is expressed by grouping and spacing; remove any background, border, or internal rule added purely for emphasis.

## 2. Materials & Layering

This is the section that makes VibeX feel like Tahoe rather than a web app. Decide which layer a surface belongs to before styling it.

### The Navigation/Controls Layer

Opaque Astryx body color. Reserved for chrome that frames content. A leftover blur filter must not change the fill, and Windows does not substitute a different solid.

- **Title bar** (`.settings-titlebar`, `.workspace-topbar`): `--surface-topbar`, 1px hairline beneath. Light `#f1f1f1`, dark `#1b1b1b`. Unified with the window; the whole strip is a drag region. The tab strip uses the same color. The active tab stays the page color.
- **Sidebar** (`.settings-sidebar`): a rounded, inset floating panel on the same body color, full hairline border, `14px` corners. Content scrolls independently beneath it.
- **Popovers and menus**: opaque `--surface-popover` (`#ffffff` / `#262626`) with a popover shadow.
- **Dialogs and toasts**: opaque `--surface-dialog`. Light mode is `#ffffff`; dark mode is `#262626`. These surfaces use the same hex on macOS and Windows.

### The Content Layer — Opaque Grouped Surfaces

Everything users read, edit, or scan. Use opaque panels:

- **Inset grouped lists / cards** (`.settings-surface`): solid `--surface-card-strong`, 1px outer hairline, `14px` corners, flat at rest (no drop shadow). Rows inside one card are separated by spacing, not internal rules; a row gains elevation only while dragged or actively hovered.
- **Editors, tables, conversation, file tree, diffs**: opaque content background, hairline seams.

### Named Rules

**The Two-Layer Rule.** Before styling a surface, name its layer. Chrome uses the body hex. Content, menus, and dialogs use the lifted surface hex. Both are opaque.

**The Opaque Dialog Rule.** Every modal implementation—shared Dialog, Astryx Dialog, and exceptional fullscreen/custom modals—must resolve its visible surface through `--surface-dialog`. Do not apply a one-off background to a dialog.

**The Same-Hex Rule.** macOS and Windows resolve the same opaque color for a role. Do not add a platform remap, a translucent mix, or a reduced-transparency fill that lands on a different hex.

**The Reduce-Transparency Rule.** Dropping blur keeps the same fill and the hairline. The UI must stay fully legible with transparency off.

**The Decoration-Budget Rule.** If a background or border exists only to draw attention, delete it and express the emphasis through grouping, spacing, or the accent instead.

## 3. Color & Accent

A restrained, system-adaptive neutral palette with one user-configurable accent and small semantic status colors. Brand comes from content, iconography, and the accent — not from replacing structure.

### Accent

- **Ink** (`--primary`, `#1B1B1B`): the default light accent. Used for the selected sidebar row, focus rings, primary buttons, active navigation, live state, and drag targets. Accent-filled states use a contrasting control-foreground (white on this default).
- **Pearl Ink** (`--primary` in dark, `#E7EBEF`): the reciprocal night default — graphite inverted to pearl, with `#0E1319` on the accent fill. Custom accents keep their hue and only lift lightness until the label stays readable. Users change the hex in Settings → Appearance.

### Semantic status

- **Ayu Green** — success, passed checks, healthy terminal.
- **Ayu Amber** — warning, queued, pending; attention without danger.
- **Review Red** — destructive actions, failures, deleted diff state, irreversible warnings.

### Neutrals

Page surfaces use the Astryx neutral ramp. The same hex is used on macOS and Windows. Fills are opaque, so a blur or a Windows solid-chrome fallback cannot shift the color.

- **Frame** — title bar, tab strip, sidebars, and status bar. Light `#f1f1f1`, dark `#1b1b1b`.
- **Page** — the working surface inside that frame. Light `#ffffff`, dark `#1b1b1b`. The session list and the file tree use this color.
- **User message** — the sent bubble. Light `#f1f1f1`, dark `#262626`.
- **Surface** — panels, cards, dialogs, popovers, and inputs. Light `#ffffff`, dark `#262626`.
- **Settings window** — the page and its title bar stay the page color. Setting groups are `#f1f1f1` in light and `#262626` in dark. The floating navigation container uses a vertical wash: light `#e6e6e6` / `#f3f3f3` / `#ffffff` / `#f3f3f3` / `#e6e6e6`, dark `#262626` fading into `#1b1b1b`. Workspace chrome stays on the frame color.
- **Control wash** — hover and pressed overlays. Light `#0000000d` / `#0000001a`, dark `#ffffff0d` / `#ffffff1a`.
- **Ink** — primary text `#171717` / `#fafafa`. Secondary text `#525252` / `#a3a3a3`.
- **Hairline** — `#00000014` / `#ffffff1a`. Emphasized borders are `#d4d4d4` / `#525252`.

The user accent stays separate from this ramp. Light default remains Ink `#1B1B1B`; dark default remains Pearl Ink `#E7EBEF`.

## 6. Radius, Elevation, And Motion

**The State-Only Accent Rule.** The accent means selected, focused, primary, or live. It is never a decorative fill.

**The System-Adaptive Rule.** Surfaces use the Astryx neutral tokens and flip with light/dark. macOS and Windows resolve the same opaque hex. Reach for the tokens instead of a local palette.

**The Honor-The-Accent Rule.** Treat the Appearance accent as the user's system accent: selection, focus, and primary actions follow it. The default is Ink `#1B1B1B` in light and Pearl Ink `#E7EBEF` in dark.

## 4. Typography

VibeX uses native SF Pro on macOS. Windows and Linux use bundled Inter
Variable for Latin UI, because Segoe UI and typical Linux system sans render
poorly in WebView2/Chromium with antialiased smoothing. Chinese follows
PingFang SC on macOS, and bundled Noto Sans SC Variable (Source Han Sans /
思源黑体) on Windows and Linux — not Microsoft YaHei. Monospace content
remains governed separately by the user-configurable code-font setting.

- **Display** (600 / 1.125rem): app titles, welcome and dense page headers only.
- **Headline** (600 / 1rem): panel titles, major settings sections, top-level status.
- **Title** (600 / 0.875rem): card titles, list-item titles, dialog headings, toolbar group labels.
- **Body** (400 / 0.875rem): UI copy, list content, settings descriptions. Cap prose at 65–75ch.
- **Label** (500 / 0.75rem): metadata, chips, compact controls, timestamps, helper text.
- **Mono** (400 / 0.75rem): paths, terminal output, code references, branch names, structured logs.

Trigger and suggestion menus default to the compact label scale: item labels
use `0.75rem / 1rem` and supporting descriptions use `0.625rem / 0.875rem`.
Library menu primitives must override their body-text default at the menu root
so custom and fallback rows inherit the same density.

### Named Rules

**The Compact Scale Rule.** Product UI uses a fixed compact scale. No viewport-scaled type in panels, sidebars, dialogs, or dashboards.

**The Tight-Display Rule.** Display and headline tiers carry `-0.01em` tracking for a crisper, more system-like setting; body and below stay at `0`. Never tighter than `-0.02em`.

**The Label-Honesty Rule.** If text is metadata, make it a label. Don't promote a secondary label to headline size to fill space.

## 5. Elevation, Corners & Motion

### Elevation

Resting surfaces are flat with a 1px hairline. Shadow is reserved for things that genuinely float above another layer.

- **Shell Shadow** (`0 18px 42px hsl(220 36% 8% / 0.16)` in light; deeper cool hangar shadow in dark): floating sidebar, project rail, loading shells.
- **Popover Shadow** (`0 18px 42px hsl(220 36% 8% / 0.2)` in light; the matching dark shadow): dialogs, menus, command surfaces.
- **Card Shadow** (`0 1px 2px / 0 10px 30px hsl(220 36% 8% / 0.05)` in light; moonlight hairline in dark): grouped `.settings-surface` cards and repeated items, kept very low.
- **Composer Shadow**: the persistent follow-up composer, slightly lifted from the right panel.
- Dark elevation prefers lighter surfaces and moonlight hairlines over wide drop shadows copied from light mode.

### Corners (continuous, macOS-leaning)

- **All standard surfaces and controls** (buttons, inputs, selects, chips, cards, grouped lists, panels, sidebar, dialogs, composer): `14px`.
- **Status pills / avatars**: full radius.

`--radius` is the single source of truth. Named Tailwind radius utilities map to
that token; local numeric radii are not allowed. Full circles/pills and square
structural seams are the only exceptions.

### Motion

Motion communicates state, focus, and hierarchy — quietly. Ease-out curves (no bounce, no elastic), `120–180ms` for state changes, `200–260ms` for surface reveals. Stagger a list's own items if it helps; never apply one uniform entrance to every section. Honor `prefers-reduced-motion` with a crossfade or instant change, and never gate content visibility on a transition that could pause off-screen.

### Named Rules

**The Flat-At-Rest Rule.** Cards and panels are flat unless they float above another layer.

**The Lift-On-Float Rule.** Shadow strength tracks how far a surface is from the page: hairline at rest, card shadow when grouped-and-floating, shell/popover shadow only for true overlays.

## 6. Components

### Title bar / Window chrome

Opaque body strip, full drag region, hairline beneath. Keep it sparse: app mark + title, primary actions tinted, everything secondary demoted. On Windows the custom traffic-light controls live at the right; on macOS the OS owns the left. Settings is always reachable by keyboard.

### Sidebar

A rounded, inset panel on the body color — the primary, stable navigation. Rows are scannable and never reflow on hover. Selection is an **accent-filled rounded row with a contrasting label** (the macOS System Settings idiom). Where a list of destinations benefits from identity, a row may carry a small **colored app-icon badge** (rounded square, white glyph) — reserved for navigation, never content. Content scrolls beside the sidebar.

### Toolbars

Group items by function and frequency; the primary action is visually distinct (tinted). Demote secondary actions into a "more" overflow menu rather than crowding the bar — a crowded toolbar is the signal to cut. Remove custom backgrounds/borders; let the chrome color and spacing do the work. Don't pair a text button and an icon button so tightly they read as one control.

### Inset grouped lists & cards (content)

The workhorse content surface: an opaque `.settings-surface` card with a quiet header row and spacing-separated rows. Leading label, trailing control. `14px` corners, `12px` dense / `16px` comfortable padding. This is where settings, agent detail, and list content live. Do not draw hairlines between siblings in the same card.

### Controls

- **Switch**: Ink track with a white thumb when on in light. Dark mode uses the resolved accent fill (Pearl Ink by default) with a contrasting thumb. Keep a clear off state and never use the switch as the only signal for a meaningful change.
- **Secondary / outline buttons and selects**: opaque white in light mode, `#262626` in dark mode, a 1px hairline border, no drop shadow, and `14px` radius.
- **Inputs / fields**: the same opaque surface, 1px hairline, `14px` radius, `32px` compact height; accent focus ring at low opacity; error state in Review Red **with a text explanation**.

#### Single control frame rule

Every search field, input, select, and composite control has exactly one visual
owner for its background, border, corner radius, and focus ring. If the control
component owns that frame, ancestor elements may only provide layout and labels;
they must not add another padded, bordered, rounded, or filled shell. If a custom
wrapper owns the frame, the nested native input must be transparent, borderless,
shadowless, and fill the wrapper. Never style both a field wrapper and its input
as controls, and avoid broad descendant selectors that can silently reintroduce
a second frame when a component's internal markup changes.

### Iconography

Use crisp, consistent line icons (lucide) as SF-Symbols stand-ins for system concepts — one weight, aligned to the type baseline. Render brand agent marks in their brand color (`AgentTypeIcon`); single-color glyphs inherit `currentColor` so they adapt to light/dark. Only draw a custom glyph when the domain has no system equivalent, and keep it SF-like and labelled.

### Signature surfaces

The **Composer Shell** (grounded, always-available action surface) and the **Agent bar** (one compact full-width paged row of equal-size icons; the selected agent shows its name beside its icon, the add and refresh controls follow the last icon of every page, and edge chevrons flip pages, also while dragging an icon) are VibeX's signatures. Keep their surrounding controls quieter than the primary input and the selected agent.

## 7. Accessibility (designed in, not added later)

- **Labels:** every icon-only control carries an `aria-label`/title (e.g. the agent bar buttons). Communicate state with icon + text + color together — never color alone.
- **Keyboard:** everything operable without a pointer; visible focus rings on custom controls; standard editing shortcuts (copy/paste/undo) never overridden; a command palette _in addition_ to menus.
- **Contrast:** body text ≥ 4.5:1, large text ≥ 3:1; placeholders meet the same bar. Strengthen hairlines under `prefers-contrast: more`.
- **Reduced transparency / motion:** dropping blur keeps the same fill; animations fall back to crossfade/instant. Both states must stay fully usable.
- **Localization:** layouts absorb longer strings (the UI is bilingual today); never truncate meaning at default width.

## 8. Do's and Don'ts

### Do

- **Do** name a surface's layer before styling it: body hex for chrome, lifted surface hex for content. Both stay opaque, and both platforms use that hex.
- **Do** use the tokenized shell classes in `frontend/src/styles/legacy/index.css` before adding one-off Tailwind color stacks.
- **Do** keep controls compact and consistent: `32px` controls and one `14px` radius token across controls and surfaces.
- **Do** express hierarchy through grouping, spacing, and hairlines — and delete any chrome added only for emphasis.
- **Do** keep hover changes stable: change color, shadow, or a small transform; never size, border width, or text wrapping.
- **Do** keep a reduced-transparency state on the same fill. Dropping blur must not swap the hex.
- **Do** keep settings, dialogs, Kanban, conversation, file tree, and preview controls aligned to the same radius, hairline, focus, and material rules.

### Don't

- **Don't** paint content or chrome with a translucent mix, or give Windows a different solid from macOS.
- **Don't** separate a section header from its own content, or sibling rows inside the same card, with a full-width divider. It reads as a hard rule and looks cheap. Use spacing and grouping; the card's outer hairline is enough.
- **Don't** use generic AI-SaaS patterns: oversized cards, decorative gradients, glass panels as ornament, hero metrics, vague productivity claims.
- **Don't** use the accent as decorative fill — it means selected/focused/primary/live only.
- **Don't** use side-stripe borders > 1px, gradient text, or `background-clip: text` in product UI.
- **Don't** use pure black/white when a tinted token exists, or invent local palettes via `gray-*`, `bg-white`, `text-white`, or hard-coded hex.
- **Don't** crowd toolbars; demote secondary actions to an overflow menu instead of squeezing them in.
- **Don't** let hover or selection rely on color alone, or remove focus styling from interactive controls.
