import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';

/** Maximum number of member avatars stacked inside a group avatar. */
export const GROUP_AVATAR_MAX = 4;

/** Box (px) the avatar slots are laid out in; scaled to the rendered size. */
const BOX = 28;

/** Thickness (px) of the white silhouette outline at the 24px list size. */
const OUTLINE_PX = 0.75;

/** Tilt (deg, negative = counter-clockwise) of each member body inside the group avatar. */
export const GROUP_AVATAR_TILT_DEG = -12;

type Slot = { x: number; y: number; size: number; z: number };

/**
 * Stacking layouts. Plain z-order: avatar 1 is lowest, later members sit on
 * top (4 members: 1 < 2 = 3 < 4; 3 members: 1 < 2 < 3; 2 members: 1 < 2).
 */
export const GROUP_AVATAR_LAYOUTS: Record<number, readonly Slot[]> = {
  1: [{ x: 4, y: 4, size: 20, z: 1 }],
  // Shapes fill ~75-85% of their slot, so these steps overlap neighbouring
  // silhouettes by roughly 25-30% of their width.
  2: [
    { x: 0.25, y: 5, size: 18, z: 1 },
    { x: 9.75, y: 5, size: 18, z: 2 },
  ],
  3: [
    { x: 5.5, y: 0.5, size: 17, z: 1 },
    { x: 10.5, y: 10, size: 17, z: 2 },
    { x: 0.5, y: 10, size: 17, z: 3 },
  ],
  4: [
    { x: 1, y: 1, size: 16, z: 1 },
    { x: 11, y: 1, size: 16, z: 2 },
    { x: 1, y: 11, size: 16, z: 2 },
    { x: 11, y: 11, size: 16, z: 3 },
  ],
};

export function GroupAvatar({
  avatars,
  tagHue,
  size = 24,
  className,
  'data-testid': dataTestId = 'collaboration-group-avatar',
}: {
  /** Member avatars in display order, User already excluded. */
  avatars: readonly MemberBotAvatarConfig[];
  /** Space tag hue ("h s% l%") rendered as an outline ring. */
  tagHue?: string;
  /** Rendered edge length in px. */
  size?: number;
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
        const px = slot.size * k;
        // Stroke is centred on the path and drawn under the fill, so the
        // visible outer half must equal OUTLINE_PX (scaled to the 64 viewBox).
        const outlinePx = OUTLINE_PX * (size / 24);
        const strokeWidth = ((outlinePx * 2) / px) * 64;
        return (
          <span
            key={index}
            className="collaboration-group-avatar-slot"
            data-testid="collaboration-group-avatar-slot"
            data-slot={index + 1}
            data-z={slot.z}
            style={{
              left: `${slot.x * k}px`,
              top: `${slot.y * k}px`,
              width: `${px}px`,
              height: `${px}px`,
              zIndex: slot.z,
              transform: `rotate(${GROUP_AVATAR_TILT_DEG}deg)`,
            }}
          >
            <MemberBotAvatar
              config={avatar}
              animated={false}
              gaze="up-right"
              silhouetteOutline={{ color: '#ffffff', width: strokeWidth }}
              className="collaboration-group-avatar-img"
            />
          </span>
        );
      })}
    </span>
  );
}
