import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

function declarationsFor(selector: string) {
  const stylesheet = readFileSync(
    resolve(process.cwd(), 'src/styles/legacy/index.css'),
    'utf8'
  );
  const declarations = new Map<string, string>();
  parse(stylesheet).walkRules((rule) => {
    if (
      rule.selector !== selector ||
      (rule.parent?.type === 'atrule' && rule.parent.name !== 'layer')
    ) {
      return;
    }
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

describe('workspace session row surface', () => {
  it('keeps a 1px hairline at rest so rows stay distinct from the list', () => {
    const row = declarationsFor('.workspace-session-row');

    expect(row.get('border')).toBe('1px solid var(--border-subtle)');
    expect(row.get('box-sizing')).toBe('border-box');
  });

  it('does not change border width on hover or selection', () => {
    const hovered = declarationsFor(
      '.workspace-session-row.is-hovered,\n  .workspace-session-row:hover,\n  .workspace-session-row:focus-within'
    );
    const selected = declarationsFor('.workspace-session-row.is-selected');

    expect(hovered.get('border')).toBeUndefined();
    expect(hovered.get('border-width')).toBeUndefined();
    expect(hovered.get('border-color')).toBeUndefined();
    expect(selected.get('border')).toBeUndefined();
    expect(selected.get('border-width')).toBeUndefined();
    expect(selected.get('border-color')).toBeUndefined();
  });
});
