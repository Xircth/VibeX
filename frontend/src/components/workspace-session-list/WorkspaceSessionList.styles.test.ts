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

describe('workspace session group layout', () => {
  it('wraps workspace chrome in the header hover and indents session rows', () => {
    const header = declarationsFor('.workspace-session-group-header');
    const rail = declarationsFor('.workspace-session-rail');
    const railLine = declarationsFor('.workspace-session-rail::before');

    expect(header.get('padding')).toBe('0.25rem 0.5rem');
    expect(header.get('overflow')).toBeUndefined();
    expect(rail.get('padding-left')).toBe('0.75rem');
    expect(rail.get('padding-right')).toBe('0.5rem');
    expect(railLine.size).toBe(0);
  });

  it('eases the search field width without an ambiguous Tailwind class', () => {
    const shell = declarationsFor('.workspace-session-search-shell');
    expect(shell.get('transition')).toBe(
      'width 200ms cubic-bezier(0.22, 1, 0.36, 1)'
    );
  });

  it('keeps the first workspace group tight against the header actions', () => {
    const listBody = declarationsFor('.session-hub-list-body');
    const inset = declarationsFor('.session-hub-inset');

    expect(listBody.get('padding')).toBe('0 0.75rem 0.75rem');
    expect(inset.get('min-height')).toBe('0');
  });
});

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
