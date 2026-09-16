import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

function stylesheetRoot() {
  return parse(
    readFileSync(resolve(process.cwd(), 'src/styles/legacy/index.css'), 'utf8')
  );
}

function declarationsFor(selector: string) {
  const declarations = new Map<string, string>();
  stylesheetRoot().walkRules((rule) => {
    if (rule.selector.split(',').some((part) => part.trim() === selector)) {
      rule.walkDecls((declaration) => {
        declarations.set(declaration.prop, declaration.value);
      });
    }
  });
  return declarations;
}

describe('Pi reasoning fields styles', () => {
  it('keeps the declare-reasoning checkbox on the left of its label', () => {
    const enable = declarationsFor('.settings-page .pi-reasoning-enable');
    expect(enable.get('display')).toBe('flex');
    expect(enable.get('flex-direction')).toBe('row');
    expect(enable.get('justify-content')).toBe('flex-start');
  });

  it('spaces provider effort rows instead of stacking them flush', () => {
    const values = declarationsFor('.settings-page .pi-wire-values');
    expect(values.get('gap')).toBe('8px');
    const row = declarationsFor('.settings-page .pi-wire-row');
    expect(row.get('display')).toBe('grid');
    expect(row.get('grid-template-columns')).toBe(
      'minmax(7.5rem, auto) minmax(0, 1fr)'
    );
  });
});
