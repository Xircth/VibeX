---
name: VibeX
description: Local-first AI coding agent orchestration workspace for developers.
colors:
  primary: "#5b8cc7"
  primary-foreground: "#f8fafc"
  shell-bg: "#eef1f5"
  content-bg: "#fafafa"
  panel-bg: "#ffffff"
  panel-translucent: "#ffffffd9"
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
  lg: "8px"
  xl: "12px"
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
    padding: "8px 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "32px"
  input-default:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "40px"
  card-default:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: VibeX

## 1. Overview

**Creative North Star: "The Developer Flight Deck"**

VibeX should feel like a local engineering control surface: calm, dense, inspectable, and fast to scan. The product is not trying to impress users with a decorative AI aesthetic. It is trying to help them coordinate multiple agent sessions, worktrees, terminals, previews, and diffs without losing context.

The current system already has the right foundations: IBM Plex typography, Ayu-inspired code colors, restrained blue selection states, and workspace-specific shell classes. The next step is unification. Workspace, settings, Kanban, file tree, conversation, dialogs, toasts, and preview surfaces must stop carrying separate visual dialects.

**Key Characteristics:**
- Dense information, quiet surfaces, visible state.
- Light mode is the primary working scene; dark mode is supported for code-heavy or low-light sessions.
- Blue accent is functional: selected, focused, primary, or live state only.
- Panels are layered by border, tonal surface, and small shadows, not by decorative glass.
- Typography is compact, fixed scale, and developer-readable.

## 2. Colors

The palette is a restrained technical neutral system with one calm blue accent and small semantic status colors.

### Primary
- **Workbench Blue**: The primary action, active navigation, selected session, focus, and drag target accent.

### Secondary
- **Ayu Semantic Green**: Success, passed checks, and positive terminal state.
- **Ayu Amber**: Warning, queued, pending, and attention states that are not destructive.

### Tertiary
- **Review Red**: Destructive actions, failed processes, deleted diff state, and irreversible warnings.

### Neutral
- **Shell Mist**: The broad workspace background.
- **Panel White**: Primary panel and card surface in light mode.
- **Control Wash**: Toolbar buttons, chips, and inactive controls.
- **Ink Strong**: Headings and important labels.
- **Ink Muted**: Secondary metadata, timestamps, empty-state copy, and helper labels.
- **Hairline Border**: Panel seams, list separators, and input outlines.

### Named Rules

**The State-Only Accent Rule.** Blue is for selected, focused, primary, or live state. It is not decorative fill.

**The Tinted Neutral Rule.** Avoid pure black and pure white. Use tinted neutrals from the token system so surfaces feel integrated.

**The One Surface Family Rule.** Workspace, settings, session hub, dialogs, and preview controls must use the same neutral and border roles unless a host runtime forces a specific override.

## 3. Typography

**Display Font:** IBM Plex Sans with Noto Emoji fallback
**Body Font:** IBM Plex Sans with Noto Emoji fallback
**Label/Mono Font:** IBM Plex Mono with Noto Emoji fallback

**Character:** IBM Plex gives the app an editorial but technical voice. It is readable at compact sizes and avoids generic web-app blandness.

### Hierarchy
- **Display** (600, 1.125rem, 1.55): App-level titles, welcome headings, and dense page headers only.
- **Headline** (600, 1rem, 1.5): Panel titles, major settings sections, and high-level status headers.
- **Title** (600, 0.875rem, 1.43): Card titles, list item titles, dialog headings, and toolbar group labels.
- **Body** (400, 0.875rem, 1.43): Normal UI copy, list content, and settings descriptions. Cap prose around 65 to 75 characters when it is not data.
- **Label** (500, 0.75rem, 1.33): Metadata, chips, compact controls, timestamps, and helper text.
- **Mono** (400, 0.75rem, 1.5): Paths, terminal data, code references, branch names, and structured logs.

### Named Rules

**The Compact Scale Rule.** Product UI uses fixed compact sizes. Do not use viewport-scaled type in panels, sidebars, dialogs, or dashboards.

**The Label Honesty Rule.** If text is metadata, make it a label. Do not promote secondary labels into headline size to fill space.

## 4. Elevation

VibeX uses a hybrid of tonal layering and restrained shadow. Most resting surfaces should be flat with a 1px border. Shadows are reserved for floating shells, popovers, dialogs, toasts, dragged items, and important hover responses. Heavy blur should be treated as an exception, not a default surface material.

