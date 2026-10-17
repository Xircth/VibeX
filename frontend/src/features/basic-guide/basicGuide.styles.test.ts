import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/features/basic-guide/basicGuide.css'
);

function declarationsFor(
  selector: string,
  { inAtRule }: { inAtRule?: string } = {}
): Record<string, string> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const declarations: Record<string, string> = {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    const parent = rule.parent;
    const atName = parent && parent.type === 'atrule' ? parent.name : undefined;
    const atParams =
      parent && parent.type === 'atrule' ? parent.params : undefined;
    if (inAtRule) {
      if (atName !== 'media' || !atParams?.includes(inAtRule)) return;
    } else if (atName) {
      return;
    }
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  return declarations;
}

describe('basic guide panel chrome', () => {
  it('sits 48px from the left with an opaque gray glass frame', () => {
    const panel = declarationsFor('.basic-guide-panel');
    const bottom = declarationsFor('.basic-guide-panel--bottom');
    const frame = declarationsFor('.basic-guide-panel__stack--framed');
    expect(panel.left).toBe('48px');
    expect(bottom.bottom).toBe('30px');
    expect(frame.background).toBe('hsl(220 10% 86% / 0.94)');
    expect(frame['backdrop-filter']).toBe('blur(20px) saturate(1.2)');
    expect(frame['-webkit-backdrop-filter']).toBe('blur(20px) saturate(1.2)');
    expect(frame.border).toBe('1px solid #111');
    expect(frame['border-radius']).toBe('8px');
    expect(declarationsFor('.basic-guide-panel--workspace')).toEqual({});
  });

  it('drops the glass blur when transparency is reduced', () => {
    const frame = declarationsFor('.basic-guide-panel__stack--framed', {
      inAtRule: 'prefers-reduced-transparency',
    });
    expect(frame.background).toBe('hsl(220 10% 86%)');
    expect(frame['backdrop-filter']).toBe('none');
    expect(frame['-webkit-backdrop-filter']).toBe('none');
  });

  it('styles the callout continue as a black action', () => {
    const button = declarationsFor('.basic-guide-callout__continue');
    expect(button.background).toBe('#111');
    expect(button.color).toBe('#fff');
    expect(button['pointer-events']).toBe('auto');
    expect(button.height).toBe('28px');
  });
});
