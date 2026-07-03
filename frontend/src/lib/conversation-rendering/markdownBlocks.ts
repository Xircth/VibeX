import { marked } from 'marked';

/**
 * Split markdown into append-stable top-level blocks using marked's lexer.
 *
 * Invariants:
 *  - blocks.join('') === markdown (lossless)
 *  - as markdown grows by appending, only the LAST block's string changes,
 *    so completed blocks can be rendered through memoized markdown instances.
 *
 * Accepted limitation: reference-style link definitions and GFM footnotes
 * only resolve within their own block once rendered per-block.
 */
export function splitMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];
  const tokens = marked.lexer(markdown);
  const blocks: string[] = [];
  let openMath = false;

  for (const token of tokens) {
    const mergeIntoPrevious =
      blocks.length > 0 && (openMath || token.type === 'space');

    if (mergeIntoPrevious) {
      blocks[blocks.length - 1] += token.raw;
    } else {
      blocks.push(token.raw);
    }

    // remark-math display blocks ($$ ... $$) with internal blank lines split
    // across marked paragraph tokens; track unbalanced $$ and keep merging
    // until closed. Fenced code tokens never toggle math state.
    if (token.type !== 'code') {
      const dollarPairs = (token.raw.match(/\$\$/g) ?? []).length;
      if (dollarPairs % 2 === 1) openMath = !openMath;
    }
  }

  return blocks;
}
