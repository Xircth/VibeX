export type KanbanSessionDetailQueryState = {
  queryKey: readonly ['session', string | undefined];
  enabled: boolean;
  fetchSessionId: string | null;
};

export function getKanbanSessionDetailQueryState(
  sessionId: string | undefined
): KanbanSessionDetailQueryState {
  return {
    queryKey: ['session', sessionId],
    enabled: Boolean(sessionId),
    fetchSessionId: sessionId ?? null,
  };
}
