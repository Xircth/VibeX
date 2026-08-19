type KatexRenderer = typeof import('katex').default;

let katexPromise: Promise<KatexRenderer> | null = null;

export function loadKatex(): Promise<KatexRenderer> {
  katexPromise ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([mod]) => mod.default);
  return katexPromise;
}
