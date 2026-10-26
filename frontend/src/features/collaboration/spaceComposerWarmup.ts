export const SPACE_WARMUP_DEBOUNCE_MS = 500;
export const SPACE_WARMUP_COOLDOWN_MS = 30_000;

export function spaceWarmupKey(spaceId: string, to: string[]): string {
  return `${spaceId}\0${[...to].sort().join('\0')}`;
}

export function shouldWarmupGroupComposer(args: {
  spaceId: string | null | undefined;
  isDirect: boolean;
  content: string;
}): boolean {
  if (args.isDirect) return false;
  const spaceId = args.spaceId?.trim() ?? '';
  if (!spaceId || spaceId.startsWith('direct:')) return false;
  return args.content.trim().length > 0;
}

export class SpaceWarmupCooldown {
  private lastSentAt = new Map<string, number>();

  tryAcquire(spaceId: string, to: string[], now = Date.now()): boolean {
    const key = spaceWarmupKey(spaceId, to);
    const previous = this.lastSentAt.get(key);
    if (
      previous !== undefined &&
      now - previous < SPACE_WARMUP_COOLDOWN_MS
    ) {
      return false;
    }
    this.lastSentAt.set(key, now);
    return true;
  }
}
