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
      if (!rule.selector.includes('.astryx-rich-text-editor')) return;
      if (!rule.selector.includes(':last-child')) return;
      rule.walkDecls('padding', (declaration) => {
        matches.push(declaration.value);
      });
    });
    expect(matches).toContain('1rem 1.5rem');
  });

  it('scrolls the editor body instead of clipping long markdown', () => {
    const css = readFileSync(STYLESHEET, 'utf8');
    const fieldChild: Record<string, string> = {};
    const editorBody: Record<string, string> = {};
    parse(css).walkRules((rule: Rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ').trim();
      if (selector.includes('.markdown-rich-text-editor > * > :last-child')) {
        rule.walkDecls((declaration) => {
          fieldChild[declaration.prop] = declaration.value;
        });
      }
      if (
        selector.includes('.astryx-rich-text-editor') &&
        selector.includes(':last-child')
      ) {
        rule.walkDecls((declaration) => {
          editorBody[declaration.prop] = declaration.value;
        });
      }
    });
    expect(fieldChild.display).toBe('flex');
    expect(fieldChild['min-height']).toBe('0');
    expect(fieldChild.overflow).toBe('hidden');
    expect(editorBody['min-height']).toBe('0');
    expect(editorBody.overflow).toBe('auto');
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

  it('does not strip chrome from controls inside a nested dialog', () => {
    const css = readFileSync(STYLESHEET, 'utf8');
    const pressable: string[] = [];
    parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('[data-pressable-container]')) return;
      pressable.push(rule.selector);
    });
    expect(pressable.length).toBeGreaterThan(0);
    for (const selector of pressable) {
      expect(selector).toContain(':not(dialog *)');
    }

    const header = declarationsFor(css, '.astryx-layout-header > div');
    const content = declarationsFor(css, '.astryx-layout-content');
    const layout = declarationsFor(css, 'dialog .astryx-layout');
    expect(header.padding).toBe('var(--spacing-4, 16px)');
    expect(content['padding-inline']).toBe('var(--spacing-4, 16px)');
    expect(content['padding-block']).toBe('0 var(--spacing-4, 16px)');
    expect(layout.margin).toBe('0');
  });
});

function declarationsFor(css: string, part: string): Record<string, string> {
  const decls: Record<string, string> = {};
  parse(css).walkRules((rule: Rule) => {
    if (!rule.selector.includes(part)) return;
    rule.walkDecls((declaration) => {
      decls[declaration.prop] = declaration.value;
    });
  });
  return decls;
}
