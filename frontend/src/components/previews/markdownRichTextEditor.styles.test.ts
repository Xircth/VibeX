import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/components/previews/markdownRichTextEditor.css'
);

describe('markdown rich text editor chrome', () => {
  it('shrinks with the tab instead of overflowing it', () => {
    const css = readFileSync(STYLESHEET, 'utf8');
    const decls: Record<string, string> = {};
    parse(css).walkRules((rule: Rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ').trim();
      if (selector !== '.markdown-rich-text-editor') {
        return;
      }
      rule.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
    });
    expect(decls['min-width']).toBe('0');
    expect(decls.width).toBe('100%');
    expect(decls.overflow).toBe('hidden');
  });

  it('pads the editing surface like the Preview pane', () => {
    const css = readFileSync(STYLESHEET, 'utf8');
    const matches: string[] = [];
    parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('[data-pressable-container]')) return;
      if (!rule.selector.includes(':last-child')) return;
      rule.walkDecls('padding', (declaration) => {
        matches.push(declaration.value);
      });
    });
    expect(matches).toContain('1rem 1.5rem');
  });
});
