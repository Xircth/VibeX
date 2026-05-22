import type { QueryClient } from '@tanstack/react-query';
import type { Session } from 'shared/types';
import type { SessionSummary } from '@/lib/api';
import type { WorkspaceWithSession } from '@/types/attempt';

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
