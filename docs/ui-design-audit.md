# VibeX UI Design Audit

Date: 2026-05-25
Skill: impeccable
Scope: `frontend/src/components`, `frontend/src/styles`, Tailwind config, shadcn primitives, workspace shell, Kanban session hub, composer, file tree, conversation, and docs context.

> Historical note: this audit is a migration reference. `DESIGN.md` is the
> single current source of truth for frontend design. The active convergence
> plan lives in `docs/specs/tahoe-design-system-convergence/`.

## Summary

VibeX has a credible product UI foundation: compact IBM Plex typography, Ayu-inspired code colors, tokenized workspace surfaces, and a useful distinction between shell, panel, card, control, active, and semantic states. The weak point is not lack of styling. The weak point is that several UI regions still carry separate visual systems.

The app will feel more advanced and elegant when it behaves like one workbench instead of a set of individually polished surfaces. The core direction should be: fewer one-off color stacks, fewer decorative blur and shadow recipes, less radius inflation, no thick side accents, and stricter state vocabulary.

## Current Strengths

- `frontend/src/styles/legacy/index.css` already provides a real token layer for shell, topbar, sidebar, card, composer, borders, shadows, and active states.
- `frontend/tailwind.legacy.config.js` maps product roles into Tailwind, which gives future UI work a reusable path.
- `frontend/src/components/ui/button.tsx`, `input.tsx`, `dialog.tsx`, and related shadcn primitives give the app a component base instead of raw elements everywhere.
- The Kanban session hub and composer have recent localized styling hooks (`session-hub-card`, `session-hub-status-zone`, `composer-shell`) that are good boundaries for incremental polishing.

## Main Design Problems

### P1: The app has multiple visual dialects

Evidence:
- `frontend/src/styles/legacy/index.css` defines the main product vocabulary.
- `frontend/src/styles/dockview-ayu.css` keeps a separate hard-coded Ayu palette.
- `frontend/src/styles/file-tree/*` has its own token and shadow vocabulary.
- `frontend/src/styles/conversation/*` has its own palette, message, markdown, and component rules.
- `frontend/src/vscode/ContextMenu.tsx` uses direct `gray-*`, `bg-white`, and `dark:bg-gray-*` classes instead of the product tokens.

Why it matters:
The user sees workspace, file tree, conversation, and menus as one product. When each area has different neutrals, shadows, corners, and contrast behavior, the app feels less mature even when each individual surface is acceptable.

Fix:
Define `DESIGN.md` as the source of truth, then migrate each region toward the same token roles: shell, panel, control, active, border, text, semantic status, and focus.

### P1: Several anti-patterns make the UI feel less refined

Automated `impeccable detect --fast --json frontend/src/components frontend/src/styles` found 7 warnings:

- `frontend/src/components/NormalizedConversation/conversation-entry-utils.ts:758` uses `border-l-4`.
- `frontend/src/components/ui/wysiwyg.tsx:314` uses `border-l-4`.
- `frontend/src/styles/file-tree/file-tree-base.css:782` uses `border-left: 8px solid var(--surface-popover)`.
- `frontend/src/components/panels/git/GitDiscardDialog.tsx:45` uses `bg-black`.
- `frontend/src/components/search/SearchPalette.tsx:152` uses `bg-black`.
- `frontend/src/components/showcase/ShowcaseStageMedia.tsx:40` uses `bg-black`.
- `frontend/src/styles/conversation/conv-messages.css:161` uses `transition: max-height`.

Why it matters:
Thick side accents, pure black surfaces, and layout property animation are recognizable signs of rushed AI UI. They are also harder to theme consistently across light and dark modes.

Fix:
Replace side stripes with full-border, tinted background, icon, or status chip treatments. Replace `bg-black` with a tinted overlay token. Replace `max-height` animation with transform, opacity, or grid row reveal where possible.

### P2: Radius and elevation are too inconsistent

Evidence:
- Core shadcn primitives default to `rounded-md` and `rounded-lg`.
- App-level dialogs/toasts use `rounded-2xl`, `rounded-xl`, and heavy shadows in `frontend/src/App.tsx` and `frontend/src/styles/legacy/index.css`.
- Kanban columns use 14px radius while cards use 8px to 12px patterns.
- Project rail and toast surfaces use blur and multi-layer shadows that risk feeling more decorative than structural.

