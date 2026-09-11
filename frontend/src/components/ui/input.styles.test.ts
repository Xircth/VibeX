import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

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
});
