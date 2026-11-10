import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

function stylesheetRoot() {
  return parse(
    readFileSync(resolve(process.cwd(), 'src/styles/legacy/index.css'), 'utf8')
  );
}

type Rule = {
  selector: string;
  decls: Map<string, { value: string; important: boolean }>;
};

function collectRules() {
  const matches: Rule[] = [];
  stylesheetRoot().walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && rule.parent.name !== 'layer') {
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
  return matches;
}

function toastShellWrapperRule() {
  return collectRules().find((rule) => {
    const parts = rule.selector.split(',').map((part) => part.trim());
    return (
      parts.includes('html.desktop-toast-shell') &&
      rule.decls.get('background')?.value === 'transparent'
    );
  });
}

function toastShellRulesFor(selectorPart: string) {
  return collectRules().filter((rule) =>
    rule.selector
      .split(',')
      .map((part) => part.trim())
      .includes(selectorPart)
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

  it('paints notification cards on an opaque surface instead of translucent glass', () => {
    for (const scheme of ['.legacy-design', '.legacy-design.dark']) {
      const tokens = collectRules().find(
        (rule) =>
          rule.selector.split(',')[0].trim() === scheme &&
          rule.decls.has('--surface-dialog')
      );
      expect(tokens?.decls.get('--surface-dialog')?.value).toBe(
        'var(--surface-popover)'
      );
      expect(tokens?.decls.get('--surface-popover')?.value).toMatch(
        /^#[\da-f]{6}$/i
      );
    }
    expect(
      toastShellRulesFor('html.desktop-toast-shell .legacy-design').some(
        (rule) => rule.decls.has('--surface-popover')
      )
    ).toBe(false);

    const surfaceRule = toastShellRulesFor(
      'html.desktop-toast-shell .legacy-design .vu-toast-surface'
    ).find((rule) => rule.decls.get('backdrop-filter')?.value === 'none');

    expect(surfaceRule).toBeDefined();
    expect(surfaceRule!.decls.get('backdrop-filter')).toEqual({
      value: 'none',
      important: true,
    });
    expect(surfaceRule!.decls.get('-webkit-backdrop-filter')).toEqual({
      value: 'none',
      important: true,
    });
  });
});
