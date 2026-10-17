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

  it('restores the Astryx track fill and element radius on the control', () => {
    const decls: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      if (selectorOf(rule) !== '.legacy-design .astryx-segmented-control') {
        return;
      }
      rule.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
    });

    expect(decls['--color-neutral']?.replace(/\s+/g, '')).toBe(
      'light-dark(rgba(5,54,89,0.1),rgba(223,226,229,0.2))'
    );
    expect(decls['--radius-element']).toBe('8px');
    expect(decls['--_segmented-control-radius']).toBe('8px');
    expect(decls['--color-neutral']).not.toContain('surface-raised-control');
  });

  it('strips native button appearance from SegmentedControl items', () => {
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
  });
});
