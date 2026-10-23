import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GroupAvatar, groupAvatarCycleMask } from './GroupAvatar';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

const avatar = (seed: string) => deriveMemberBotAvatar(seed);

function slots(n: number) {
  const { container } = render(
    <GroupAvatar
      avatars={Array.from({ length: n }, (_, i) => avatar(`m${i}`))}
      tagColor="hsl(210 80% 50%)"
    />
  );
  const root = container.querySelector('[data-testid="group-avatar"]')!;
  return {
    root,
    order: [...root.querySelectorAll('.group-avatar-slot')].map(
      (el) =>
        el.getAttribute('data-member-index')! +
        (el.hasAttribute('data-overlay') ? '*' : '')
    ),
  };
}

describe('GroupAvatar', () => {
  it('caps at 4 members and paints cyclic overlap order', () => {
    expect(slots(1).order).toEqual(['1']);
    expect(slots(2).order).toEqual(['2', '1']);
    expect(slots(3).order).toEqual(['1', '3', '2', '1*']);
    expect(slots(4).order).toEqual(['1', '3', '4', '2', '1*']);
    expect(slots(6).root).toHaveAttribute('data-member-count', '4');
  });

  it('draws the tag ring and masks the overlay copy', () => {
    expect(slots(2).root).toHaveClass('group-avatar--tagged');
    expect(groupAvatarCycleMask(2)).toBeNull();
    expect(groupAvatarCycleMask(4)).toContain('radial-gradient');
  });
});
