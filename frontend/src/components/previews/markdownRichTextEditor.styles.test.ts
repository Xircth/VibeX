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

  it('kills the Field focus ring that appears after click', () => {
    const css = readFileSync(STYLESHEET, 'utf8');
    const focusDecls: Record<string, { value: string; important: boolean }> =
      {};
    parse(css).walkRules((rule: Rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ');
      if (!selector.includes('.astryx-rich-text-editor')) return;
      if (!selector.includes(':focus-within')) return;
      rule.walkDecls((declaration) => {
        focusDecls[declaration.prop] = {
          value: declaration.value,
          important: declaration.important,
        };
      });
    });

    expect(focusDecls.border?.value).toBe('none');
    expect(focusDecls.border?.important).toBe(true);
    expect(focusDecls['box-shadow']?.value).toBe('none');
    expect(focusDecls['box-shadow']?.important).toBe(true);
    expect(focusDecls.outline?.value).toBe('none');
    expect(focusDecls.outline?.important).toBe(true);
  });

  it('kills the contenteditable outline after the surface is focused', () => {
    const css = readFileSync(STYLESHEET, 'utf8');
    const decls: Record<string, string> = {};
    parse(css).walkRules((rule: Rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ');
      if (!selector.includes('[contenteditable]')) return;
      if (!selector.includes(':focus')) return;
      rule.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
    });

    expect(decls.outline).toBe('none');
    expect(decls['box-shadow']).toBe('none');
    expect(decls.border).toBe('none');
  });
});
