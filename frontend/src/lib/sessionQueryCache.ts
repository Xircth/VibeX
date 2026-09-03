import type { QueryClient } from '@tanstack/react-query';
import type { Session } from 'shared/types';
import type { SessionSummary } from '@/lib/api';
import type { WorkspaceWithSession } from '@/types/attempt';

export const WORKSPACE_SESSIONS_CHANGED_EVENT = 'workspace-sessions-changed';

export type WorkspaceSessionsChangedPayload = {
  workspace_id: string;
  conversation_id: string;
};

export function invalidateWorkspaceSessions(
  queryClient: QueryClient,
  workspaceId: string
) {
  return queryClient.invalidateQueries({
    queryKey: ['workspaceSessions', workspaceId],
  });
}

type SessionListCacheEntry = Pick<Session, 'id'> | Pick<SessionSummary, 'id'>;

export function removeSessionsFromWorkspaceCaches(
  queryClient: QueryClient,
  sessionIds: Iterable<string>
) {
  const deletedSessionIds = new Set(sessionIds);
  if (deletedSessionIds.size === 0) {
    return;
  }

  queryClient.setQueriesData<SessionListCacheEntry[]>(
    { queryKey: ['workspaceSessions'] },
    (current) => {
      if (!Array.isArray(current)) {
        return current;
      }

      return current.filter((session) => !deletedSessionIds.has(session.id));
    }
  );

  queryClient.setQueriesData<WorkspaceWithSession>(
    { queryKey: ['taskAttemptWithSession'] },
    (current) => {
      if (!current?.session || !deletedSessionIds.has(current.session.id)) {
        return current;
      }

      return {
        ...current,
        session: undefined,
      };
    }
  );

  deletedSessionIds.forEach((sessionId) => {
    queryClient.removeQueries({
      queryKey: ['session', sessionId],
    });
  });
}
