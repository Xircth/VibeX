# Phase 2 Closure Review

Date: 2026-06-13

Branch: `master`

## Scope

Phase 2 closes the front-end conversation rendering and composer alignment items C1-C16 from the Codeg gap matrix.

## C1-C16 Status

| Gap | Status | Evidence |
| --- | --- | --- |
| C1 Streaming Markdown | Completed via ReactMarkdown equivalent fallback | T2.3 |
| C2 Shiki code highlighting | Completed | T2.4 |
| C3 stick-to-bottom | Completed and repaired | T2.6 |
| C4 CJK/soft breaks | Completed via fallback preprocessing/CSS | T2.2/T2.3 |
| C5 KaTeX math | Completed | T2.5 |
| C6 Mermaid | Completed | T2.5 |
| C7 virtualized conversation rows | Completed with `@tanstack/react-virtual` | T2.6 |
| C8 Thinking card upgrade | Completed | T2.10 |
| C9 multi-type tool cards | Completed | T2.7-T2.9/T2.13 |
| C10 inline diff preview | Completed | T2.9 |
| C11 message navigation rail | Completed | T2.11 |
| C12 TurnStats/LiveTurnStats | Completed | T2.12 |
| C13 `@`/`/` command sources | Completed for composer; global command palette remains outside Phase 2 scope | T2.14 |
| C14 message queue visualization | Completed for current single queued prompt model; reorder controls disabled until backend supports multiple queued prompts | T2.14 |
| C15 inline images/generated image card | Completed | T2.13 |
| C16 overlayscrollbars | Cropped/deferred | T2.15 |

## Review Findings Closed

- Shiki is split out of generic `vendor` into `vendor-shiki`, and Mermaid remains in `vendor-mermaid`.
- `VirtualizedList` no longer clears all row measurement cache on every streaming patch; it keeps `scrollMargin`, bottom correction, and session-switch at-bottom reset.
- File preview language names are mapped to Shiki-safe names.
- Mermaid keeps the last successful render while new output is pending.
- HTML document preview keeps DOMPurify sanitization outside the conversation renderer.
- Shiki highlighter initialization can retry after failure.
- Tool-card behavior changes from the first implementation pass were corrected: Chinese labels are retained, non-command success cards stay neutral, and install-script output keeps the expected default expansion.
- Composer queue behavior is now spec-aligned with the actual backend single-queue model.

## Validation

Final gates:

- `pnpm run check` passed.
- `pnpm run lint` passed.
- `cargo test --workspace` passed.

Additional Phase 2 gates recorded in `visual-build-validation.md`:

- `pnpm run frontend:check` passed.
- `pnpm run frontend:lint` passed.
- `cd frontend && pnpm vitest run` passed: 134 files, 721 tests.
- `pnpm run frontend:build` passed.
- `npx impeccable detect --fast --json frontend/src/components frontend/src/styles` passed with `[]`.
- Playwright screenshots captured root, desktop Phase 2 fixture, and mobile Phase 2 fixture.

## Residual Risks

- `vendor-shiki` is intentionally separated from first-load `vendor`, but remains large. It is not a Phase 2 blocker because it is lazy and no longer inflates the generic vendor chunk; keep it visible for later performance work.
- The browser screenshot path uses Playwright Chromium because Chrome stable is not installed and the Chrome DevTools MCP cannot launch. A full Tauri-shell manual profile should be rerun on a workstation with Chrome/Tauri available.
- `AGENTS.md` and `CLAUDE.md` remain deleted in the working tree as pre-existing user-state changes and are not part of Phase 2 closure.
