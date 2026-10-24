import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';

/** Maximum number of member avatars stacked inside a group avatar. */
export const GROUP_AVATAR_MAX = 4;

/** Box (px) the avatar slots are laid out in; scaled to the rendered size. */
const BOX = 28;

type Slot = { x: number; y: number; size: number; coveredBy: number | null };

/**
 * Pinwheel layouts (clockwise). `coveredBy` is the slot index whose disc sits
 * on top of this slot. Because coverage is cyclic (4→3→1→2→4), z-index can't
 * express it, so every slot masks out the disc of the slot covering it: all
 * avatars live on one layer and the gap left by the mask becomes the ring.
 */
export const GROUP_AVATAR_LAYOUTS: Record<number, readonly Slot[]> = {
  1: [{ x: 5, y: 5, size: 18, coveredBy: null }],
  // 1 covers 2 (left over right)
  2: [
    { x: 2.5, y: 7, size: 14, coveredBy: null },
    { x: 11.5, y: 7, size: 14, coveredBy: 0 },
  ],
  // 1 covers 2, 2 covers 3, 3 covers 1 — clockwise from top
  3: [
    { x: 7, y: 2.5, size: 14, coveredBy: 2 },
    { x: 12, y: 11.5, size: 14, coveredBy: 0 },
    { x: 2, y: 11.5, size: 14, coveredBy: 1 },
  ],
  // rows: [1,2] [3,4]; 4 covers 3, 3 covers 1, 1 covers 2, 2 covers 4
  4: [
    { x: 2.5, y: 2.5, size: 13, coveredBy: 2 },
    { x: 12.5, y: 2.5, size: 13, coveredBy: 0 },
    { x: 2.5, y: 12.5, size: 13, coveredBy: 3 },
    { x: 12.5, y: 12.5, size: 13, coveredBy: 1 },
  ],
};

/** Width of the ring left around the covering avatar (in BOX px). */
const RING = 0.6;

function maskFor(
  slot: Slot,
  slots: readonly Slot[],
  k: number
): string | undefined {
  if (slot.coveredBy === null) return undefined;
  const over = slots[slot.coveredBy];
  const cx = (over.x + over.size / 2 - slot.x) * k;
  const cy = (over.y + over.size / 2 - slot.y) * k;
  const r = (over.size / 2 + RING) * k;
  const f = (n: number) => `${Math.round(n * 100) / 100}px`;
  return `radial-gradient(circle at ${f(cx)} ${f(cy)}, transparent ${f(r)}, #000 ${f(r + 0.5)})`;
}

export function GroupAvatar({
  avatars,
  tagHue,
  size = 24,
  className,
  'data-testid': dataTestId = 'collaboration-group-avatar',
}: {
  /** Rendered edge length in px. */
  size?: number;
  /** Member avatars in display order, User already excluded. */
  avatars: readonly MemberBotAvatarConfig[];
  /** Space tag hue ("h s% l%") rendered as an outline ring. */
  tagHue?: string;
  className?: string;
  'data-testid'?: string;
}) {
  const shown = avatars.slice(0, GROUP_AVATAR_MAX);
  const slots = GROUP_AVATAR_LAYOUTS[shown.length] ?? [];
  const k = size / BOX;
  return (
    <span
      className={cn(
        'collaboration-group-avatar',
        tagHue && 'has-tag',
        className
      )}
      data-testid={dataTestId}
      data-count={shown.length}
      style={
        {
          width: `${size}px`,
          height: `${size}px`,
          ...(tagHue ? { '--group-avatar-tag': `hsl(${tagHue})` } : {}),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {shown.map((avatar, index) => {
        const slot = slots[index];
        const mask = maskFor(slot, slots, k);
        const style: CSSProperties = {
          left: `${slot.x * k}px`,
          top: `${slot.y * k}px`,
          width: `${slot.size * k}px`,
          height: `${slot.size * k}px`,
          ...(mask ? { WebkitMaskImage: mask, maskImage: mask } : {}),
        };
        return (
          <span
            key={index}
            className="collaboration-group-avatar-slot"
            data-testid="collaboration-group-avatar-slot"
            data-slot={index + 1}
            data-covered-by={
              slot.coveredBy === null ? undefined : slot.coveredBy + 1
            }
            style={style}
          >
            <MemberBotAvatar
              config={avatar}
              animated={false}
              className="collaboration-group-avatar-img"
            />
          </span>
        );
      })}
    </span>
  );
}
