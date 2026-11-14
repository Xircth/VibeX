# Production onboarding finish review

Disposition: **fix**. The composition is ready for targeted corrections; a rebuild is unwarranted. Preserve the incumbent welcome hero, scatter marks, glow, and equation.

Method: independent read-only visual finish assessment of the supplied captures and current implementation. No source edits, subagents, live interactions, or new captures. This is a finish review, not the full `impeccable critique` command or a functional certification.

## Evidence and screenshot validity

Reviewed all 12 PNGs in `production-onboarding/`: welcome, agents, detail, history, projects; dark-detail, dark-history, dark-projects; mobileWelcome, mobileAgents, mobileDetail, mobileProjects. Desktop captures are 1440 × 900; narrow captures are 390 × 844. Files are dated 2026-11-13 around 12:40–12:41 local time.

They are valid, readable evidence for the captured production component layouts. The visible “Agent fixture”, sample account, and sample paths establish mocked boundary data; they do not establish native installation, account authorization, history import, or persistence success. The mobile detail capture is scrolled, with part of the Agent list above the visible content region; this is not evidence that the list is missing. Light and dark project fixtures contain different rows, so they cannot establish state equivalence.

The pink translation icon is external browser UI and is excluded from product findings. Native window chrome, dark welcome, narrow history, error/loading/empty states, keyboard focus, long localized strings, and real Host integration are not demonstrated by this set. Exact contrast ratios and computed spacing were not measured from a live browser.

References: `docs/plans/2026-11-13-onboarding-implementation.md`, approved `frontend/src/components/onboarding/onboarding.prototype.html`, `DESIGN.md`, `frontend/CLAUDE.md`, Maiden principles, and Impeccable `reference/craft-floor.md`.

## Material findings

1. **P2 — The primary import action bypasses the selected import.** In `history.png` and `dark-history.png`, a project is checked, but the dominant “下一步” button simply goes to projects. “跳过导入” does the same thing, while the action that imports the selected content is secondary. `OnboardingProjects.tsx:582` and `:602` both call `goToProjects`; the selected import is separate at `:600`. This conflicts with the prototype's primary “导入并继续” action when selections remain. A user following the primary action can leave their checked history behind. Make the primary action import the current selection and continue after success, or present one explicit skip action with primary import and no duplicate next action. Preserve partial-failure recovery.

2. **P2 — Dark onboarding invents a darker page surface.** All three dark captures show an almost-black page around the raised controls. `firstRunExperience.css:34` derives `--onboarding-void` with `color-mix` against shadow ink. `DESIGN.md` assigns the page/chrome their existing opaque role colors and requires components to consume those roles without local palette derivation. Remove this dark remap and use the documented surface token directly. This correction concerns the page surface, not the preserved hero treatment.

3. **P3 — Agent rows retain internal rules inside the grouped list.** `agents.png`, `detail.png`, `dark-detail.png`, and the narrow Agent capture show a horizontal line between every sibling row. The rule originates at `firstRunExperience.css:337`. `DESIGN.md` explicitly calls for spacing-separated siblings inside an inset group. Remove the sibling borders and retain row rhythm, the outer container, hover, and inspected-state treatment. The prototype's Agent rows likewise rely on spacing and individual hover/inspection state.

## Craft-floor assessment

- **Composition and hierarchy: pass.** The single Agent page is compact, details start closed, and the optional column keeps the Agent list present. Narrow projects wrap actions without clipping their labels. The welcome account block is clear and subordinate to the incumbent hero.
- **Product character and restraint: pass.** Grayscale surfaces, actual Agent marks, consistent line icons, and concise task language suit VibeX. The inherited hero is pinned visual truth; its glow and display typography are not redesign targets or generic-pattern findings.
- **Action clarity: needs correction.** The import footer has three forward actions, including two that bypass import. This is the principal user-facing issue.
- **Materials and consistency: needs correction.** The dark page remap and Agent row rules depart from the current design contract. Local numeric radii at CSS lines 951 and 1109 also warrant conversion to existing semantic radius tokens during the same styling change; they do not justify a redesign.
- **Browser surfaces and responsive proof: partial.** A horizontal scrollbar is visible at the bottom of `mobileWelcome.png`. The image alone cannot establish whether the external browser translation UI, scatter overflow, or document sizing causes it. Treat it as a capture uncertainty until measured without that extension; do not alter the hero speculatively. Focus and selection styles and reduced-motion overrides exist in source. Their rendered behavior is not proven by still images.
- **Coverage: partial.** The principal happy-path surfaces are present. The screenshot set does not verify the required failure states or long-content resilience. Functional checks belong to the implementation verification record.

## Next actions

1. Correct the import action hierarchy and dark surface role; remove Agent sibling borders in one bounded batch.
2. Confirm desktop import before/after completion and one dark detail/project state. A narrow welcome recapture without browser translation UI can resolve the horizontal-scroll uncertainty if narrow browser support is part of delivery. The desktop app remains the primary shipped surface.
3. Keep the existing hero and overall layout. No rebuild, new visual direction, or extra explanatory copy is needed.

Questions skipped: this is an explicitly assigned final read-only review with a concrete report contract.

## Bounded fix verification — 2026-11-13

Final disposition: **ship** for the reviewed onboarding finish. This supersedes the initial **fix** disposition and closes its three findings. No further visual changes, rebuild, or recapture are requested by this review.

Re-read the relevant current CSS and `OnboardingProjects.tsx`, and inspected the ten refreshed captures: agents, detail, history, projects, dark-detail, dark-history, dark-projects, mobileAgents, mobileDetail, and mobileWelcome. File timestamps are approximately 12:56–12:57 local time. This pass was deliberately limited to the previously identified fixes.

| Item | Verification | Result |
| --- | --- | --- |
| Import action hierarchy | Light and dark history captures now show one quiet skip and one primary “导入并继续”. Current JSX calls `importHistory()` when selections remain and only calls `goToProjects()` directly when selection is empty. Completion handling enters projects only for `completed` with a result, `failed === 0`, and no result errors, after reloading projects. | Closed |
| Dark page surface | Dark captures visibly use the lighter documented page surface. CSS keeps `--onboarding-void: var(--surface-topbar)` and removes the dark color-mix remap. Implementer reports computed `rgb(27, 27, 27)`, matching `#1b1b1b`. | Closed |
| Agent sibling rules | Refreshed light, dark, and narrow Agent captures show spacing-separated rows with the outer group retained. The production Agent row CSS no longer defines its sibling border. | Closed |
| Semantic radii | The two noted list/select radius declarations now use `var(--radius)`. | Closed |
| Narrow welcome scrollbar | Refreshed mobileWelcome has no horizontal scrollbar; hero, scatter, glow, and account composition remain intact. CSS adds only `overflow-x: hidden` to the intro scroll container and retains vertical scrolling. Implementer traced the overflow to rotated scatter marks (document/body 390px, intro scrollWidth 409px). | Closed |

The refreshed light and dark project captures show Global and VibeX selected. The implementer also reports a browser-fixture click through the import primary action and nine passing project tests, including partial failure, completion-before-start, and empty selection. Those are supporting implementation evidence supplied to this reviewer; this read-only pass did not rerun them or perform live browser clicks.

The craft-floor concerns raised in the initial pass are resolved within the approved visual direction. The screenshot set remains valid fixture-layout evidence, with the same integration and unmeasured accessibility limits documented above. Native account authorization, actual Host import/persistence, and the complete state matrix remain matters for the implementation verification record; this finish verdict does not claim they were exercised here. The external browser translation icon remains excluded. No production source was modified by this reviewer.
