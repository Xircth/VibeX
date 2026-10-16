import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(process.cwd(), 'src/styles/legacy/index.css');

function declarationsFor(
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const declarations: Record<string, { value: string; important: boolean }> =
    {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = {
        value: declaration.value,
        important: declaration.important,
      };
    });
  });
  return declarations;
}

describe('product option menus', () => {
  it('paints context menus and selector menus with the same opaque surface', () => {
    const context = declarationsFor('.product-context-menu');
    const selector = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']) > div"
    );
    const selected = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']) [role='option']:hover, .legacy-design [popover]:has([role='listbox']) [role='option']:focus, .legacy-design [popover]:has([role='listbox']) [role='option'][aria-selected='true']"
    );
    const option = declarationsFor(
      ".astryx-select-option:hover, .astryx-select-option[data-active='true'], .astryx-select-option[aria-selected='true']"
    );

    expect(context.background?.value).toBe('#ffffff');
    expect(context['box-shadow']?.value).toBe('none');
    expect(context['backdrop-filter']?.value).toBe('none');
    expect(selector.background?.value).toBe('#ffffff');
    expect(selector['box-shadow']?.value).toBe('none');
    expect(selector['backdrop-filter']?.value).toBe('none');
    expect(selected.background?.value).toBe('hsl(var(--accent))');
    expect(selected.color?.value).toBe('hsl(var(--accent-foreground))');
    expect(option.background?.value).toBe('hsl(var(--accent))');
    expect(declarationsFor('.branch-selector-menu').background).toBeUndefined();
  });

  it('restores the composer send button fill over ghost button resets', () => {
    const button = declarationsFor(
      '.legacy-design button.composer-primary-action.astryx-button'
    );

    expect(button['background-color']?.value).toBe('hsl(var(--foreground))');
    expect(button['background-color']?.important).toBe(true);
    expect(button.color?.value).toBe('hsl(var(--background))');
    expect(button['border-radius']?.value).toBe('999px');
    expect(button.width?.value).toBe('22.4px');
    expect(button.height?.value).toBe('22.4px');
  });
});
