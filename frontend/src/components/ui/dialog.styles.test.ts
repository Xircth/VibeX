import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

function declarationsFor(selector: string) {
  const declarations = new Map<string, string>();

  parse(stylesheet).walkRules((rule) => {
    if (!rule.selectors?.includes(selector)) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });

  return declarations;
}

describe('global modal surfaces', () => {
  it('uses the requested opaque light background for every dialog system', () => {
    const lightTheme = declarationsFor('.legacy-design');
    const sharedDialog = declarationsFor('.dialog-surface');
    const customDialog = declarationsFor('.modal-surface');
    const nativeDialog = declarationsFor(
      ".legacy-design dialog[aria-modal='true']"
    );

    expect(lightTheme.get('--surface-dialog')).toBe('#fafafa');
    expect(sharedDialog.get('background')).toBe('var(--surface-dialog)');
    expect(sharedDialog.get('backdrop-filter')).toBe('none');
    expect(customDialog.get('background')).toBe('var(--surface-dialog)');
    expect(customDialog.get('backdrop-filter')).toBe('none');
    expect(nativeDialog.get('--color-background-surface')).toBe(
      'var(--surface-dialog)'
    );
  });

  it('keeps custom modal implementations on the shared surface contract', () => {
    const customModalFiles = [
      'src/App.tsx',
      'src/components/search/SearchPalette.tsx',
      'src/components/panels/git/GitDiscardDialog.tsx',
      'src/components/panels/git/GitDiffModal.tsx',
    ];

    for (const file of customModalFiles) {
      expect(readFileSync(resolve(process.cwd(), file), 'utf8')).toContain(
        'modal-surface'
      );
    }
  });
});
