export const COLLAB_ASSISTANT_AVATAR_PX = 40;

export type MemberMessageCluster = 'solo' | 'start' | 'middle' | 'end';

export function memberMessageClusters(
  messages: ReadonlyArray<{ fromYou: boolean; authorKey: string }>
): Array<MemberMessageCluster | null> {
  const keys = messages.map((message, index) => {
    if (message.fromYou) return null;
    const key = message.authorKey.trim();
    return key || `anon:${index}`;
  });
  return keys.map((key, index) => {
    if (key == null) return null;
    const prev = keys[index - 1] === key;
    const next = keys[index + 1] === key;
    if (!prev && !next) return 'solo';
    if (!prev && next) return 'start';
    if (prev && next) return 'middle';
    return 'end';
  });
}

export function showsClusterName(
  cluster: MemberMessageCluster | null
): boolean {
  return cluster === 'solo' || cluster === 'start';
}

export function showsClusterAvatar(
  cluster: MemberMessageCluster | null
): boolean {
  return cluster === 'solo' || cluster === 'end';
}
