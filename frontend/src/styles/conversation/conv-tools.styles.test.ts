import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/styles/conversation/conv-tools.css'
);

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

describe('composer todo popover', () => {
  it('draws a bordered frame and hides the list scrollbar', () => {
    const popover = declarationsFor('.composer-todo-popover.tahoe-popover');
    const list = declarationsFor('.composer-todo-list');
    const webkit = declarationsFor('.composer-todo-list::-webkit-scrollbar');
    const nestedCard = declarationsFor('.composer-todo-popover .conv-plan-card');
    const streamCard = declarationsFor('.conv-plan-card');

    expect(popover.border?.value).toBe('1px solid var(--border-strong)');
    expect(popover.width?.value).toBe(
      'min(22rem, var(--radix-popper-anchor-width, calc(100vw - 24px)))'
    );
    expect(popover['max-width']?.value).toBe(
      'var(--radix-popper-anchor-width, calc(100vw - 24px))'
    );
    expect(popover.overflow?.value).toBe('hidden');
    expect(list.overflow?.value).toBe('auto');
    expect(list['scrollbar-width']?.value).toBe('none');
    expect(webkit.display?.value).toBe('none');
    expect(nestedCard.border?.value).toBe('0');
    expect(streamCard.border?.value).toBe(
      '1px solid var(--conv-border-subtle)'
    );
  });
});

describe('conversation tool-call typography', () => {
  it('matches message-stream font, size, weight, and line-height', () => {
    const rules = declarationsFor('.astryx-chat-tool-calls');

    expect(rules['--font-family-body']?.value).toBe('var(--font-ui)');
    expect(rules['--font-family-code']?.value).toBe('var(--font-ui)');
    expect(rules['--text-supporting-size']?.value).toBe('13px');
    expect(rules['--text-supporting-weight']?.value).toBe('400');
    expect(rules['--text-supporting-leading']?.value).toBe('1.7');
    expect(rules['--font-weight-medium']?.value).toBe('400');
    expect(rules['font-family']?.value).toBe('var(--font-ui)');
    expect(rules['font-size']?.value).toBe('13px');
    expect(rules['font-weight']?.value).toBe('400');
    expect(rules['line-height']?.value).toBe('1.7');
  });
});
