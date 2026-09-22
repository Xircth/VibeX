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
  it('lets the plan card own the popover frame', () => {
    const rules = declarationsFor('.composer-todo-popover.tahoe-popover');

    expect(rules.padding?.value).toBe('0');
    expect(rules.border?.value).toBe('0');
    expect(rules.background?.value).toBe('transparent');
    expect(rules['box-shadow']?.value).toBe('none');
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
