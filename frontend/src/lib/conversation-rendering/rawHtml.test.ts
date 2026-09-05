import { describe, expect, it } from 'vitest';
import { protectRawHtml } from './rawHtml';

const HTML = (index: number) => `HTML${index}`;

describe('protectRawHtml', () => {
  it('captures a balanced allowlisted element as one placeholder', () => {
    const { text, html } = protectRawHtml(
      'x <div class="a">hi</div> y'
    );

    expect(text).toBe(`x ${HTML(0)} y`);
    expect(html).toEqual([{ html: '<div class="a">hi</div>', block: true }]);
  });

  it('treats inline elements as non-block and void tags as standalone', () => {
    const { text, html } = protectRawHtml('before<br>after <sub>2</sub>');
    expect(text).toBe(`before${HTML(0)}after ${HTML(1)}`);
    expect(html).toEqual([
      { html: '<br>', block: false },
      { html: '<sub>2</sub>', block: false },
    ]);
  });

  it('classifies block-level standalone tags (hr) and tables as block', () => {
    const { html } = protectRawHtml('a<hr>b');
    expect(html[0].block).toBe(true);

    const table = protectRawHtml(
      '<table><tr><td>a</td><td>b</td></tr></table>'
    );
    expect(table.text).toBe(HTML(0));
    expect(table.html[0]).toEqual({
      html: '<table><tr><td>a</td><td>b</td></tr></table>',
      block: true,
    });
  });

  it('captures HTML comments', () => {
    const { text, html } = protectRawHtml('a<!-- note -->b');
    expect(text).toBe(`a${HTML(0)}b`);
    expect(html[0].html).toBe('<!-- note -->');
  });

  it('handles self-closing and quoted attributes with a > inside', () => {
    const input =
      '<a title="x > y" href="/z">ok</a><img src="a b.png" alt=""/>';
    const { text, html } = protectRawHtml(input);
    expect(text).toBe(`${HTML(0)}${HTML(1)}`);
    expect(html[0].html).toBe('<a title="x > y" href="/z">ok</a>');
    expect(html[1].html).toBe('<img src="a b.png" alt=""/>');
  });

  it('leaves autolinks, email-ish and less-than text untouched', () => {
    for (const input of [
      '<https://example.com> more',
      '<a@b.com>',
      'a < b',
      'a < b > c',
      '<not-an-allowed-tag>',
      '<y>z</y>',
    ]) {
      expect(protectRawHtml(input)).toEqual({ text: input, html: [] });
    }
  });

  it('leaves conversation pseudo-tags and scripts literal', () => {
    const input = '<system-reminder>do x</system-reminder>\n<result>y</result>\n<script>alert(1)</script>';
    expect(protectRawHtml(input)).toEqual({ text: input, html: [] });
  });

  it('never captures HTML inside fenced code or inline code spans', () => {
    for (const input of [
      '```\n<div>x</div>\n```',
      '`<div>x</div>`',
      'before ```html\n<div>y</div>\n``` after',
    ]) {
      expect(protectRawHtml(input)).toEqual({ text: input, html: [] });
    }
  });

  it('balances nested same-name elements', () => {
    const input = '<div><div>a</div><b>b</b></div>';
    const { text, html } = protectRawHtml(input);
    expect(text).toBe(HTML(0));
    expect(html).toEqual([{ html: input, block: true }]);
  });

  it('captures only the opening tag when the close is missing', () => {
    const { text, html } = protectRawHtml('<div>abc');
    expect(text).toBe(`${HTML(0)}abc`);
    expect(html).toEqual([{ html: '<div>', block: true }]);
  });

  it('stops at a blank line instead of swallowing later markdown', () => {
    const { text, html } = protectRawHtml('<div>a\n\nb</div>');
    expect(html[0].html).toBe('<div>');
    // The closing tag after the blank line is its own (block) capture and the
    // middle text stays as literal markdown.
    expect(html).toContainEqual({ html: '</div>', block: true });
    expect(text).toContain('a');
    expect(text).toContain('b');
  });

  it('captures a whole opaque region only within one paragraph', () => {
    const input = '<div>\n**bold**\n</div>';
    const { text, html } = protectRawHtml(input);
    expect(text).toBe(HTML(0));
    expect(html).toEqual([{ html: input, block: true }]);
  });

  it('restores code placeholders that appear inside captured HTML', () => {
    const input = '<div>\n```\nx\n```\n</div>';
    const { text, html } = protectRawHtml(input);
    expect(text).toBe(HTML(0));
    expect(html[0].html).toBe(input);
  });

  it('captures nothing when the allowlist is empty', () => {
    const input = 'x <div>y</div> <script>z</script>';
    expect(protectRawHtml(input, { allowedTags: new Set() })).toEqual({
      text: input,
      html: [],
    });
  });
});
