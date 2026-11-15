import { cn } from '@/lib/utils';

/**
 * 3×3 pixel-grid activity indicator.
 *
 * A chevron wavefront drives left-to-right: each cell's delay is
 * `(col + |row - 1|) * 90ms`, so the middle row leads and the outer rows
 * trail, forming a right-pointing chevron. The 650ms cycle is shorter than
 * the 270ms spread, so two fronts are always in flight — the grid reads as
 * continuously churning rather than as a single sweep that restarts.
 *
 * Replaces the circular spinner for long-running connection / generation
 * states. Reduced motion freezes the traveling wave and breathes the whole
 * grid instead, so activity stays legible without per-cell travel.
 */

const CHEVRON_DELAYS_MS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const col = index % 3;
  return (col + Math.abs(row - 1)) * 90;
});

export type PixelGridLoaderSize = 'sm' | 'md';

export function PixelGridLoader({
  size = 'md',
  className,
}: {
  size?: PixelGridLoaderSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'conv-pixel-grid',
        size === 'sm' && 'conv-pixel-grid--sm',
        className
      )}
    >
      {CHEVRON_DELAYS_MS.map((delay, index) => (
        <span
          key={index}
          className="conv-pixel-cell"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Formats a millisecond elapsed duration as `12.3s` or `2m 05.4s`.
 * Used beside the grid so the indicator carries honest progress, not just motion.
 */
export function formatLoadingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, elapsedMs) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toFixed(1).padStart(4, '0')}s`;
}
