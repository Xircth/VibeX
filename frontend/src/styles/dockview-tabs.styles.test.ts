import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(process.cwd(), 'src/styles/dockview-ayu.css');

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

describe('workspace tab strip chrome', () => {
  it('hides the native tab-strip scrollbar so overlay tracks cannot cover titles', () => {
    const rules = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-scrollable > .dv-tabs-container"
    );

    expect(rules['overflow-x']?.value).toBe('auto');
    expect(rules['scrollbar-width']?.value).toBe('none');
  });

  it('keeps Dockview overlay scrollbar as a thumb without a track', () => {
    const thumb = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-and-actions-container .dv-scrollbar"
    );
    const horizontal = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-and-actions-container .dv-scrollbar-horizontal"
    );

    expect(thumb['border-radius']?.value).toBe('999px');
    expect(horizontal.height?.value).toBe('3px');
  });

  it('rounds the overflow trigger and drops the list below it', () => {
    const trigger = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-overflow-dropdown-default"
    );
    const list = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-overflow-container"
    );

    expect(trigger['border-radius']?.value).toBe('var(--radius)');
    expect(list['border-radius']?.value).toBe('var(--radius)');
    expect(list['margin-top']?.value).toBe(
      'calc(var(--dv-tabs-and-actions-container-height, 36px) - 4px)'
    );
  });

  it('does not draw dividers between overflow tab rows', () => {
    const overflowTab = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-overflow-container .dv-tab:not(:last-child)"
    );

    expect(overflowTab['border-bottom']?.value).toMatch(/^none/);
  });
});
