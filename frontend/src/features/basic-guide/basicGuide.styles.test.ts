import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/features/basic-guide/basicGuide.css'
);

function declarationsFor(selector: string): Record<string, string> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const declarations: Record<string, string> = {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  return declarations;
}

describe('basic guide panel chrome', () => {
  it('sits above the status bar and frames skip with the steps', () => {
    const panel = declarationsFor('.basic-guide-panel--bottom');
    const frame = declarationsFor('.basic-guide-panel__stack--framed');
    expect(panel.bottom).toBe('64px');
    expect(frame.background).toBe('#fff');
    expect(frame.border).toBe('1px solid #111');
    expect(frame['border-radius']).toBe('8px');
  });
});
