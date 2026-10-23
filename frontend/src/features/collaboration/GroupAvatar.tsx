import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import './groupAvatar.css';

/** Member avatar diameter as a percentage of the group avatar. */
export const GROUP_AVATAR_SLOT_SIZE = 58;
export const GROUP_AVATAR_MAX_MEMBERS = 4;

type Slot = { x: number; y: number };

/**
 * Top-left offsets (in % of the container) per member count, following grid
 * order: 1 centred; 2 diagonal; 3 = [1,2] over [3]; 4 = [1,2],[3,4].
 */
const LAYOUTS: Record<number, Slot[]> = {
  1: [{ x: 21, y: 21 }],
  2: [
    { x: 6, y: 6 },
    { x: 36, y: 36 },
  ],
  3: [
    { x: 4, y: 8 },
    { x: 38, y: 8 },
    { x: 21, y: 36 },
  ],
  4: [
    { x: 6, y: 6 },
    { x: 36, y: 6 },
    { x: 6, y: 36 },
    { x: 36, y: 36 },
  ],
};

/**
 * Paint order (bottom → top, as member indexes) that satisfies every
 * clockwise "covers" relation except `first covers second`, which is restored
 * by a clipped copy of the first member painted last.
 *   4: 1>2, 2>4, 4>3, 3>1  → paint 1,3,4,2 + clipped 1 (over 2, minus 3)
 *   3: 1>2, 2>3, 3>1       → paint 1,3,2   + clipped 1 (over 2, minus 3)
 *   2: 1>2                 → paint 2,1
 */
const PAINT_ORDER: Record<number, number[]> = {
  1: [0],
  2: [1, 0],
  3: [0, 2, 1],
  4: [0, 2, 3, 1],
};

/** Circle of `other` expressed in `self`'s box, as a radial-gradient layer. */
function circleIn(self: Slot, other: Slot): string {
  const s = GROUP_AVATAR_SLOT_SIZE;
  const cx = ((other.x - self.x + s / 2) / s) * 100;
  const cy = ((other.y - self.y + s / 2) / s) * 100;
  return `radial-gradient(50% 50% at ${cx}% ${cy}%, #000 calc(100% - 0.5px), transparent 100%)`;
}

/**
 * Mask for the overlay copy of member 1: visible only where member 2 sits,
 * minus where member 3 (which covers member 1) sits.
 */
export function groupAvatarCycleMask(count: number): string | null {
  if (count < 3) return null;
  const slots = LAYOUTS[count];
  const first = slots[0];
  return `${circleIn(first, slots[1])}, ${circleIn(first, slots[2])}`;
}

export function GroupAvatar({
  avatars,
  tagColor,
  tagId,
  className,
  'data-testid': testId = 'group-avatar',
}: {
  /** Member (agent) avatars only — never the User. Extra members are dropped. */
  avatars: readonly MemberBotAvatarConfig[];
  /** Group tag colour, drawn as a 2px outer ring with a 1px gap. */
  tagColor?: string;
  tagId?: string;
  className?: string;
  'data-testid'?: string;
}) {
  const members = avatars.slice(0, GROUP_AVATAR_MAX_MEMBERS);
  const count = members.length;
  const slots = LAYOUTS[count] ?? [];
  const order = PAINT_ORDER[count] ?? [];
  const mask = groupAvatarCycleMask(count);

  const renderSlot = (index: number, overlay = false) => {
    const slot = slots[index];
    const style: CSSProperties = {
      left: `${slot.x}%`,
      top: `${slot.y}%`,
      width: `${GROUP_AVATAR_SLOT_SIZE}%`,
      height: `${GROUP_AVATAR_SLOT_SIZE}%`,
    };
    if (overlay && mask) {
      Object.assign(style, {
        maskImage: mask,
        WebkitMaskImage: mask,
        maskComposite: 'subtract',
        WebkitMaskComposite: 'source-out',
      });
    }
    return (
      <span
        key={overlay ? `overlay-${index}` : index}
        className={cn('group-avatar-slot', overlay && 'group-avatar-slot--overlay')}
        data-member-index={index + 1}
        data-overlay={overlay ? 'true' : undefined}
        style={style}
      >
        <MemberBotAvatar
          config={members[index]}
          animated={false}
          className="group-avatar-member"
        />
      </span>
    );
  };

  return (
    <span
      className={cn('group-avatar', tagColor && 'group-avatar--tagged', className)}
      data-testid={testId}
      data-member-count={count}
      data-tag-color={tagId}
      style={tagColor ? ({ '--group-avatar-tag': tagColor } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {order.map((index) => renderSlot(index))}
      {mask ? renderSlot(0, true) : null}
    </span>
  );
}
