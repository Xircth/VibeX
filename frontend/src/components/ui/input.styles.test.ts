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

      rule.walkDecls((declaration) => {
        expect(declaration.prop).not.toBe('padding');
        expect(declaration.prop).not.toBe('overflow');
      });
    });
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
