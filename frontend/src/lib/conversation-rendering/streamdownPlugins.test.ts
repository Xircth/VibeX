import { describe, expect, it } from 'vitest';
import { prepareConversationMarkdown } from './streamdownPlugins';

describe('prepareConversationMarkdown', () => {
  it('normalizes bare image paths into markdown image references', () => {
    expect(prepareConversationMarkdown('outputs/mockup.png')).toBe(
      '![mockup.png](outputs/mockup.png)'
    );
  });

  it('normalizes TeX delimiters outside fenced and inline code', () => {
    const prepared = prepareConversationMarkdown(
      'Inline \\(a+b\\)\n\n```ts\nconst raw = "\\\\(not math\\\\)";\n```'
    );

    expect(prepared).toContain('Inline $a+b$');
    expect(prepared).toContain('const raw = "\\\\(not math\\\\)";');
  });

  it('turns user soft line breaks into markdown hard breaks without touching code fences', () => {
    const prepared = prepareConversationMarkdown(
      'first line\nsecond line\n\n```ts\nconst x = 1;\nconst y = 2;\n```',
      { softBreaks: true }
    );

    expect(prepared).toContain('first line  \nsecond line');
    expect(prepared).toContain('const x = 1;\nconst y = 2;');
  });

  it('keeps incomplete Mermaid fences as plain code while streaming', () => {
    expect(
      prepareConversationMarkdown('```mermaid\ngraph TD\nA-->B')
    ).toContain('```text\ngraph TD\nA-->B\n```');
  });
});
