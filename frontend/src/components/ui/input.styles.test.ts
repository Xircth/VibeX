import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

function declarationsForAstryxNestedFields() {
  const declarations = new Map<string, string>();

  parse(stylesheet).walkRules((rule) => {
    const selector = rule.selector.replace(/\s+/g, ' ');
    if (
      !selector.includes('.astryx-text-input') ||
      !selector.includes('textarea')
    ) {
      return;
    }

    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });

  return declarations;
}

describe('text control caret clearance', () => {
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

  it('resets nested Astryx editors so wrapper padding is the only inset', () => {
    const nested = declarationsForAstryxNestedFields();

    expect(nested.get('border-radius')).toBe('0');
    expect(nested.get('padding-inline')).toBe('0');
    expect(nested.get('text-indent')).toBe('0');
  });
});
