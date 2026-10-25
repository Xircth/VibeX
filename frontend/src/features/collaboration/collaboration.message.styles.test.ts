import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

function declarationsFor(
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(
    resolve(process.cwd(), 'src/features/collaboration/collaboration.css'),
    'utf8'
  );
  const declarations: Record<string, { value: string; important: boolean }> =
    {};
  parse(css).walkRules((rule: Rule) => {
    if (rule.parent?.type === 'atrule') return;
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

describe('collaboration assistant list and message cluster chrome', () => {
  it('sizes assistant-list chips from the list-avatar token', () => {
    const chip = declarationsFor('.collaboration-top-member-chip');
    expect(chip.height?.value).toBe('var(--collaboration-list-avatar, 2.5rem)');
    expect(chip['font-size']?.value).toBe('0.8125rem');

    const stack = declarationsFor('.collaboration-top-member-stack-item');
    expect(stack.width?.value).toBe('var(--collaboration-list-avatar, 2.5rem)');
    expect(stack.height?.value).toBe(
      'var(--collaboration-list-avatar, 2.5rem)'
    );
  });

  it('keeps message avatars at 40px with name type 1px larger', () => {
    const shell = declarationsFor('.collaboration-shell');
    expect(shell['--collaboration-assistant-avatar']?.value).toBe('2.5rem');
  });

  it('places the 40px avatar at the bottom-left of the bubble', () => {
    const row = declarationsFor('.collaboration-message-row');
    expect(row['align-items']?.value).toBe('flex-end');

    const slot = declarationsFor('.collaboration-message-avatar-slot');
    expect(slot.width?.value).toBe(
      'var(--collaboration-assistant-avatar, 2.5rem)'
    );

    const avatar = declarationsFor('.collaboration-message-avatar');
    expect(avatar.width?.value).toBe(
      'var(--collaboration-assistant-avatar, 2.5rem)'
    );
    expect(avatar.height?.value).toBe(
      'var(--collaboration-assistant-avatar, 2.5rem)'
    );

    const name = declarationsFor('.collaboration-message-name');
    expect(name['font-size']?.value).toBe('0.9375rem');
  });

  it('uses a filled bubble and WeChat-style cluster radii', () => {
    const bubble = declarationsFor(
      '.collaboration-message .conv-assistant-msg'
    );
    expect(bubble.background?.value).toBe('var(--surface-subtle)');
    expect(bubble['border-radius']?.value).toBe('var(--radius)');
    expect(bubble.width?.value).toBe('fit-content');

    const inner = declarationsFor('.collaboration-member-bubble');
    expect(inner.background).toBeUndefined();
    expect(inner.padding).toBeUndefined();

    const collapse = (value: string | undefined) =>
      (value ?? '').replace(/\s+/g, ' ').trim();

    const start = declarationsFor(
      ".collaboration-message[data-cluster='start'] .conv-assistant-msg"
    );
    expect(collapse(start['border-radius']?.value)).toBe(
      'var(--radius) var(--radius) var(--collaboration-cluster-radius) var(--collaboration-cluster-radius)'
    );

    const middle = declarationsFor(
      ".collaboration-message[data-cluster='middle'] .conv-assistant-msg"
    );
    expect(collapse(middle['border-radius']?.value)).toBe(
      'var(--collaboration-cluster-radius)'
    );

    const end = declarationsFor(
      ".collaboration-message[data-cluster='end'] .conv-assistant-msg"
    );
    expect(collapse(end['border-radius']?.value)).toBe(
      'var(--collaboration-cluster-radius) var(--collaboration-cluster-radius) var(--radius) var(--radius)'
    );
  });

  it('places user delivery ticks below the bubble', () => {
    const userRow = declarationsFor('.collaboration-bubble-outer-row--user');
    expect(userRow['flex-direction']?.value).toBe('column');
    expect(userRow['align-items']?.value).toBe('flex-end');
  });

  it('shimmers working-status copy between muted and strong text', () => {
    const copy = declarationsFor('.collaboration-working-copy');
    expect(copy.animation?.value).toContain('collaboration-working-shimmer');
    expect(copy['background-image']?.value ?? copy.background?.value).toContain(
      '--text-muted'
    );
    expect(copy['background-image']?.value ?? copy.background?.value).toContain(
      '--text-strong'
    );
    expect(
      copy['-webkit-background-clip']?.value ?? copy['background-clip']?.value
    ).toBe('text');
  });

  it('raises the log fade so 40px chips stay clear of the first bubble', () => {
    const log = declarationsFor('.collaboration-thread-log');
    expect(log['padding']?.value).toBe('3.75rem 1rem 0.75rem');
    expect(log['mask-image']?.value).toContain('3.5rem');
  });
});
