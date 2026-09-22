import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

describe('text control caret clearance', () => {
  it('lets Astryx TextInput own its frame instead of restyling the wrapper', () => {
    parse(stylesheet).walkRules((rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ');
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

  it('gives settings text fields a shared inset and compact type', () => {
    const shared: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ');
      if (
        !selector.includes('.settings-page') ||
        !selector.includes('input:not') ||
        selector.includes('.legacy-design .settings-page :is(.astryx-text-input')
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
      const selector = rule.selector.replace(/\s+/g, ' ');
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
