import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

function stylesheetRoot() {
  return parse(
    readFileSync(resolve(process.cwd(), 'src/styles/legacy/index.css'), 'utf8')
  );
}

function restDeclarations(selector: string) {
  const declarations = new Map<string, string>();
  stylesheetRoot().walkRules((rule) => {
    if (rule.selector.trim() !== selector) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

describe('kanban page nav arrows', () => {
  it('keeps a bare icon with no pill or semicircle chrome', () => {
    const arrow = restDeclarations('.kanban-nav-arrow');

    expect(arrow.get('background')).toBe('transparent');
    expect(arrow.get('border')).toBe('none');
    expect(arrow.get('box-shadow')).toBe('none');
    expect(arrow.get('width')).toBe('auto');
    expect(arrow.get('padding')).toBe('0.125rem 0');
    expect(arrow.get('opacity')).toBe('0');
    expect(arrow.get('pointer-events')).toBe('none');
    expect(arrow.has('border-radius')).toBe(false);
  });

  it('reveals on page hover, not on a board-shell hover island', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );

    expect(css).toContain("[data-panel='kanban']:hover .kanban-nav-arrow");
    expect(css).not.toContain('.kanban-shell:hover .kanban-nav-arrow');
    expect(css).toContain('kanban-nav-arrow-breathe');
  });
});
