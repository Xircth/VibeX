import { describe, expect, it } from 'vitest';
import { splitMarkdownIntoBlocks } from './markdownBlocks';

const SAMPLE_DOC = [
  '# Heading',
  '',
  'First paragraph with **bold** text.',
  '',
  '- item one',
  '- item two',
  '',
  '  continuation of item two after a blank line',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  'Setext heading',
  '===',
  '',
  '> a blockquote',
  '',
  '<div>html block</div>',
  '',
  '$$',
  'a = b',
  '',
  'c = d',
  '$$',
  '',
  'Closing paragraph.',
  '',
].join('\n');

describe('splitMarkdownIntoBlocks', () => {
  it('returns [] for empty input', () => {
    expect(splitMarkdownIntoBlocks('')).toEqual([]);
  });

  it('is lossless: blocks join back to the input', () => {
    const docs = [
      SAMPLE_DOC,
      'plain paragraph',
      'unclosed fence\n\n```ts\nconst x = 1;',
      '| a | b |\n|---',
      '\n\nleading blank lines\n',
      '$$\nunclosed math\n\nmore',
    ];
    for (const doc of docs) {
      expect(splitMarkdownIntoBlocks(doc).join('')).toBe(doc);
    }
  });

  it('keeps a fenced code block as a single block', () => {
    const blocks = splitMarkdownIntoBlocks(
      'before\n\n```ts\ncode\n```\n\nafter'
    );
    expect(blocks.some((b) => b.startsWith('```ts'))).toBe(true);
    expect(
      blocks
        .filter((b) => b.includes('```'))
        .every((b) => !b.includes('before'))
    ).toBe(true);
  });

  it('keeps a table as a single block', () => {
    const blocks = splitMarkdownIntoBlocks(
      'intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\noutro'
    );
    const tableBlocks = blocks.filter((b) => b.includes('| --- |'));
    expect(tableBlocks).toHaveLength(1);
    expect(tableBlocks[0]).toContain('| 1 | 2 |');
  });

  it('keeps a list spanning blank lines as a single block', () => {
    const blocks = splitMarkdownIntoBlocks(
      '- one\n- two\n\n  two continued\n\nafter'
    );
    const listBlocks = blocks.filter((b) => b.includes('- one'));
    expect(listBlocks).toHaveLength(1);
    expect(listBlocks[0]).toContain('two continued');
  });

  it('merges a $$ math block containing blank lines into one block', () => {
    const blocks = splitMarkdownIntoBlocks(
      'before\n\n$$\na = b\n\nc = d\n$$\n\nafter'
    );
    const mathBlocks = blocks.filter((b) => b.includes('a = b'));
    expect(mathBlocks).toHaveLength(1);
    expect(mathBlocks[0]).toContain('c = d');
    expect(mathBlocks[0]).not.toContain('after');
  });

  it('does not let $$ inside a fenced code block open math mode', () => {
    const blocks = splitMarkdownIntoBlocks(
      '```\n$$\n```\n\nparagraph one\n\nparagraph two'
    );
    expect(blocks.filter((b) => b.includes('paragraph'))).toHaveLength(2);
  });

  it('splits two paragraphs into two blocks', () => {
    const blocks = splitMarkdownIntoBlocks('one\n\ntwo');
    expect(blocks).toHaveLength(2);
  });

  it('is append-stable: growing input never changes completed blocks', () => {
    let previous: string[] = [];
    for (let i = 1; i <= SAMPLE_DOC.length; i += 1) {
      const current = splitMarkdownIntoBlocks(SAMPLE_DOC.slice(0, i));
      const stablePrev = previous.slice(0, -1);
      const comparable = current.slice(0, stablePrev.length);
      expect(comparable).toEqual(stablePrev);
      previous = current;
    }
  });
});
