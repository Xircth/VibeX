export const COMMIT_GRAPH_LABELS = {
  title: '\u63d0\u4ea4\u56fe',
  loading: '\u52a0\u8f7d\u63d0\u4ea4\u56fe...',
} as const;

export function formatCommitTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return `${diff}\u79d2\u524d`;
  if (diff < 3600) return `${Math.floor(diff / 60)}\u5206\u949f\u524d`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}\u5c0f\u65f6\u524d`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}\u5929\u524d`;

  return new Date(timestamp * 1000).toLocaleDateString();
}