### Shadow Vocabulary
- **Shell Shadow** (`0 18px 42px hsl(220 36% 8% / 0.16)`): Floating project rail, loading panels, and large shell elements that sit above the workspace.
- **Popover Shadow** (`0 18px 42px hsl(220 36% 8% / 0.2)`): Dialogs, menus, and command surfaces.
- **Card Shadow** (`0 2px 7px hsl(220 36% 8% / 0.075)`): Session cards and compact repeated items only.
- **Composer Shadow** (`0 -4px 12px hsl(220 36% 8% / 0.045), 0 5px 14px hsl(220 36% 8% / 0.06)`): The follow-up composer because it is a persistent action surface.

### Named Rules

**The Flat-At-Rest Rule.** Cards and panels are flat at rest unless they are floating above another layer.

**The Blur Budget Rule.** Backdrop blur is allowed for top bars, dialogs, and toasts only when it clarifies stacking. Do not use glassmorphism as decoration.

## 5. Components

### Buttons

- **Shape:** Compact rounded rectangle (6px radius) for standard buttons, icon buttons at 8px where touch targets need clearer shape.
- **Primary:** Workbench Blue background with light foreground, 40px height for normal actions, 32px for dense toolbars.
- **Hover / Focus:** Hover darkens or tints the surface. Focus uses a subtle blue ring or border, never a harsh glow.
- **Secondary / Ghost / Tertiary:** Ghost buttons are transparent until hover. Outline buttons use Hairline Border and should not become visually heavier than primary actions.

### Chips

- **Style:** Soft neutral background, 1px border, 12px label type.
- **State:** Selected chips use Active Blue Wash, not saturated primary fill. Count chips stay quiet unless they indicate a warning or failure.

### Cards / Containers

- **Corner Style:** 8px for repeated cards. Use 12px to 14px only for shell-scale containers such as composer, Kanban columns, and dialogs.
- **Background:** Panel White or translucent panel tokens. Do not mix ad hoc `bg-white`, `bg-gray-*`, and tokenized surfaces in the same area.
- **Shadow Strategy:** Repeated cards get low shadow or no shadow. Large shell overlays may use Shell Shadow.
- **Border:** 1px Hairline Border by default. Avoid thick colored side borders.
- **Internal Padding:** 12px for dense lists, 16px for cards, 24px only for modal or settings content.

### Inputs / Fields

- **Style:** Transparent or Control Wash background, 1px border, 6px radius, compact 40px height.
- **Focus:** Blue focus ring at low opacity. Do not remove focus styling except for explicitly decorative close buttons.
- **Error / Disabled:** Error state uses Review Red with text explanation. Disabled controls reduce opacity and keep cursor behavior clear.

### Navigation

Navigation is panel-native: left rail, top bar, tab switchers, command palette, and session hub controls. Active state uses Workbench Blue or Active Blue Wash. Hover states should never change layout size, border width, or text wrapping.

### Signature Component

The **Composer Shell** is the main signature surface. It should feel grounded, always available, and slightly lifted from the right panel. Keep its controls visually quieter than the text input and send action.

## 6. Do's and Don'ts

### Do:

- **Do** use the tokenized shell classes in `frontend/src/styles/legacy/index.css` before adding new one-off Tailwind color stacks.
- **Do** keep product controls compact: 32px dense controls, 40px default controls, 8px default card radius.
- **Do** communicate state with text, icon, and color together for agent status, queue state, git status, and destructive actions.
- **Do** keep hover changes stable. Change color, shadow, or transform; do not change dimensions.
- **Do** keep settings, dialogs, Kanban, conversation, file tree, and preview controls aligned to the same radius, border, and focus rules.

### Don't:

- **Don't** use generic AI SaaS dashboard patterns: oversized cards, decorative gradients, glass panels, and vague productivity claims.
- **Don't** use side-stripe borders greater than 1px on cards, callouts, list items, markdown blocks, or file tree rows.
- **Don't** use pure black or pure white for app surfaces when a tinted token exists.
- **Don't** use gradient text or background-clip text in product UI.
- **Don't** let individual areas invent their own palette through `gray-*`, `bg-white`, `text-white`, hard-coded hex colors, or isolated CSS files.
- **Don't** use large rounded cards as decoration inside dense tool surfaces.
