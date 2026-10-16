/**
 * Rollup manualChunks for the Host web bundle.
 *
 *Important invariants:
 * 1. `@shikijs/langs/*` and `@shikijs/themes/*` MUST NOT be forced into a
 *    single manual chunk. Forcing them into one chunk merges all 200+ Shiki
 *    grammars into a >9 MB monolith (`vendor-shiki.js`), defeating Shiki's
 *    per-language dynamic `import()` splitting.
 * 2. Heavy, lazily imported feature libraries (`@xyflow`, `gsap`, `mermaid`,
 *    `monaco-editor`, `@xterm`, `@codemirror`, `@git-diff-view`, `dockview`,
 *    markdown AST processors) get dedicated chunks so they are not glued onto
 *    the initial startup `vendor` chunk.
 * 3. React, Radix, and lucide stay in `vendor-react`. A separate icons or
 *    Radix chunk can evaluate `React.forwardRef` before React is initialized
 *    and leave the Host web UI blank.
 * 4. Everything else stays unassigned so Rollup places it with the importer.
 *    A catch-all `vendor` chunk glues lazy libraries into the startup preload.
 */
export function createManualChunks(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, '/');

  // Vite injects this helper into every module that has a dynamic import.
  // Leaving it unassigned lets the manual-chunk walk swallow it into
  // vendor-monaco, which then becomes a static import of the entry.
  if (normalizedId.includes('vite/preload-helper')) {
    return 'vendor-react';
  }

  if (!normalizedId.includes('/node_modules/')) {
    return undefined;
  }

  // Mermaid ships its own dynamic imports. Forcing one chunk recreates a
  // multi-megabyte monolith. Leave it unassigned so those imports stay split
  // and out of the startup preload.

  // Each grammar is its own dynamic import. Rollup otherwise merges every
  // language that shares the shiki/langs importer into one multi-megabyte chunk.
  const shikiLang = normalizedId.match(
    /\/node_modules\/@shikijs\/langs\/dist\/([^/]+)\.mjs$/
  );
  if (shikiLang && shikiLang[1] !== 'index') {
    return `shiki-lang-${shikiLang[1]}`;
  }

  // Themes stay unassigned. The highlighter loads two of them, not the catalog.
  if (normalizedId.includes('/node_modules/@shikijs/themes/')) {
    return undefined;
  }

  if (
    normalizedId.includes('/node_modules/shiki/') ||
    normalizedId.includes('/node_modules/@shikijs/') ||
    normalizedId.includes('/node_modules/vscode-oniguruma/') ||
    normalizedId.includes('/node_modules/vscode-textmate/')
  ) {
    return 'vendor-shiki-core';
  }

  if (
    normalizedId.includes('/node_modules/monaco-editor/') ||
    normalizedId.includes('/node_modules/@monaco-editor/')
  ) {
    return 'vendor-monaco';
  }

  if (normalizedId.includes('/node_modules/@xterm/')) {
    return 'vendor-terminal';
  }

  if (
    normalizedId.includes('/node_modules/@codemirror/') ||
    normalizedId.includes('/node_modules/@uiw/react-codemirror/')
  ) {
    return 'vendor-codemirror';
  }

  if (normalizedId.includes('/node_modules/@git-diff-view/')) {
    return 'vendor-diff';
  }

  if (
    normalizedId.includes('/node_modules/dockview') ||
    normalizedId.includes('/node_modules/dockview-core/') ||
    normalizedId.includes('/node_modules/dockview-react/')
  ) {
    return 'vendor-dockview';
  }

  if (normalizedId.includes('/node_modules/@tauri-apps/')) {
    return 'vendor-tauri';
  }

  if (
    normalizedId.includes('/node_modules/@xyflow/') ||
    /\/node_modules\/d3(?:-[^/]+)?\//.test(normalizedId)
  ) {
    return 'vendor-xyflow';
  }

  if (
    normalizedId.includes('/node_modules/gsap/') ||
    normalizedId.includes('/node_modules/@gsap/')
  ) {
    return 'vendor-gsap';
  }

  if (normalizedId.includes('/node_modules/katex/')) {
    return 'vendor-katex';
  }

  if (
    /\/node_modules\/(react-markdown|remark-[^/]+|rehype-[^/]+|unified|micromark[^/]*|mdast-[^/]+|hast-[^/]+)\//.test(
      normalizedId
    )
  ) {
    return 'vendor-markdown';
  }

  if (isStartupReactModule(normalizedId)) {
    return 'vendor-react';
  }

  return undefined;
}

function isStartupReactModule(normalizedId: string): boolean {
  return (
    normalizedId.includes('/node_modules/react/') ||
    normalizedId.includes('/node_modules/react-dom/') ||
    normalizedId.includes('/node_modules/react-router/') ||
    normalizedId.includes('/node_modules/react-router-dom/') ||
    normalizedId.includes('/node_modules/scheduler/') ||
    normalizedId.includes('/node_modules/zustand/') ||
    normalizedId.includes('/node_modules/@tanstack/react-query/') ||
    normalizedId.includes('/node_modules/@tanstack/query-core/') ||
    normalizedId.includes('/node_modules/i18next/') ||
    normalizedId.includes('/node_modules/react-i18next/') ||
    normalizedId.includes('/node_modules/@radix-ui/') ||
    normalizedId.includes('/node_modules/lucide-react/') ||
    normalizedId.includes('/node_modules/use-sync-external-store/')
  );
}
