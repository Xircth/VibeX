# Phase 2 T2.17 Visual, Performance, and Build Validation

Date: 2026-06-13

## Automated Gates

| Gate | Result |
| --- | --- |
| `pnpm run frontend:check` | Passed |
| `pnpm run frontend:lint` | Passed |
| `cd frontend && pnpm vitest run` | Passed: 134 files, 721 tests |
| `pnpm run frontend:build` | Passed |
| `npx impeccable detect --fast --json frontend/src/components frontend/src/styles` | Passed: `[]` |

Full vitest emitted existing non-failing warnings:

- React Router v7 future-flag warnings in route tests.
- React `act(...)` warnings in `SessionComposerInput.test.tsx`.
- Expected error logs in file-tree negative-path tests.

## Browser Screenshots

Chrome stable is not installed in this environment, so the Chrome DevTools MCP cannot launch the in-app browser. To still cover the screenshot gate, Playwright Chromium was installed into the local browser cache and launched by explicit executable path.

Captured screenshots:

| File | Viewport | Covered States |
| --- | --- | --- |
| `screenshots/app-root.png` | 1440 x 1000 | production preview root / empty-project welcome state |
| `screenshots/phase2-harness-desktop.png` | 1440 x 1200 | rich Phase 2 conversation fixture on desktop |
| `screenshots/phase2-harness-mobile.png` | 390 x 1200 | same fixture on mobile/narrow viewport |

The temporary Vite harness was not retained in product code. It rendered the real Phase 2 fixture and real components, then was deleted after screenshot capture.

The desktop/mobile harness screenshots cover:

1. CJK user message with inline `.vibe-images` reference fallback.
2. Workspace/file and slash-command inline references.
3. Assistant Markdown paragraph rendering.
4. Inline and block KaTeX math.
5. Mermaid diagram rendering.
6. Shiki code block with copy action.
7. Thinking row.
8. Command cards for running and succeeded commands.
9. File/search/web tool cards.
10. Inline diff preview.
11. Plan card.
12. Generated image card.
13. TurnStats and LiveTurnStats.
14. Queued message UI with edit/delete/reorder controls.
15. Message navigation rail on desktop.

Browser console note:

- The harness logs one expected `get_user_system_info` Tauri bridge error because it runs in a normal browser, not inside the Tauri shell. The rendered components fall back to null config and remain usable.

## Build Chunk Observation

`pnpm run frontend:build` confirms the high-severity Phase 2 chunk regression is closed in the important sense: Shiki and Mermaid are no longer swallowed by the initial `vendor` chunk. They are emitted as explicit lazy chunks:

- `vendor-shiki-*.js`: about 9.3 MB minified / 1.62 MB gzip.
- `vendor-mermaid-*.js`: about 2.85 MB minified / 776 KB gzip.

Those chunks are still large and should stay visible as future performance work, but they are separated from the generic first-load vendor path.

Vite still reports generic chunk-size warnings for `vendor`, `index`, `vendor-mermaid`, and `vendor-shiki`; no new Phase 2 build failure was observed.

## Performance Scope

The 1,000-row long conversation fixture remains covered by `longConversation.test.ts` and the full frontend vitest run. DOM-level scroll performance is represented by the T2.6 virtual-scroll tests and the browser screenshots above; a real Tauri-shell scroll profile remains a follow-up because the MCP browser cannot launch system Chrome in this environment.