Why it matters:
A desktop productivity tool can be polished without feeling soft or inflated. Too many large radii and floating shadows make dense work surfaces feel less precise.

Fix:
Use 6px for buttons and inputs, 8px for repeated cards, 12px to 14px only for shell-scale panels, dialogs, and the composer. Keep resting cards flat or low-shadow.

### P2: Color is sometimes decorative instead of semantic

Evidence:
- The shell has a strong semantic token direction, but file tree, conversation, Dockview, and context menu still carry many hard-coded hex or Tailwind gray values.
- `conv-components.css` includes background-clip text behavior, which the design system should prohibit for product UI.
- Some surfaces use white or black directly, while the token system already provides tinted equivalents.

Why it matters:
VibeX is state-heavy. Color should help users distinguish selected session, active workspace, running process, warnings, failures, and review state. Decorative color competes with that job.

Fix:
Reserve Workbench Blue for selected, focused, primary, or live state. Move hard-coded region palettes behind shared CSS variables or mapped Tailwind roles.

### P2: Component state coverage is uneven

Evidence:
- Buttons and several shell controls cover hover and active states.
- Inputs have weaker default focus vocabulary and rely partly on local page overrides.
- File tree and conversation states use separate hover, selected, drag, and markdown treatments.
- Some focus handling is explicitly suppressed for close buttons.

Why it matters:
This product is keyboard-heavy and developer-heavy. State affordances need to be predictable across command palette, dialogs, file tree, composer, and Kanban.

Fix:
Document and enforce default, hover, active, focus-visible, disabled, loading, error, selected, and drag-over behavior for core primitives.

## Design Health Score

| Area | Score | Notes |
| --- | ---: | --- |
| Visual hierarchy | 3/4 | Dense but generally understandable. Needs stronger shared hierarchy across regions. |
| Consistency and standards | 2/4 | Main weakness. Several independent styling dialects. |
| Aesthetic restraint | 2/4 | Good direction, but too much blur, side accents, and large-radius overlays remain. |
| State clarity | 3/4 | Many states exist, but vocabulary is not unified. |
| Accessibility | 2/4 | Good keyboard intent, but color-only and focus inconsistencies need cleanup. |
| Performance-conscious UI | 2/4 | Layout animation and heavy blur should be reduced. |

Overall: 14/24. The product is workable and has a real foundation, but it is not yet visually unified enough to feel premium.

## Historical Recommended Unification Plan

1. Adopt `DESIGN.md` as the single current design context for future UI work.
2. Fix the automated warnings first: side stripes, pure black backgrounds, and max-height transition.
3. Unify `ContextMenu`, file tree, and conversation styles against the `legacy/index.css` token roles.
4. Normalize radius and elevation: 6px controls, 8px cards, 12px to 14px shell surfaces only.
5. Add focused visual regression tests or browser screenshots for workspace, Kanban session hub, composer, search palette, file tree, conversation, and dialogs.

## 2026-05-25 Implementation Pass

Completed:
- Reworked `frontend/src/styles/dockview-ayu.css` so Dockview uses the shared workspace token vocabulary for tab bars, panels, active tabs, borders, drag-over states, scrollbars, shadows, and resize handles.
- Cleared all 7 `impeccable detect --fast` warnings: thick side accents, pure black overlays/media well, background-clip text, and max-height animation.
- Tokenized the webview context menu, Dockview diff permission badge, folder picker file icon, and Kanban second-rank badge.
- Replaced the file preview arrow's border-triangle implementation with a rotated surface square so it no longer reads as a thick side accent.

Remaining follow-up:
- `RestoreLogsDialog` switch knobs, `sonner` toast styling, task detail status chips, todo icon states, and ready-content preview containers still contain local `white`/`gray-*` utility classes. Some are intentional content-canvas or primitive states, but they should be reviewed in a second pass if the goal is full token purity.
- Visual QA is still needed in both light and dark modes for the full desktop shell, because Dockview is sensitive to internal class changes across package versions.

## Guardrails For Future Agents

- Do not create a new visual language for one screen.
- Do not add new dependencies for visual polish.
- Do not use hard-coded `gray-*`, `bg-white`, `text-white`, pure black, or direct hex values unless documenting a host-runtime override.
- Do not use side-stripe borders greater than 1px.
- Do not use decorative glassmorphism.
- Use lucide icons for recognizable actions before text-only tool buttons.
