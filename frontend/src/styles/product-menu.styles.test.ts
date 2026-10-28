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
    const hovered = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']:not(.astryx-trigger-menu)) [role='option']:hover, .legacy-design [popover]:has([role='listbox']:not(.astryx-trigger-menu)) [role='option']:focus-visible"
    );
    const selected = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']:not(.astryx-trigger-menu)) [role='option'][aria-selected='true']"
    );
    const option = declarationsFor(
      ".astryx-select-option:hover, .astryx-select-option[data-active='true']"
    );
    const optionSelected = declarationsFor(
      ".astryx-select-option[aria-selected='true']"
    );

    expect(context.background?.value).toBe('#ffffff');
    expect(context['box-shadow']?.value).toBe('none');
    expect(context['backdrop-filter']?.value).toBe('none');
    expect(selector.background?.value).toBe('#ffffff');
    expect(selector['box-shadow']?.value).toBe('none');
    expect(selector['backdrop-filter']?.value).toBe('none');
    expect(hovered.background?.value).toBe('hsl(var(--accent))');
    expect(hovered.color?.value).toBe('hsl(var(--accent-foreground))');
    expect(selected.background?.value).toBe('transparent');
    expect(selected['font-weight']?.value).toBe('500');
    expect(option.background?.value).toBe('hsl(var(--accent))');
    expect(optionSelected.background?.value).toBe('transparent');
    expect(declarationsFor('.branch-selector-menu').background).toBeUndefined();
  });

  it('lets the inner listbox own the trigger-menu frame so the popover stays invisible', () => {
    const popover = declarationsFor(
      ".legacy-design [popover]:has([role='listbox'])"
    );
    const inner = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']) > div"
    );
    const composerPopover = declarationsFor(
      '.legacy-design .session-composer-editor [popover]:has(.astryx-trigger-menu)'
    );

    expect(popover.background?.value).toBe('transparent');
    expect(popover.border?.value).toBe('none');
    expect(popover.padding?.value).toBe('0');
    expect(popover.overflow?.value).toBe('visible');
    expect(popover['box-shadow']?.value).toBe('none');
    expect(inner.overflow?.value).toBe('auto');
    expect(inner['border-radius']?.value).toBe('var(--radius)');
    expect(composerPopover.background?.value).toBe('transparent');
    expect(composerPopover.overflow?.value).toBe('visible');
    expect(composerPopover.border?.value).toBe('none');
    expect(composerPopover['box-shadow']?.value).toBe('none');
    const composerInner = declarationsFor(
      '.legacy-design .session-composer-editor [popover]:has(.astryx-trigger-menu) > div'
    );
    expect(composerInner.width?.value).toBe('100%');
    expect(composerInner.overflow?.value).toBe('auto');
    expect(composerInner['box-shadow']?.value).toBe('none');
    expect(composerInner['border-radius']?.value).toBe('var(--radius)');
  });

  it('keeps slash and dollar command rows on a compact single line', () => {
    const commandOption = declarationsFor(
      ".legacy-design .session-composer-editor .astryx-trigger-menu [role='option']:has([data-composer-trigger-kind='slash']), .legacy-design .session-composer-editor .astryx-trigger-menu [role='option']:has([data-composer-trigger-kind='dollar'])"
    );
    const commandDescription = declarationsFor(
      ".legacy-design .session-composer-editor .astryx-trigger-menu [data-composer-trigger-kind='slash'] .composer-trigger-description, .legacy-design .session-composer-editor .astryx-trigger-menu [data-composer-trigger-kind='dollar'] .composer-trigger-description"
    );

    expect(commandOption['min-height']?.value).toBe('28px');
    expect(commandOption.padding?.value).toBe('4px 8px');
    expect(commandDescription['font-size']?.value).toBe(
      'var(--trigger-menu-font-size)'
    );
  });

  it('hides the @ reference tab scrollbar while keeping overflow for tab switching', () => {
    const tabs = declarationsFor('.legacy-design .composer-at-reference-tabs');
    const menu = declarationsFor(
      '.legacy-design .composer-at-reference-menu.composer-status-surface'
    );

    expect(tabs['overflow-x']?.value).toBe('auto');
    expect(tabs['scrollbar-width']?.value).toBe('none');
    expect(menu.position?.value).toBe('absolute');
    expect(menu.left?.value).toBe('0');
    expect(menu.right?.value).toBe('0');
  });

  it('tucks the @ card under the composer shell so the bottom corners disappear', () => {
    const menu = declarationsFor(
      '.legacy-design .composer-at-reference-menu.composer-status-surface'
    );

    expect(menu.bottom?.value).toBe('calc(100% - var(--radius))');
    expect(menu['padding-bottom']?.value).toBe('var(--radius)');
    expect(Number.parseInt(menu['z-index']?.value ?? '', 10)).toBeLessThan(10);
    expect(menu['border-radius']?.value).toBe(
      'var(--radius) var(--radius) 0 0'
    );
  });

  it('stacks the @ card above an expanded attachment drawer', () => {
    const drawer = declarationsFor(
      '.legacy-design .session-composer-attachment-drawer'
    );
    const menu = declarationsFor(
      '.legacy-design .composer-at-reference-menu.composer-status-surface'
    );

    expect(drawer.position?.value).toBe('relative');
    expect(Number.parseInt(drawer['z-index']?.value ?? '', 10)).toBe(1);
    expect(
      Number.parseInt(menu['z-index']?.value ?? '', 10)
    ).toBeGreaterThan(1);
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
