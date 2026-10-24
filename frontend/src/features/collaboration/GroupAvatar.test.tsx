import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupAvatar, GROUP_AVATAR_LAYOUTS } from './GroupAvatar';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

const avatars = (n: number) =>
  Array.from({ length: n }, (_, i) => deriveMemberBotAvatar(`m${i}`));

describe('GroupAvatar', () => {
  it.each([1, 2, 3, 4])('renders %i slots in order', (n) => {
    render(<GroupAvatar avatars={avatars(n)} />);
    const slots = screen.getAllByTestId('collaboration-group-avatar-slot');
    expect(slots.map((el) => el.dataset.slot)).toEqual(
      Array.from({ length: n }, (_, i) => String(i + 1))
    );
    expect(screen.getByTestId('collaboration-group-avatar')).toHaveAttribute(
      'data-count',
      String(n)
    );
  });

  it('caps at 4 members', () => {
    render(<GroupAvatar avatars={avatars(7)} />);
    expect(
      screen.getAllByTestId('collaboration-group-avatar-slot')
    ).toHaveLength(4);
  });

  it('uses the clockwise pinwheel cover cycle', () => {
    const coveredBy = (n: number) =>
      GROUP_AVATAR_LAYOUTS[n].map((s) =>
        s.coveredBy === null ? null : s.coveredBy + 1
      );
    // 4 covers 3, 3 covers 1, 1 covers 2, 2 covers 4
    expect(coveredBy(4)).toEqual([3, 1, 4, 2]);
    // 1 covers 2, 2 covers 3, 3 covers 1
    expect(coveredBy(3)).toEqual([3, 1, 2]);
    expect(coveredBy(2)).toEqual([null, 1]);
    expect(coveredBy(1)).toEqual([null]);
  });

  it('masks covered slots and renders the tag as an outline ring', () => {
    render(<GroupAvatar avatars={avatars(4)} tagHue="45 93% 47%" />);
    const root = screen.getByTestId('collaboration-group-avatar');
    expect(root).toHaveClass('has-tag');
    expect(root.style.getPropertyValue('--group-avatar-tag')).toBe(
      'hsl(45 93% 47%)'
    );
    for (const slot of screen.getAllByTestId(
      'collaboration-group-avatar-slot'
    )) {
      expect(slot.style.maskImage || slot.style.webkitMaskImage).toContain(
        'radial-gradient'
      );
    }
  });
});
