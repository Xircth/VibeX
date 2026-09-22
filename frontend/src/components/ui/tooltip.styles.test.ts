import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(process.cwd(), 'src/styles/legacy/index.css');
const TOOLTIP_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/components/ui/tooltip.tsx'),
  'utf8'
);

function declarationsFor(
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const declarations: Record<string, { value: string; important: boolean }> =
    {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = {
        value: declaration.value,
        important: declaration.important,
      };
    });
  });
  return declarations;
}

describe('capsule hover tooltip', () => {
  it('uses a capsule radius and product surface tokens', () => {
    const rules = declarationsFor('.app-hover-tooltip');

    expect(rules['border-radius']?.value).toBe('999px');
    expect(rules.padding?.value).toBe('5px 12px');
    expect(rules.background?.value).toBe('var(--surface-popover)');
    expect(rules.color?.value).toBe('var(--text-strong)');
    expect(rules['box-shadow']?.value).toBe('var(--shadow-popover)');
    expect(rules['font-family']?.value).toBe('var(--font-ui)');
  });

  it('restyles Astryx inverted tooltips to the same capsule chrome', () => {
    const rules = declarationsFor('.astryx-tooltip');

    expect(rules['--radius-container']?.value).toBe('999px');
    expect(rules['border-radius']?.value).toBe('999px');
    expect(rules['border-radius']?.important).toBe(true);
    expect(rules.background?.value).toBe('var(--surface-popover)');
    expect(rules.background?.important).toBe(true);
    expect(rules.color?.value).toBe('var(--text-strong)');
    expect(rules.color?.important).toBe(true);
    expect(rules['box-shadow']?.value).toBe('var(--shadow-popover)');
  });

  it('applies the capsule class to the shared Radix tooltip', () => {
    expect(TOOLTIP_SOURCE).toContain('app-hover-tooltip');
    expect(TOOLTIP_SOURCE).not.toContain('rounded-md');
  });
});
