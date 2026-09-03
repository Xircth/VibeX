import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

function stylesheetRoot() {
  return parse(
    readFileSync(resolve(process.cwd(), 'src/styles/legacy/index.css'), 'utf8')
  );
}

function toastShellWrapperRule() {
  const matches: Array<{
    selector: string;
    decls: Map<string, { value: string; important: boolean }>;
  }> = [];
  stylesheetRoot().walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && rule.parent.name !== 'layer') {
      return;
    }
    const parts = rule.selector.split(',').map((part) => part.trim());
    if (!parts.includes('html.desktop-toast-shell')) {
      return;
    }
    const decls = new Map<string, { value: string; important: boolean }>();
    rule.walkDecls((declaration) => {
      decls.set(declaration.prop, {
        value: declaration.value,
        important: declaration.important,
      });
    });
    matches.push({ selector: rule.selector, decls });
  });
  return matches.find(
    (rule) => rule.decls.get('background')?.value === 'transparent'
  );
}

describe('desktop toast window surface', () => {
  it('keeps the design-scope wrappers transparent so unused window space is not painted', () => {
    const rule = toastShellWrapperRule();

    expect(rule).toBeDefined();
    const parts = rule!.selector.split(',').map((part) => part.trim());
    expect(parts).toEqual(
      expect.arrayContaining([
        'html.desktop-toast-shell',
        'html.desktop-toast-shell body',
        'html.desktop-toast-shell #root',
        'html.desktop-toast-shell .legacy-design',
        'html.desktop-toast-shell .legacy-design-shell',
      ])
    );
    expect(rule!.decls.get('background')).toEqual({
      value: 'transparent',
      important: true,
    });
  });
});
