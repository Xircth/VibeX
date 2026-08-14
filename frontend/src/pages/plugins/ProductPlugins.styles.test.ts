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
    if (normalizedSelector !== selector || rule.parent?.type === 'atrule')
      return;
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
});
