import { describe, expect, it } from 'vitest';

import { collapseMemberMentionSpacing, memberMentionPattern } from './MemberMention';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

const candidates = ['小A', '小B'].map((nickname) => ({
  nickname,
  avatar: deriveMemberBotAvatar(nickname),
}));

describe('member mention spacing', () => {
  it('consumes horizontal whitespace around each mention', () => {
    const pattern = memberMentionPattern(candidates)!;
    const text = '交给 @小A @小B  处理';
    expect([...text.matchAll(pattern)].map((m) => [m[0], m[1]])).toEqual([
      [' @小A ', '小A'],
      ['@小B  ', '小B'],
    ]);
    expect('a@小A b'.match(pattern)).toBeNull();
  });

  it('keeps composer spaces but cancels them with margins', () => {
    const root = document.createElement('div');
    root.innerHTML =
      'hi <span class="member-mention--composer">x</span> <span class="member-mention--composer">y</span>';
    collapseMemberMentionSpacing(root);
    expect(root.textContent).toBe('hi x y');
    const [a, b] = root.querySelectorAll<HTMLElement>('span');
    // Shared space between chips is cancelled once (by the left chip).
    expect(a.style.marginRight).not.toBe('');
    expect(b.style.marginLeft).toBe('');
  });
});
