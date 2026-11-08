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

describe('inverted hover tooltip and icon button chrome', () => {
  it('uses an inverted surface and element radius for hover tooltips', () => {
    const rules = declarationsFor('.app-hover-tooltip');
    const arrow = declarationsFor('.app-hover-tooltip-arrow');

    expect(rules['border-radius']?.value).toBe('var(--radius)');
    expect(rules.padding?.value).toBe('5px 10px');
    expect(rules.background?.value).toBe('hsl(var(--foreground))');
    expect(rules.border?.value).toBe('1px solid hsl(var(--foreground))');
    expect(rules.color?.value).toBe('hsl(var(--background))');
    expect(rules['box-shadow']?.value).toBe('var(--shadow-popover)');
    expect(rules['backdrop-filter']?.value).toBe('none');
    expect(rules['font-family']?.value).toBe('var(--font-ui)');
    expect(arrow.fill?.value).toBe('hsl(var(--foreground))');
  });

  it('restyles Astryx tooltips to the same inverted chrome', () => {
    const rules = declarationsFor('.astryx-tooltip');

    expect(rules['--radius-container']?.value).toBe('var(--radius)');
    expect(rules['border-radius']?.value).toBe('var(--radius)');
    expect(rules['border-radius']?.important).toBe(true);
    expect(rules.background?.value).toBe('hsl(var(--foreground))');
    expect(rules.background?.important).toBe(true);
    expect(rules.border?.value).toBe('1px solid hsl(var(--foreground))');
    expect(rules.color?.value).toBe('hsl(var(--background))');
    expect(rules.color?.important).toBe(true);
    expect(rules['box-shadow']?.value).toBe('var(--shadow-popover)');
    expect(rules['backdrop-filter']?.value).toBe('none');
    expect(rules['backdrop-filter']?.important).toBe(true);
  });

  it('defaults the shared Radix tooltip to bottom placement with an arrow', () => {
    expect(TOOLTIP_SOURCE).toContain('app-hover-tooltip');
    expect(TOOLTIP_SOURCE).toContain("side = 'bottom'");
    expect(TOOLTIP_SOURCE).toContain('app-hover-tooltip-arrow');
    expect(TOOLTIP_SOURCE).toContain('data-app-owned-tooltip');
    expect(TOOLTIP_SOURCE).not.toContain('rounded-md');
  });

  it('keeps icon buttons background-free on hover and shows a right indicator line on active rail icons', () => {
    const toolbarHover = declarationsFor('.workspace-toolbar-button:hover');
    const railBase = declarationsFor('.workspace-side-rail-button');
    const railHover = declarationsFor('.workspace-side-rail-button:hover');
    const railActive = declarationsFor('.workspace-side-rail-button.is-active');
    const railIndicator = declarationsFor(
      '.workspace-side-rail-button.is-active::after'
    );

    expect(toolbarHover.background?.value).toBe('transparent');
    expect(toolbarHover.color?.value).toBe('var(--text-strong)');
    expect(railBase.color?.value).toBe('hsl(var(--muted-foreground))');
    expect(railHover.background?.value).toBe('transparent');
    expect(railHover.color?.value).toBe('hsl(var(--foreground))');
    expect(railActive.background?.value).toBe('transparent');
    expect(railActive.color?.value).toBe('hsl(var(--foreground))');
    expect(railIndicator.width?.value).toBe('2px');
    expect(railIndicator.background?.value).toBe('hsl(var(--foreground))');
  });
});
