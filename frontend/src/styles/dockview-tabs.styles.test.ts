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
  it('uses the workspace topbar fill for the tab strip and panel body', () => {
    const theme = declarationsFor(
      '.dockview-theme-light.dockview-theme-ayu, .dockview-theme-ayu.dockview-theme-light, .dockview-theme-ayu'
    );
    const dark = declarationsFor(
      '.dark .dockview-theme-light.dockview-theme-ayu, .dark .dockview-theme-ayu.dockview-theme-light, .dark .dockview-theme-ayu'
    );

    expect(theme['--dv-theme-surface']?.value).toBe('var(--surface-topbar)');
    expect(theme['--dv-theme-bg']?.value).toBe('var(--surface-topbar)');
    expect(theme['--dv-connected-chrome']?.value).toBe('var(--surface-topbar)');
    expect(dark['--dv-theme-surface']?.value).toBe('var(--surface-topbar)');
    expect(dark['--dv-theme-bg']?.value).toBe('var(--surface-topbar)');
    expect(dark['--dv-connected-chrome']?.value).toBe('var(--surface-topbar)');
  });

  it('joins the selected tab to the panel body with side curves', () => {
    const strip = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-groupview > .dv-tabs-and-actions-container"
    );
    const tabs = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical)"
    );
    const active = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-active-tab .workspace-tab-surface"
    );
    const ears = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-active-tab .workspace-tab-surface::before, [class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-active-tab .workspace-tab-surface::after"
    );
    const leftEar = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-active-tab .workspace-tab-surface::before"
    );
    const rightEar = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-active-tab .workspace-tab-surface::after"
    );

    expect(strip['border-bottom']?.value).toBe('0');
    expect(tabs.padding?.value).toBe('4px 4px 0 2px');
    expect(active['border-radius']?.value).toBe(
      'var(--radius) var(--radius) 0 0'
    );
    expect(active['background-color']?.value).toBe(
      'var(--dv-connected-chrome)'
    );
    expect(ears.width?.value).toBe('var(--dv-tab-curve)');
    expect(leftEar.background?.value).toContain('radial-gradient');
    expect(leftEar.background?.value).toContain('circle at 0 0');
    expect(rightEar.background?.value).toContain('circle at 100% 0');
  });

  it('keeps inactive hover pills white and clear of the panel seam', () => {
    const strip = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-groupview > .dv-tabs-and-actions-container"
    );
    const idle = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-inactive-tab .workspace-tab-surface"
    );
    const hover = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab.dv-inactive-tab:hover .workspace-tab-surface"
    );
    const tab = declarationsFor(
      "[class*='dockview-theme-ayu'] .dv-tabs-container:not(.dv-vertical) > .dv-tab"
    );

    expect(strip['z-index']?.value).toBe('1');
    expect(idle.height?.value).toBe('24px');
    expect(idle.margin?.value).toBe('2px 0 0');
    expect(hover['background-color']?.value).toBe('var(--dv-connected-chrome)');
    expect(tab.padding?.value).toBe('0 var(--dv-tab-curve)');
  });

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
