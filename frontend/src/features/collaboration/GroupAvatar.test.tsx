import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  GroupAvatar,
  GROUP_AVATAR_LAYOUTS,
  GROUP_AVATAR_TILT_DEG,
} from './GroupAvatar';
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

  it('stacks with plain z-order: 1 lowest, later members on top', () => {
    const z = (n: number) => GROUP_AVATAR_LAYOUTS[n].map((s) => s.z);
    expect(z(4)).toEqual([1, 2, 2, 3]);
    expect(z(3)).toEqual([1, 2, 3]);
    expect(z(2)).toEqual([1, 2]);
    render(<GroupAvatar avatars={avatars(4)} />);
    const slots = screen.getAllByTestId('collaboration-group-avatar-slot');
    expect(slots.map((el) => el.style.zIndex)).toEqual(['1', '2', '2', '3']);
    for (const slot of slots) {
      expect(slot.style.maskImage || slot.style.webkitMaskImage).toBeFalsy();
    }
  });

  it('outlines each silhouette in white and turns the gaze up-right', () => {
    render(<GroupAvatar avatars={avatars(2)} tagHue="45 93% 47%" />);
    const root = screen.getByTestId('collaboration-group-avatar');
    expect(root).toHaveClass('has-tag');
    expect(root.style.getPropertyValue('--group-avatar-tag')).toBe(
      'hsl(45 93% 47%)'
    );
    expect(root.querySelectorAll('[data-gaze="up-right"]')).toHaveLength(2);
    expect(root.querySelectorAll('[stroke="#ffffff"]').length).toBeGreaterThan(
      0
    );
  });
});

describe('GroupAvatar tilt', () => {
  it('rotates each upright member body slightly counter-clockwise', () => {
    render(<GroupAvatar avatars={avatars(4)} />);
    for (const slot of screen.getAllByTestId(
      'collaboration-group-avatar-slot'
    )) {
      expect(slot.style.transform).toBe(`rotate(${GROUP_AVATAR_TILT_DEG}deg)`);
    }
    expect(GROUP_AVATAR_TILT_DEG).toBeGreaterThanOrEqual(-15);
    expect(GROUP_AVATAR_TILT_DEG).toBeLessThanOrEqual(-8);
  });
});
