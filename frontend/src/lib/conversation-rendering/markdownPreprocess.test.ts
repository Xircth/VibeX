import { describe, expect, it } from 'vitest';
import {
  materializePromptTagReferences,
  serializeTagReferenceMarker,
} from '@/lib/tagReferenceMarkers';
import {
  classifyMarkdownBlock,
  MATH_SPAN_PLACEHOLDER_PREFIX,
  preprocessForBlockSplit,
  splitIntoBlocks,
} from './markdownPreprocess';

describe('preprocessForBlockSplit & splitIntoBlocks', () => {
  it('replaces \\[...\\] spanning 3+ blank lines with a single-line placeholder and restores it in one block', () => {
    const mathBlock = [
      '\\[',
      'a = 1',
      '',
      '',
      '',
      'b = 2',
      '\\]',
    ].join('\n');
    const doc = `Intro paragraph.\n\n${mathBlock}\n\nConclusion paragraph.`;

    const preprocessed = preprocessForBlockSplit(doc);
    expect(preprocessed.mathSpans.size).toBe(1);
    expect(preprocessed.body).toContain(`${MATH_SPAN_PLACEHOLDER_PREFIX}0⟧`);
    expect(preprocessed.body).not.toContain('a = 1\n\n\n\nb = 2');

    const blocks = splitIntoBlocks(preprocessed.body, preprocessed.mathSpans);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      text: 'Intro paragraph.',
      kind: 'paragraph',
      closed: true,
    });
    expect(blocks[1]).toMatchObject({
      text: mathBlock,
      kind: 'paragraph',
      closed: true,
    });
    expect(blocks[2]).toMatchObject({
      text: 'Conclusion paragraph.',
      kind: 'paragraph',
      closed: false,
    });
  });

  it('keeps \\begin{align}...\\end{align} spanning blank lines as a single block', () => {
    const alignBlock = [
      '\\begin{align}',
      'x &= 1 + 2 \\\\',
      '',
      '',
      'y &= 3 + 4',
      '\\end{align}',
    ].join('\n');
    const doc = `# Derivation\n\n${alignBlock}\n\nDone.`;

    const preprocessed = preprocessForBlockSplit(doc);
    expect(preprocessed.mathSpans.size).toBe(1);

    const blocks = splitIntoBlocks(preprocessed.body, preprocessed.mathSpans);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'heading', closed: true });
    expect(blocks[1]).toMatchObject({
      text: alignBlock,
      kind: 'paragraph',
      closed: true,
    });
    expect(blocks[2]).toMatchObject({
      text: 'Done.',
      kind: 'paragraph',
      closed: false,
    });
  });

  it('handles leading $$ at line start and across blank lines without null fallback', () => {
    const displayDollar = ['$$', '\\int_0^1 x^2 dx', '', '= \\frac{1}{3}', '$$'].join(
      '\n'
    );
    const doc = `${displayDollar}\n\n<div>safe html</div>\n\nAfter paragraph.`;

    const preprocessed = preprocessForBlockSplit(doc);
    const blocks = splitIntoBlocks(preprocessed.body, preprocessed.mathSpans);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe(displayDollar);
    expect(blocks[0].closed).toBe(true);
    expect(blocks[1].text).toBe('<div>safe html</div>');
    expect(blocks[2].text).toBe('After paragraph.');
  });

  it('does not touch math-like delimiters inside fenced code or inline code', () => {
    const codeFence = [
      '```tex',
      '\\[',
      'raw = 1',
      '',
      'raw = 2',
      '\\]',
      '```',
    ].join('\n');
    const doc = 'Inline `\\[not math\\]` sample.\n\n' + codeFence + '\n\nTail';

    const preprocessed = preprocessForBlockSplit(doc);
    expect(preprocessed.mathSpans.size).toBe(0);

    const blocks = splitIntoBlocks(preprocessed.body, preprocessed.mathSpans);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({
      text: codeFence,
      kind: 'code',
      closed: true,
    });
  });

  it('compacts loose GFM table rows with blank gaps into a single table block', () => {
    const doc = [
      'Summary before table:',
      '',
      '| Layer | Role |',
      '',
      '| --- | --- |',
      '',
      '| Preprocess | Math & tables |',
      '',
      '| Cache | `500k | LRU` |',
      '',
      'Paragraph after table.',
    ].join('\n');

    const preprocessed = preprocessForBlockSplit(doc);
    const blocks = splitIntoBlocks(preprocessed.body, preprocessed.mathSpans);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe('Summary before table:');
    expect(blocks[1].kind).toBe('table');
    expect(blocks[1].text).toBe(
      [
        '| Layer | Role |',
        '| --- | --- |',
        '| Preprocess | Math & tables |',
        '| Cache | `500k | LRU` |',
      ].join('\n')
    );
    expect(blocks[2].text).toBe('Paragraph after table.');
  });

  it('strips trailing ## Tag Reference appendix into tagAppendix and resolves VibeX inline tag markers', () => {
    const docWithHeadingAppendix = [
      'Body paragraph 1.',
      '',
      'Body paragraph 2.',
      '',
      '## Tag Reference',
      '',
      '- `#arch`: Core architecture note',
      '- `#perf`: Streaming cache budget',
    ].join('\n');

    const res = preprocessForBlockSplit(docWithHeadingAppendix);
    expect(res.tagAppendix).toBe(
      [
        '## Tag Reference',
        '',
        '- `#arch`: Core architecture note',
        '- `#perf`: Streaming cache budget',
      ].join('\n')
    );
    expect(res.body).toBe('Body paragraph 1.\n\nBody paragraph 2.');

    const blocks = splitIntoBlocks(res.body, res.mathSpans, false);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.closed)).toBe(true);

    const marker = serializeTagReferenceMarker({
      tagId: 'tag-1',
      tagName: 'perf-spec',
      content: 'Use 500k char LRU budget',
    });
    const materialized = materializePromptTagReferences(`Review ${marker} now`);
    const markerPreprocessed = preprocessForBlockSplit(materialized);
    expect(markerPreprocessed.tagAppendix).toBeNull();
    expect(markerPreprocessed.body).toContain('[#perf-spec](tag-ref://');
    expect(markerPreprocessed.body).not.toContain('Referenced tags:');
  });

  it('classifies all markdown block kinds and preserves indented list continuations', () => {
    expect(classifyMarkdownBlock('## Heading')).toBe('heading');
    expect(classifyMarkdownBlock('> Quoted text')).toBe('blockquote');
    expect(classifyMarkdownBlock('- Bullet')).toBe('list');
    expect(classifyMarkdownBlock('1. Ordered')).toBe('list');
    expect(classifyMarkdownBlock('---')).toBe('hr');
    expect(classifyMarkdownBlock('```ts\nconst x = 1;\n```')).toBe('code');
    expect(classifyMarkdownBlock('| A | B |\n| --- | --- |\n| 1 | 2 |')).toBe(
      'table'
    );
    expect(classifyMarkdownBlock('Plain prose')).toBe('paragraph');

    const listWithContinuation = [
      '1. First item',
      '',
      '   Indented continuation paragraph under item 1.',
      '',
      '2. Second item',
    ].join('\n');
    const pre = preprocessForBlockSplit(listWithContinuation);
    const blocks = splitIntoBlocks(pre.body, pre.mathSpans, false);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('list');
    expect(blocks[0].text).toContain('Indented continuation paragraph');
    expect(blocks[1].kind).toBe('list');
    expect(blocks[1].text).toBe('2. Second item');
  });
});
