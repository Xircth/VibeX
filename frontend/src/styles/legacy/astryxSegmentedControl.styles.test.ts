import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

function selectorOf(rule: Rule): string {
  return rule.selector.replace(/\s+/g, ' ');
}

describe('Astryx SegmentedControl chrome', () => {
  it('keeps Tahoe button radius off SegmentedControl items', () => {
    const radiusSelectors: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      let hasRadius = false;
      rule.walkDecls('border-radius', (declaration) => {
        if (declaration.value === 'var(--radius)') hasRadius = true;
      });
      if (!hasRadius) return;
      const selector = selectorOf(rule);
      if (selector.includes('button')) radiusSelectors.push(selector);
    });

    expect(radiusSelectors.length).toBeGreaterThan(0);
    for (const selector of radiusSelectors) {
      if (!selector.includes(':where(.legacy-design) button')) continue;
      expect(selector).toContain('button:not(.astryx-segmented-control-item)');
    }
  });

  it('restores official Astryx track, concentric radius, padding, typography, and flat selected surface above unlayered Tailwind preflight', () => {
    const controlDecls: Record<string, string> = {};
    const itemDecls: Record<string, string> = {};
    const smItemDecls: Record<string, string> = {};
    const selectedDecls: Record<string, string> = {};
    const hoverDecls: Record<string, string> = {};

    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (
        selector ===
          '.legacy-design .astryx-segmented-control:not(.agent-auth-mode-tabs):not( .agent-auth-mode-submodes )' ||
        selector ===
          '.legacy-design .astryx-segmented-control:not(.agent-auth-mode-tabs):not(.agent-auth-mode-submodes)'
      ) {
        rule.walkDecls((declaration) => {
          controlDecls[declaration.prop] = declaration.value;
        });
      } else if (
        selector.endsWith(') .astryx-segmented-control-item') &&
        selector.includes(':not(.agent-auth-mode-tabs)') &&
        !selector.includes('[data-layout')
      ) {
        rule.walkDecls((declaration) => {
          itemDecls[declaration.prop] = declaration.value;
        });
      } else if (
        selector.endsWith(".astryx-segmented-control-item[data-size='sm']")
      ) {
        rule.walkDecls((declaration) => {
          smItemDecls[declaration.prop] = declaration.value;
        });
      } else if (
        selector.includes("[aria-checked='true']") &&
        selector.includes("[data-selected='selected']")
      ) {
        rule.walkDecls((declaration) => {
          selectedDecls[declaration.prop] = declaration.value;
        });
      } else if (
        selector.includes(
          ".astryx-segmented-control-item:hover:not([aria-checked='true'])"
        )
      ) {
        rule.walkDecls((declaration) => {
          hoverDecls[declaration.prop] = declaration.value;
        });
      }
    });

    expect(controlDecls['--color-neutral']).toBe('var(--surface-track)');
    expect(controlDecls['--color-background-surface']).toBe(
      'var(--surface-thumb)'
    );
    expect(controlDecls['border-radius']).toBe(
      'var(--_segmented-control-radius)'
    );
    expect(controlDecls['border-radius']).not.toBe('999px');

    expect(itemDecls.appearance).toBe('none');
    expect(itemDecls['-webkit-appearance']).toBe('none');
    expect(itemDecls['padding-inline']).toBe('var(--spacing-3, 12px)');
    expect(itemDecls['font-size']).toBe('var(--text-label-size, 0.875rem)');
    expect(itemDecls['font-weight']).toBe('var(--font-weight-medium, 500)');
    expect(itemDecls.color).toBe(
      'var(--color-text-secondary, var(--text-muted))'
    );
    expect(itemDecls['border-radius']).toContain(
      '--_segmented-control-radius'
    );
    expect(itemDecls['box-shadow']).toBe('none');

    expect(smItemDecls.height).toBe('calc(var(--size-element-sm, 28px) - 6px)');
    expect(smItemDecls['padding-inline']).toBe('10px');
    expect(smItemDecls['font-size']).toBe(
      'var(--text-supporting-size, 0.75rem)'
    );

    expect(hoverDecls['background-color']).toBe(
      'var(--color-overlay-hover, var(--surface-control))'
    );

    expect(selectedDecls['background-color']).toBe(
      'var(--color-background-surface, var(--surface-thumb))'
    );
    expect(selectedDecls.color).toBe(
      'var(--color-text-primary, var(--text-strong))'
    );
    expect(selectedDecls['font-weight']).toBe(
      'var(--font-weight-semibold, 600)'
    );
    expect(selectedDecls['box-shadow']).toBe('none');
  });

  it('excludes SegmentedControl radiogroup and radio items from window-chrome drag regions', () => {
    const dragExclusionSelectors: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      let isNoDrag = false;
      rule.walkDecls('app-region', (declaration) => {
        if (declaration.value === 'no-drag') isNoDrag = true;
      });
      if (isNoDrag) {
        dragExclusionSelectors.push(selectorOf(rule));
      }
    });

    const combined = dragExclusionSelectors.join(' ');
    expect(combined).toContain(".window-chrome [role='radiogroup']");
    expect(combined).toContain(".window-chrome [role='radio']");
  });

  it('styles Agent auth mode tabs and submodes as capsule segmented controls', () => {
    const tabTrack: Record<string, string> = {};
    const tabButton: Record<string, string> = {};
    const tabIcon: Record<string, string> = {};
    const submodeTrack: Record<string, string> = {};
    const submodeButton: Record<string, string> = {};

    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (selector === '.settings-page .agent-auth-mode-tabs') {
        rule.walkDecls((declaration) => {
          tabTrack[declaration.prop] = declaration.value;
        });
      } else if (selector === '.settings-page .agent-auth-mode-tabs > button') {
        rule.walkDecls((declaration) => {
          tabButton[declaration.prop] = declaration.value;
        });
      } else if (selector === '.settings-page .agent-auth-mode-tab-icon') {
        rule.walkDecls((declaration) => {
          tabIcon[declaration.prop] = declaration.value;
        });
      } else if (selector === '.settings-page .agent-auth-mode-submodes') {
        rule.walkDecls((declaration) => {
          submodeTrack[declaration.prop] = declaration.value;
        });
      } else if (selector === '.settings-page .agent-auth-mode-submode') {
        rule.walkDecls((declaration) => {
          submodeButton[declaration.prop] = declaration.value;
        });
      }
    });

    expect(tabTrack['border-radius']).toBe('999px');
    expect(tabTrack.padding).toBe('3px');
    expect(tabTrack['background-color']).toBe('var(--surface-track)');
    expect(tabButton['border-radius']).toBe('999px');
    expect(tabButton.height).toBe('26px');
    expect(tabButton.padding).toBe('0 14px');
    expect(tabButton['font-size']).toBe('0.75rem');
    expect(tabIcon.width).toBe('13px');
    expect(tabIcon.height).toBe('13px');
    expect(submodeTrack['border-radius']).toBe('999px');
    expect(submodeTrack.padding).toBe('3px');
    expect(submodeTrack['background-color']).toBe('var(--surface-track)');
    expect(submodeButton['border-radius']).toBe('999px');
    expect(submodeButton.height).toBe('26px');
    expect(submodeButton.padding).toBe('0 14px');
    expect(submodeButton['font-size']).toBe('0.75rem');
  });
});
