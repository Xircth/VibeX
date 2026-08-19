---
name: VibeX
description: Local-first AI coding-agent orchestration workspace, dressed as a native macOS Tahoe app.
register: product
platform: Tauri desktop (React + Tailwind + Radix). macOS Tahoe is the visual target; Windows and Linux degrade gracefully.
colors:
  # One calm system-blue accent, reserved for state (selected / focused / primary / live).
  primary: "#3F6CC4"
  primary-foreground: "#ffffff"
  primary-control-foreground: "#ffffff"
  switch-checked-track: "#1d2530"
  switch-checked-thumb: "#ffffff"
  dark-switch-checked-border: "#ffffff57"
  # Window backdrop sits BEHIND translucent chrome; content layer is opaque.
  shell-bg: "#eef1f5"
  content-bg: "#fafbfc"
  panel-bg: "#ffffff"
  panel-translucent: "#ffffffe6"
  popover-bg: "#fafafa"
  control-bg: "#0f172a0f"
  raised-control-bg: "#f6f7f8"
  raised-control-hover: "#f0f1f3"
  active-bg: "#e0e7f6"
  text-strong: "#1d2530"
  text-primary: "#46505b"
  text-muted: "#727b85"
  border-subtle: "#0b16280f"
  border-strong: "#0b162824"
  success: "#86b300"
  warning: "#f2ae49"
  destructive: "#f51818"
  dark-shell-bg: "#10151c"
  dark-content-bg: "#161c25"
  dark-panel-bg: "#1f2733"
  dark-text-strong: "#e7ebef"
  dark-border-subtle: "#ffffff1a"
materials:
  # Liquid Glass = navigation / controls layer ONLY. Never on content.
  glass-titlebar: "blur(18px) saturate(1.2) over var(--surface-topbar)"
  glass-sidebar: "blur(30px) saturate(1.8) over var(--surface-sidebar)"
  glass-popover: "blur(24px) saturate(1.55)  # menus, popovers, toasts"
  dialog-surface: "opaque #FAFAFA in light mode; solid themed surface in dark mode"
  content-surface: "opaque var(--surface-card-strong) + 1px hairline  # lists, cards, editors"
  reduce-transparency-fallback: "drop blur, fill with solid panel + hairline"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, Segoe UI, system-ui, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, Segoe UI, system-ui, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, Segoe UI, system-ui, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, Segoe UI, system-ui, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "0"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, Segoe UI, system-ui, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC Variable, sans-serif"
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
    border: "none"
    shadow: "0 0 4px #0d121c24"
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
    border: "none"
    shadow: "0 0 4px #0d121c24"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  input-default:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  switch-default:
    checkedBackgroundColor: "{colors.switch-checked-track}"
    checkedThumbColor: "{colors.switch-checked-thumb}"
    darkCheckedBorderColor: "{colors.dark-switch-checked-border}"
    rounded: "{rounded.pill}"
  card-default:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "14px"
  sidebar-nav-row:
    rounded: "14px"
    height: "36px"
    selectedBackground: "{colors.primary}  # accent fill, white label"
---

# Design System: VibeX Tahoe

`DESIGN.md` is the single current source of truth for frontend design in
VibeX. Older audits, generated `.impeccable` output, and files with "legacy" in
their names are migration references only.

**Creative North Star: "The Developer Flight Deck, built as a good Mac citizen."**

VibeX is a local engineering control surface for coordinating many agent sessions, worktrees, terminals, previews, and diffs without losing context. The density and calm of a flight deck stay; what changes is the finish — VibeX should now read as a **native macOS Tahoe app**, not a web dashboard wrapped in a window.

The macOS contract is a two-layer model:

- A **navigation/controls layer** where structural window chrome uses translucent **Liquid Glass**, while light-mode menus, dialogs, and toasts use a calm opaque `#FAFAFA` overlay surface.
- A **content layer** of crisp, **opaque grouped surfaces** (inset lists, cards, editors) where hierarchy comes from layout and grouping — never from decoration.

VibeX is a Tauri app (React + Tailwind + Radix), so "native" is an aesthetic and behavioral target, not a toolkit. The look is delivered through the tokenized shell classes in `frontend/src/styles/legacy/index.css` (`--surface-*`, `.settings-sidebar`, `.settings-surface`, `.workspace-topbar`, blur materials). Every surface must degrade: when the OS reports reduced transparency, glass collapses to a solid panel; on Windows the custom title-bar controls take over where the OS chrome would otherwise sit.

**Key characteristics:**

- Dense information, quiet surfaces, visible state.
- Glass is structural, not decorative — chrome only, never content.
- One calm system-blue accent, used only for selected / focused / primary / live.
- Light mode is the primary working scene; dark mode (Ayu Mirage) is first-class for code-heavy sessions.
- Hierarchy is expressed by grouping and spacing; remove any background, border, or internal rule added purely for emphasis.

