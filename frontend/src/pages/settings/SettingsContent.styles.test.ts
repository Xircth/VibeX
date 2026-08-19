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

describe('settings page alignment', () => {
  it('keeps form pages flush with the sidebar instead of adding extra top inset', () => {
    const content = declarationsFor('.settings-page .settings-content');

    expect(content.get('width')).toBe('min(100%, 860px)');
    expect(content.get('margin')).toBe('0 auto');
    expect(content.get('padding')).toBe('0 0 1.5rem');
  });

  it('uses the same content width for the product plugin catalog', () => {
    const page = declarationsFor('.settings-page .product-plugins-page');

    expect(page.get('width')).toBe('min(100%, 860px)');
    expect(page.get('margin')).toBe('0 auto');
    expect(page.get('padding')).toBe('0 0 1.5rem');
  });

  it('matches chat-channel and plugin catalog titles to other settings headings', () => {
    const chatTitle = declarationsFor(
      '.settings-page .chat-channel-heading__copy h2'
    );
    const chatCopy = declarationsFor(
      '.settings-page .chat-channel-heading__copy p'
    );
    const pluginTitle = declarationsFor(
      '.settings-page .product-plugins-header h1'
    );
    const pluginCopy = declarationsFor(
      '.settings-page .product-plugins-header p'
    );
    const sectionTitle = declarationsFor(
      '.settings-page .settings-card__header h3'
    );
    const sectionCopy = declarationsFor(
      '.settings-page .settings-card__header p'
    );

    expect(chatTitle.get('font-size')).toBe(sectionTitle.get('font-size'));
    expect(chatCopy.get('font-size')).toBe(sectionCopy.get('font-size'));
    expect(pluginTitle.get('font-size')).toBe(sectionTitle.get('font-size'));
    expect(pluginCopy.get('font-size')).toBe(sectionCopy.get('font-size'));
    expect(chatTitle.get('display')).toBe('flex');
    expect(pluginTitle.get('display')).toBe('flex');
  });
});
