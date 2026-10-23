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

  it('paints the gray capsule track and pill radius', () => {
    const decls: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      if (selectorOf(rule) !== '.legacy-design .astryx-segmented-control') {
        return;
      }
      rule.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
    });

    expect(decls['background-color']?.replace(/\s+/g, '')).toBe(
      'light-dark(#e5e5e5,#262626)'
    );
    expect(decls['border-radius']).toBe('999px');
    expect(decls['--_segmented-control-radius']).toBe('999px');
    expect(decls['--color-neutral']).not.toContain('surface-raised-control');
  });

  it('widens items and keeps unselected segments transparent', () => {
    const decls: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      if (
        selectorOf(rule) !== '.legacy-design .astryx-segmented-control-item'
      ) {
        return;
      }
      rule.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
    });

    expect(decls.appearance).toBe('none');
    expect(decls['-webkit-appearance']).toBe('none');
    expect(decls['background-color']).toBe('transparent');
    expect(decls.height).toBe('20px');
    expect(decls['padding-inline']).toBe('12px');
  });

  it('paints the selected segment white', () => {
    const decls: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      if (
        selectorOf(rule) !==
        ".legacy-design .astryx-segmented-control-item[aria-checked='true']"
      ) {
        return;
      }
      rule.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
    });

    expect(decls['background-color']?.replace(/\s+/g, '')).toBe(
      'light-dark(#ffffff,#404040)'
    );
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
    expect(tabTrack['background-color']?.replace(/\s+/g, '')).toBe(
      'light-dark(#e5e5e5,#262626)'
    );
    expect(tabButton['border-radius']).toBe('999px');
    expect(tabButton.height).toBe('26px');
    expect(tabButton.padding).toBe('0 14px');
    expect(tabButton['font-size']).toBe('0.75rem');
    expect(tabIcon.width).toBe('13px');
    expect(tabIcon.height).toBe('13px');
    expect(submodeTrack['border-radius']).toBe('999px');
    expect(submodeTrack.padding).toBe('3px');
    expect(submodeTrack['background-color']?.replace(/\s+/g, '')).toBe(
      'light-dark(#e5e5e5,#262626)'
    );
    expect(submodeButton['border-radius']).toBe('999px');
    expect(submodeButton.height).toBe('26px');
    expect(submodeButton.padding).toBe('0 14px');
    expect(submodeButton['font-size']).toBe('0.75rem');
  });
});
