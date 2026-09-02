import { describe, expect, it } from 'vitest';
import { sanitizeMermaidSvg } from './mermaidSvg';

describe('sanitizeMermaidSvg', () => {
  it('keeps flowchart HTML labels inside foreignObject', () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">
        <foreignObject width="80" height="24">
          <div xmlns="http://www.w3.org/1999/xhtml">节点 A</div>
        </foreignObject>
      </svg>
    `;

    const sanitized = sanitizeMermaidSvg(svg);

    expect(sanitized).toMatch(/<svg[\s>]/i);
    expect(sanitized).toMatch(/foreignobject/i);
    expect(sanitized).toContain('节点 A');
  });

  it('strips scripts and javascript URLs from mermaid SVG', () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <script>alert(1)</script>
        <a href="javascript:alert(1)">click</a>
        <text onclick="alert(1)">ok</text>
      </svg>
    `;

    const sanitized = sanitizeMermaidSvg(svg);

    expect(sanitized).toMatch(/<svg[\s>]/i);
    expect(sanitized).not.toMatch(/<script/i);
    expect(sanitized).not.toMatch(/javascript:/i);
    expect(sanitized).not.toMatch(/onclick/i);
    expect(sanitized).toContain('ok');
  });

  it('rejects non-svg markup', () => {
    expect(sanitizeMermaidSvg('<div>not a diagram</div>')).toBe('');
    expect(sanitizeMermaidSvg('')).toBe('');
  });
});
