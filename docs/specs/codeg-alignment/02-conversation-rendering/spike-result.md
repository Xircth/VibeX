# Phase 2 T2.1 Spike Result: React 18 Rendering Stack

Date: 2026-06-13

## Scope

This spike verified whether the Codeg-aligned conversation rendering candidates can coexist in a minimal Vite + React 18 application:

- `streamdown`
- `@streamdown/cjk`
- `@streamdown/code`
- `@streamdown/math`
- `@streamdown/mermaid`
- `shiki`
- `use-stick-to-bottom`
- `virtua`

The temporary demo was created outside the repository under the system temp directory and was deleted from the implementation surface. Only this decision document is retained.

## Compatibility Matrix

| Package | Checked version | React 18/Vite status | Notes |
| --- | ---: | --- | --- |
| `streamdown` | 2.5.0 | Compatible | Peer range includes React 18/19. Type and build smoke passed. |
| `@streamdown/cjk` | 1.0.3 | Compatible | Exports `cjk` and `createCjkPlugin`; peer range includes React 18/19. |
| `@streamdown/code` | 1.1.1 | Compatible | Exports `code` and `createCodePlugin`; depends on Shiki. |
| `@streamdown/math` | 1.0.2 | Compatible | Exports `math` and `createMathPlugin`; supports KaTeX integration. |
| `@streamdown/mermaid` | 1.0.2 | Compatible | Exports `mermaid` and `createMermaidPlugin`; strict Mermaid config can be passed. |
| `shiki` | 3.x via plugin stack | Compatible | Dynamic import/export probe succeeded. Existing VibeX Shiki route remains valid. |
| `use-stick-to-bottom` | 1.1.6 | Compatible | Exports `StickToBottom` and `useStickToBottom`; peer range includes React 18. |
| `virtua` | 0.49.1 | Compatible | Exports `VList`, `Virtualizer`, and `WindowVirtualizer`; peer range supports React 18. |

Additional metadata probe:

- `cmdk@1.1.1` supports React 18/19 and is suitable for T2.14.
- `overlayscrollbars` remains optional and should be decided by T2.15 browser/manual smoke because it can interfere with virtual scrolling and text selection.

## Demo Smoke

Temporary demo contents:

- React 18 `createRoot`
- `Streamdown` configured with CJK, code, math, and Mermaid plugins
- `StickToBottom` + `StickToBottom.Content`
- `VList` with mixed rows: CJK, math, Mermaid, TypeScript fences, and regular text

Commands/results:

| Command | Result |
| --- | --- |
| `npm install --silent` | Passed in the temporary demo. |
| `npx tsc --noEmit` | Passed. |
| `npx vite build` | Passed; transformed 2,801 modules. |

The first package-manager attempt with `pnpm` hit the local `ERR_PNPM_IGNORED_BUILDS` approval policy for `esbuild@0.21.5` in the temp project. This is an environment approval issue, not a React 18 compatibility failure. The main VibeX workspace already has a working Vite/esbuild install.

## Bundle Observation

The static full Streamdown plugin stack pulled a large amount of code into the demo build:

- main JS chunk was about 1.7 MB minified before gzip,
- many Shiki language/theme chunks were emitted,
- Mermaid remained a significant secondary dependency even when configured through the plugin.

This means React compatibility is proven, but a direct static replacement would violate Phase 2 performance intent unless VibeX adds explicit lazy-loading and chunk boundaries.

## Decision

1. **Do not add the full `streamdown` + `@streamdown/*` stack to the production renderer in T2.2/T2.3.**
   Keep the VibeX equivalent fallback layer based on `react-markdown`, Shiki token rendering, `remark-math`, `rehype-katex`, and the strict Mermaid fenced-code renderer. This satisfies the T2.3 "Streamdown/备选等价层" path while preserving local links, image proxying, tag references, and existing tests.

2. **Keep `@tanstack/react-virtual` for Phase 2 virtualization.**
   `virtua` is compatible, but T2.6 already has a repaired TanStack implementation with `scrollToIndex`, `scrollMargin`, and measurement correction. Adding a second virtualizer now increases dependency and regression surface without a user-visible gain.

3. **Do not add `use-stick-to-bottom` in Phase 2 unless the current custom anchor fails a browser regression.**
   The package is compatible, but the repaired T2.6 implementation already covers the required stick-to-bottom semantics. A later replacement must include DOM/browser scroll regression tests.

4. **Proceed with `cmdk` for T2.14.**
   It is compatible with React 18 and maps directly to the command/typeahead acceptance criteria.

5. **Treat `overlayscrollbars` as optional for T2.15.**
   It should be either browser-smoked and adopted or explicitly cut with a rationale. It must not be installed merely because Codeg uses it.

## Follow-Up Requirements

- T2.2 should install only dependencies that remain adopted by `design.md`.
- T2.3 should document the fallback-equivalent Markdown path in code/tests rather than adding unused Streamdown dependencies.
- T2.17 should continue to check build chunk size because Shiki and Mermaid remain heavy even with dynamic loading.
