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
});