## 2. Materials & Layering

This is the section that makes VibeX feel like Tahoe rather than a web app. Decide which layer a surface belongs to before styling it.

### The Navigation/Controls Layer — Liquid Glass

Translucent, blurred, lightly saturated material that floats and lets the workspace show through. Reserved for chrome that frames content:

- **Title bar** (`.settings-titlebar`, `.workspace-topbar`): `blur(18px) saturate(1.2)` over a near-white translucent fill, 1px hairline beneath. Unified with the window; the whole strip is a drag region.
- **Sidebar** (`.settings-sidebar`): a rounded, inset floating panel — `blur(30px) saturate(1.8)`, full hairline border, `14px` corners, soft shell shadow. Content scrolls independently beneath it.
- **Popovers, menus, toasts**: `blur(24px) saturate(1.55)` glass with a popover shadow.
- **Dialogs**: opaque `--surface-dialog` with a popover shadow. The light-mode value is exactly `#FAFAFA`; dark mode uses the solid themed dialog surface. Dialog content never inherits translucent popover glass.

### The Content Layer — Opaque Grouped Surfaces

Everything users read, edit, or scan. **No glass here.** Use opaque panels:

- **Inset grouped lists / cards** (`.settings-surface`): solid `--surface-card-strong`, 1px outer hairline, `14px` corners, flat at rest (no drop shadow). Rows inside one card are separated by spacing, not internal rules; a row gains elevation only while dragged or actively hovered.
- **Editors, tables, conversation, file tree, diffs**: opaque content background, hairline seams.

### Named Rules

**The Two-Layer Rule.** Before styling a surface, name its layer. Chrome may be glass; content must be opaque.

**The Opaque Dialog Rule.** Every modal implementation—shared Dialog, Astryx Dialog, and exceptional fullscreen/custom modals—must resolve its visible surface through `--surface-dialog`. Do not apply `--surface-popover`, glass blur, or a one-off background to a dialog.

**The No-Glass-On-Glass Rule.** Never stack a glass surface on another glass surface (e.g. a blurred popover inside a blurred sidebar reads as mud). One glass layer between the eye and the content.

**The Reduce-Transparency Rule.** Every glass surface needs a solid fallback. Honor `prefers-reduced-transparency`: drop the blur, fill with the solid panel token, keep the hairline. The UI must stay fully legible with transparency off.

**The Decoration-Budget Rule.** If a background or border exists only to draw attention, delete it and express the emphasis through grouping, spacing, or the accent instead.

## 3. Color & Accent

A restrained, system-adaptive neutral palette with one calm blue accent and small semantic status colors. Brand comes from content, iconography, and the accent — not from replacing structure.

### Accent

- **Workbench Blue** (`--primary`, `#3F6CC4`): the calm macOS selection-blue equivalent. Used for the selected sidebar row, focus rings, primary buttons, active navigation, live state, and drag targets. Accent-filled states use the shared white control-foreground token.

### Semantic status

- **Ayu Green** — success, passed checks, healthy terminal.
- **Ayu Amber** — warning, queued, pending; attention without danger.
- **Review Red** — destructive actions, failures, deleted diff state, irreversible warnings.

### Neutrals (tinted, never pure)

- **Shell Mist** — the window backdrop behind the glass chrome.
- **Panel White / Panel Strong** — opaque content surfaces.
- **Control Wash** — quiet toolbar buttons, chips, inactive controls (a low-alpha ink tint).
- **Ink Strong / Ink Muted** — headings vs. metadata.
- **Hairline / Hairline Strong** — alpha-based seams that read correctly on both glass and opaque surfaces.

## 6. Radius, Elevation, And Motion

**The State-Only Accent Rule.** Blue means selected, focused, primary, or live. It is never a decorative fill.

**The System-Adaptive Rule.** Surfaces are built from tinted-neutral tokens that flip with light/dark and strengthen under `prefers-contrast: more`. Avoid pure `#000`/`#fff` and hard-coded hex; reach for the tokens.

**The Honor-The-Accent Rule.** Treat Workbench Blue as the user's system accent: if the platform exposes an accent color, the selection/focus accent should be the only place we'd ever defer to it.

## 4. Typography

VibeX uses the same native system-font strategy as Codex: SF Pro on macOS,
Segoe UI on Windows, and the platform UI sans elsewhere. Chinese follows the
native platform face (PingFang SC on macOS and Microsoft YaHei on Windows),
with bundled Noto Sans SC Variable retained as the offline Linux and missing
glyph fallback. Monospace content remains governed separately by the
user-configurable code-font setting.

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

- **Shell Shadow** (`0 18px 42px hsl(220 36% 8% / 0.16)`): floating sidebar, project rail, loading shells.
- **Popover Shadow** (`0 18px 42px hsl(220 36% 8% / 0.2)`): dialogs, menus, command surfaces.
- **Card Shadow** (`0 1px 2px / 0 10px 30px hsl(220 36% 8% / 0.05)`): grouped `.settings-surface` cards and repeated items, kept very low.
- **Composer Shadow**: the persistent follow-up composer, slightly lifted from the right panel.

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

