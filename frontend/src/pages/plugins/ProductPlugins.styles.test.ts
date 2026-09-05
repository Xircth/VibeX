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
    const normalizedSelector = rule.selector.replace(/\s+/g, ' ').trim();
    if (
      normalizedSelector !== selector ||
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

describe('Product Plugin content layout', () => {
  it('keeps Radix scroll content inside each split pane', () => {
    const panes = declarationsFor(
      '.settings-page .product-plugin-content-browser > *'
    );
    const viewportContent = declarationsFor(
      '.settings-page .product-plugin-content-browser [data-radix-scroll-area-viewport] > div'
    );

    expect(panes.get('min-width')).toBe('0');
    expect(panes.get('min-height')).toBe('0');
    expect(viewportContent.get('display')).toBe('block');
    expect(viewportContent.get('width')).toBe('100%');
    expect(viewportContent.get('min-width')).toBe('0');
  });

  it('constrains long Markdown and file paths to the preview pane', () => {
    const document = declarationsFor('.settings-page .product-plugin-document');
    const content = declarationsFor(
      '.settings-page .product-plugin-document > :not(header)'
    );
    const path = declarationsFor(
      '.settings-page .product-plugin-document > header code'
    );

    expect(document.get('width')).toBe('100%');
    expect(document.get('max-width')).toBe('100%');
    expect(content.get('width')).toBe('100%');
    expect(content.get('min-width')).toBe('0');
    expect(path.get('min-width')).toBe('0');
    expect(path.get('flex')).toBe('1 1 auto');
  });

  it('places catalog mode tabs on the shared settings heading', () => {
    const heading = declarationsFor('.settings-page .chat-channel-heading');
    const intro = declarationsFor('.settings-page .product-plugins-intro-row');
    expect(heading.get('align-items')).toBe('flex-start');
    expect(heading.get('justify-content')).toBe('space-between');
    expect(intro.get('display')).toBe('flex');
    expect(intro.get('justify-content')).toBe('space-between');
  });

  it('keeps the search field itself free of an inner focus rectangle', () => {
    const input = declarationsFor(
      '.settings-page .product-plugin-search input.product-plugin-search-input'
    );
    const focused = declarationsFor(
      '.settings-page .product-plugin-search input.product-plugin-search-input:focus, .settings-page .product-plugin-search input.product-plugin-search-input:focus-visible'
    );
    expect(input.get('min-height')).toBe('0');
    expect(input.get('background-color')).toBe('transparent');
    expect(focused.get('box-shadow')).toBe('none');
  });

  it('keeps plugin lists as uncontained rows', () => {
    const list = declarationsFor('.settings-page .product-plugin-list');
    const market = declarationsFor(
      '.settings-page .product-plugin-market-list'
    );
    const row = declarationsFor('.settings-page .product-plugin-row');
    expect(list.get('background')).toBe('var(--surface-card-strong)');
    expect(market.get('background')).toBe('transparent');
    expect(market.get('border-radius')).toBeUndefined();
    expect(row.get('margin')).toBe('0');
  });

  it('renders category and inspect tabs as an underline text strip', () => {
    const tabs = declarationsFor(
      '.settings-page .product-plugin-underline-tabs'
    );
    const button = declarationsFor(
      '.settings-page .product-plugin-underline-tabs > button'
    );
    const active = declarationsFor(
      '.settings-page .product-plugin-underline-tabs > button.is-active'
    );

    expect(tabs.get('background')).toBe('transparent');
    expect(tabs.get('border-bottom')).toBe('1px solid var(--border-content)');
    expect(button.get('height')).toBe('auto');
    expect(button.get('background')).toBe('transparent');
    expect(button.get('border-bottom')).toBe('3px solid transparent');
    expect(active.get('border-bottom-color')).toBe('var(--text-primary)');
    expect(active.get('background')).toBe('transparent');
    expect(active.get('box-shadow')).toBe('none');
  });

  it('renders the install trust dialog as name, source, and a small permission callout', () => {
    const dialog = declarationsFor(
      '.dialog-surface.product-plugin-trust-dialog'
    );
    const name = declarationsFor('.product-plugin-trust-name');
    const source = declarationsFor('.product-plugin-trust-source');
    const callout = declarationsFor('.product-plugin-trust-callout');
    const permission = declarationsFor('.product-plugin-trust-callout p');

    expect(dialog.get('max-width')).toBe('22rem');
    expect(name.get('font-size')).toBe('0.875rem');
    expect(source.get('font-size')).toBe('0.75rem');
    expect(callout.get('display')).toBe('flex');
    expect(permission.get('font-size')).toBe('0.6875rem');
  });
});
