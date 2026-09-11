import { describe, expect, it } from 'vitest';
import { markdownFromRange } from './conversationSelectionMarkdown';

function select(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range;
}

describe('markdownFromRange', () => {
  it('reconstructs emphasis, inline code, and links', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<p>Use <strong>bold</strong>, <em>italic</em>, <code>code</code>, and <a href="https://example.com">link</a>.</p>';
    document.body.append(root);

    expect(markdownFromRange(select(root))).toBe(
      'Use **bold**, *italic*, `code`, and [link](https://example.com).'
    );
    root.remove();
  });

  it('reconstructs lists, headings, and quotes', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<h2>Title</h2>',
      '<ul><li>first</li><li>second</li></ul>',
      '<ol><li>one</li><li>two</li></ol>',
      '<blockquote><p>quoted</p></blockquote>',
    ].join('');
    document.body.append(root);

    expect(markdownFromRange(select(root))).toBe(
      [
        '## Title',
        '',
        '- first',
        '- second',
        '',
        '1. one',
        '2. two',
        '',
        '> quoted',
      ].join('\n')
    );
    root.remove();
  });

  it('keeps fenced code, language, and line breaks from conversation code blocks', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="conv-md-codeblock">
        <div class="conv-md-codeblock-header">
          <span class="conv-md-codeblock-language">ts</span>
          <button class="conv-md-codeblock-copy">复制</button>
        </div>
        <pre><code class="language-ts">
          <span class="conv-md-codeblock-line">const a = 1;</span>
          <span class="conv-md-codeblock-line">const b = 2;</span>
        </code></pre>
      </div>
    `;
    document.body.append(root);

    expect(markdownFromRange(select(root))).toBe(
      '```ts\nconst a = 1;\nconst b = 2;\n```'
    );
    root.remove();
  });

  it('fences a selection that stays inside a code block', () => {
    const root = document.createElement('pre');
    root.className = 'user-message-code-block';
    root.dataset.language = 'ts';
    const code = document.createElement('code');
    code.textContent = 'const answer = 42;';
    root.append(code);
    document.body.append(root);

    expect(markdownFromRange(select(code))).toBe(
      '```ts\nconst answer = 42;\n```'
    );
    root.remove();
  });
});
