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
    if (rule.selector !== selector || rule.parent?.type === 'atrule') return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

describe('PluginsSettings layout', () => {
  it('outlines the combined catalog and preview surface', () => {
    const frame = declarationsFor('.settings-page .plugin-hub-frame');

    expect(frame.get('border')).toBe('1px solid var(--border-strong)');
  });

  it('lets the combined surface use the available viewport height', () => {
    const frame = declarationsFor('.settings-page .plugin-hub-frame');
    const grid = declarationsFor('.settings-page .plugin-hub-grid');

    expect(frame.get('height')).toBe('max(520px, calc(100dvh - 112px))');
    expect(grid.get('height')).toBe('100%');
  });

  it('keeps the embedded Agent plugin catalog close to the search field', () => {
    const shell = declarationsFor(
      '.settings-page .plugin-hub-shell.is-embedded'
    );
    const frame = declarationsFor(
      '.settings-page .plugin-hub-shell.is-embedded .plugin-hub-frame'
    );

    expect(shell.get('min-height')).toBe('0');
    expect(shell.get('gap')).toBe('8px');
    expect(frame.get('height')).toBe('min(240px, 32dvh)');
    expect(frame.get('min-height')).toBe('160px');
  });

  it('paints one divider while keeping a wider drag target', () => {
    const grid = declarationsFor('.settings-page .plugin-hub-grid');
    const resizer = declarationsFor('.settings-page .plugin-hub-resizer');

    expect(grid.get('grid-template-columns')).toMatch(/\)\s+1px\s+minmax/);
    expect(resizer.get('width')).toBe('9px');
    expect(resizer.get('margin-inline')).toBe('-4px');
  });

  it('lets the preview scroll without compressing its capability rail', () => {
    const detailChildren = declarationsFor(
      '.settings-page .plugin-hub-detail > *'
    );

    expect(detailChildren.get('flex-shrink')).toBe('0');
  });
});
