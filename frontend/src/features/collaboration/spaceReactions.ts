export type SpaceReaction = {
  emoji: string;
  actor: string;
};

export const SPACE_REACTION_USER_ACTOR = 'user';

export function reactionsFromUnknown(value: unknown): SpaceReaction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const reactions: SpaceReaction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { emoji?: unknown; actor?: unknown };
    const emoji = String(record.emoji ?? '').trim();
    const actor = String(record.actor ?? '').trim() || SPACE_REACTION_USER_ACTOR;
    if (!emoji) continue;
    const key = `${actor}\0${emoji}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reactions.push({ emoji, actor });
  }
  return reactions;
}

export function toggleSpaceReaction(
  current: readonly SpaceReaction[],
  emoji: string,
  actor = SPACE_REACTION_USER_ACTOR
): SpaceReaction[] {
  const nextEmoji = emoji.trim();
  if (!nextEmoji) return [...current];
  const withoutActor = current.filter((item) => item.actor !== actor);
  const existing = current.find((item) => item.actor === actor);
  if (existing?.emoji === nextEmoji) {
    return withoutActor;
  }
  return [...withoutActor, { emoji: nextEmoji, actor }];
}

export function reactionBadgeEmojis(
  reactions: readonly SpaceReaction[]
): string[] {
  const emojis: string[] = [];
  const seen = new Set<string>();
  for (const item of reactions) {
    if (seen.has(item.emoji)) continue;
    seen.add(item.emoji);
    emojis.push(item.emoji);
  }
  return emojis;
}
