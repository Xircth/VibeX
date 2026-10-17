import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-components.css'),
  'utf8'
);

function declarationsFor(selector: string) {
  const declarations = new Map<string, string>();
  parse(stylesheet).walkRules((rule) => {
    const normalizedSelector = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalizedSelector !== selector) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

describe('conversation timeline skeleton', () => {
  it('uses conversation shimmer tokens and does not capture pointer events', () => {
    const shell = declarationsFor('.conv-thread-skeleton');
    expect(shell.get('pointer-events')).toBe('none');
    expect(shell.get('display')).toBe('flex');

    const bar = declarationsFor('.conv-thread-skeleton-bar');
    expect(bar.get('background') ?? '').toContain('var(--conv-shimmer-from)');
    expect(bar.get('animation')).toBe(
      'conv-thread-skeleton-shimmer 1.4s ease-in-out infinite'
    );
  });
});