Unified Liquid Glass strip, full drag region, hairline beneath. Keep it sparse: app mark + title, primary actions tinted, everything secondary demoted. On Windows the custom traffic-light controls live at the right; on macOS the OS owns the left. Settings is always reachable by keyboard.

### Sidebar

A rounded, inset, glass floating panel — the primary, stable navigation. Rows are scannable and never reflow on hover. Selection is an **accent-filled rounded row with a white label** (the macOS System Settings idiom, adjusted for the deeper Workbench Blue). Where a list of destinations benefits from identity, a row may carry a small **colored app-icon badge** (rounded square, white glyph) — reserved for navigation, never content. Content scrolls behind/under the sidebar.

### Toolbars

Group items by function and frequency; the primary action is visually distinct (tinted). Demote secondary actions into a "more" overflow menu rather than crowding the bar — a crowded toolbar is the signal to cut. Remove custom backgrounds/borders; let the glass layer and spacing do the work. Don't pair a text button and an icon button so tightly they read as one control.

### Inset grouped lists & cards (content)

The workhorse content surface: an opaque `.settings-surface` card with a quiet header row and spacing-separated rows. Leading label, trailing control. `14px` corners, `12px` dense / `16px` comfortable padding. This is where settings, agent detail, and list content live. Do not draw hairlines between siblings in the same card.

### Controls

- **Switch**: dark-ink track with a white thumb when on; dark mode adds a light hairline so the track stays distinct. Keep a clear off state and never use the switch as the only signal for a meaningful change.
- **Secondary / outline buttons and selects**: borderless, with a very light cool-gray surface in light mode, an evenly distributed compact shadow on all four sides, and `14px` radius. Dark mode uses the reciprocal dark surface while preserving the same shadow hierarchy.
- **Inputs / fields**: Control Wash background, 1px hairline, `14px` radius, `32px` compact height; blue focus ring at low opacity; error state in Review Red **with a text explanation**.

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

The **Composer Shell** (grounded, always-available action surface) and the **Agent bar** (icon-only, hover reveals the name, accent-filled when selected) are VibeX's signatures. Keep their surrounding controls quieter than the primary input and the selected agent.

## 7. Accessibility (designed in, not added later)

- **Labels:** every icon-only control carries an `aria-label`/title (e.g. the agent bar buttons). Communicate state with icon + text + color together — never color alone.
- **Keyboard:** everything operable without a pointer; visible focus rings on custom controls; standard editing shortcuts (copy/paste/undo) never overridden; a command palette _in addition_ to menus.
- **Contrast:** body text ≥ 4.5:1, large text ≥ 3:1, including over glass; placeholders meet the same bar. Strengthen hairlines under `prefers-contrast: more`.
- **Reduced transparency / motion:** glass collapses to solid panels; animations fall back to crossfade/instant. Both states must stay fully usable.
- **Localization:** layouts absorb longer strings (the UI is bilingual today); never truncate meaning at default width.

## 8. Do's and Don'ts

### Do

- **Do** name a surface's layer (chrome vs content) before styling it; glass for chrome, opaque for content.
- **Do** use the tokenized shell classes in `frontend/src/styles/legacy/index.css` before adding one-off Tailwind color stacks.
- **Do** keep controls compact and consistent: `32px` controls and one `14px` radius token across controls and surfaces.
- **Do** express hierarchy through grouping, spacing, and hairlines — and delete any chrome added only for emphasis.
- **Do** keep hover changes stable: change color, shadow, or a small transform; never size, border width, or text wrapping.
- **Do** give every glass surface a reduced-transparency solid fallback.
- **Do** keep settings, dialogs, Kanban, conversation, file tree, and preview controls aligned to the same radius, hairline, focus, and material rules.

### Don't

- **Don't** put Liquid Glass on content (lists, tables, editors, conversation) or stack glass on glass.
- **Don't** separate a section header from its own content, or sibling rows inside the same card, with a full-width divider. It reads as a hard rule and looks cheap. Use spacing and grouping; the card's outer hairline is enough.
- **Don't** use generic AI-SaaS patterns: oversized cards, decorative gradients, glass panels as ornament, hero metrics, vague productivity claims.
- **Don't** use the accent as decorative fill — it means selected/focused/primary/live only.
- **Don't** use side-stripe borders > 1px, gradient text, or `background-clip: text` in product UI.
- **Don't** use pure black/white when a tinted token exists, or invent local palettes via `gray-*`, `bg-white`, `text-white`, or hard-coded hex.
- **Don't** crowd toolbars; demote secondary actions to an overflow menu instead of squeezing them in.
- **Don't** let hover or selection rely on color alone, or remove focus styling from interactive controls.
