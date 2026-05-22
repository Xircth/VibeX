export function buildSessionConversationKey(
  attemptId: string,
  sessionId?: string | null
): string {
  return `${attemptId}:${sessionId ?? 'no-session'}`;
}
