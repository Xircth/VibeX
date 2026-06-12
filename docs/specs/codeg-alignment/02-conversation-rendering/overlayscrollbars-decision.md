# Phase 2 T2.15 Decision: overlayscrollbars

Date: 2026-06-13

## Decision

Do not install `overlayscrollbars` or `overlayscrollbars-react` in Phase 2. Keep native scrollbars for the conversation thread, composer panels, and adjacent side panels.

## Rationale

- Phase 2 already changed the conversation thread to real virtual rows with stick-to-bottom behavior. That path depends on accurate native scroll measurements, `measureElement`, `scrollMargin`, and post-measurement bottom correction.
- A custom scrollbar wrapper would add another scroll container abstraction at the riskiest part of the renderer. The T2.1 spike explicitly left overlayscrollbars optional because it can interfere with virtual scrolling and text selection.
- The user-visible gain is visual consistency only. It does not unlock any required conversation-rendering capability, while a regression would directly affect T2.6, T2.11, T2.12, and T2.17 acceptance.
- Browser screenshot automation is not currently available in this environment, so adopting a scroll wrapper now would lack the DOM-level evidence required by the task.

## Follow-Up

Reconsider overlayscrollbars in a later visual/appearance phase after the project has reliable browser regression coverage for:

- native keyboard scrolling in the virtualized conversation viewport,
- text selection across long assistant messages and code blocks,
- stick-to-bottom during streaming height changes,
- `scrollToIndex` jumps from message navigation and turn stats,
- side panel scroll behavior.

Until then, the accepted Phase 2 behavior is native scrollbars with no dependency added.

## Verification

- `rg "overlayscrollbars" frontend package.json pnpm-lock.yaml` should find no production dependency usage.
- Existing T2.6/T2.11/T2.12 virtual-scroll tests remain the regression guard for scroll semantics.
