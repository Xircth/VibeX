import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Node, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

function selectorOf(rule: Rule): string {
  return rule.selector.replace(/\s+/g, ' ');
}

function ruleInLayer(rule: Rule): boolean {
  let node: Node | undefined = rule.parent;
  while (node && node.type !== 'root') {
    if (node.type === 'atrule' && 'name' in node && node.name === 'layer') {
      return true;
    }
    node = node.parent;
  }
  return false;
}

function isAstryxInnerField(selector: string): boolean {
  return (
    selector.includes('.astryx-text-input') &&
    selector.includes('input') &&
    !selector.includes('.settings-page')
  );
}

describe('text control caret clearance', () => {
  it('lets Astryx TextInput own its frame instead of restyling the wrapper', () => {
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!selector.includes('.astryx-text-input')) return;
      if (selector.includes('input') || selector.includes('textarea')) return;
      if (selector.includes('[data-pressable-container]')) {
        const padding = rule.nodes?.find(
          (node) => node.type === 'decl' && node.prop === 'padding-inline'
        );
        expect(padding && 'value' in padding ? padding.value : '').toBe('10px');
        return;
      }

      rule.walkDecls((declaration) => {
        expect(declaration.prop).not.toBe('padding');
        expect(declaration.prop).not.toBe('overflow');
      });
    });
  });

  it('strips the platform text-field appearance so Astryx chrome shows through', () => {
    const inner: Record<string, string> = {};
    const important = new Set<string>();
    let unlayeredAppearance = false;
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!isAstryxInnerField(selector)) return;
      if (selector.includes('.dark')) return;
      rule.walkDecls((declaration) => {
        inner[declaration.prop] = declaration.value;
        if (declaration.important) important.add(declaration.prop);
        if (
          !ruleInLayer(rule) &&
          (declaration.prop === 'appearance' ||
            declaration.prop === '-webkit-appearance') &&
          declaration.value === 'none'
        ) {
          unlayeredAppearance = true;
        }
      });
    });

    expect(inner.appearance).toBe('none');
    expect(inner['-webkit-appearance']).toBe('none');
    expect(inner.background).toBe('transparent');
    expect(inner['color-scheme']).toBe('light');
    expect(important.has('appearance')).toBe(true);
    expect(important.has('-webkit-appearance')).toBe(true);
    expect(unlayeredAppearance).toBe(true);
  });

  it('gives the light design scope a definite color-scheme so WebView2 does not paint Win11 fields', () => {
    const schemes: string[] = [];
    let htmlScheme: string | undefined;
    let htmlInLayer = true;
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (selector === '.legacy-design') {
        rule.walkDecls((declaration) => {
          if (declaration.prop === 'color-scheme') {
            schemes.push(declaration.value);
          }
        });
      }
      if (selector === 'html') {
        rule.walkDecls((declaration) => {
          if (declaration.prop === 'color-scheme') {
            htmlScheme = declaration.value;
            htmlInLayer = ruleInLayer(rule);
          }
        });
      }
    });

    expect(schemes.length).toBeGreaterThan(0);
    expect(schemes.at(-1)).toBe('light');
    expect(htmlScheme).toBe('light');
    expect(htmlInLayer).toBe(false);
  });

  it('flips Astryx inner fields to the dark color-scheme with the app theme', () => {
    const darkSchemes: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!isAstryxInnerField(selector) || !selector.includes('.dark')) return;
      rule.walkDecls((declaration) => {
        if (declaration.prop === 'color-scheme') {
          darkSchemes.push(declaration.value);
        }
      });
    });

    expect(darkSchemes.at(-1)).toBe('dark');
  });

  it('gives settings text fields a shared inset and compact type', () => {
    const shared: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (
        !selector.includes('.settings-page') ||
        !selector.includes('input:not') ||
        selector.includes(
          '.legacy-design .settings-page :is(.astryx-text-input'
        )
      ) {
        return;
      }
      const declarations: Record<string, string> = {};
      rule.walkDecls((declaration) => {
        declarations[declaration.prop] = declaration.value;
      });
      if (declarations['padding-inline'] && declarations['font-size']) {
        Object.assign(shared, declarations);
      }
    });

    expect(shared['padding-inline']).toBe('10px');
    expect(shared['font-size']).toBe('0.75rem');
  });

  it('does not globally indent every native text control', () => {
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (
        !selector.includes(':where(.legacy-design) input') ||
        selector.includes('select')
      ) {
        return;
      }

      rule.walkDecls((declaration) => {
        expect(declaration.prop).not.toBe('text-indent');
        expect(declaration.prop).not.toBe('padding-inline');
      });
    });
  });
});
