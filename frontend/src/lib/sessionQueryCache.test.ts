import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  invalidateWorkspaceSessions,
  removeSessionsFromWorkspaceCaches,
} from './sessionQueryCache';

describe('removeSessionsFromWorkspaceCaches', () => {
  it('evicts deleted sessions from workspace and active-attempt caches', () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1'],
      [{ id: 'deleted-session' }, { id: 'kept-session' }]
    );
    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1', 'summaries'],
      [{ id: 'deleted-session' }, { id: 'kept-session' }]
    );
    queryClient.setQueryData(['taskAttemptWithSession', 'workspace-1'], {
      id: 'workspace-1',
      session: { id: 'deleted-session' },
    });
    queryClient.setQueryData(['taskAttemptWithSession', 'workspace-2'], {
      id: 'workspace-2',
      session: { id: 'kept-session' },
    });
    queryClient.setQueryData(['session', 'deleted-session'], {
      id: 'deleted-session',
    });

    removeSessionsFromWorkspaceCaches(queryClient, ['deleted-session']);

    expect(
      queryClient.getQueryData<Array<{ id: string }>>([
        'workspaceSessions',
        'workspace-1',
      ])
    ).toEqual([{ id: 'kept-session' }]);
    expect(
      queryClient.getQueryData<Array<{ id: string }>>([
        'workspaceSessions',
        'workspace-1',
        'summaries',
      ])
    ).toEqual([{ id: 'kept-session' }]);
    expect(
      queryClient.getQueryData<{ session?: { id: string } }>([
        'taskAttemptWithSession',
        'workspace-1',
      ])?.session
    ).toBeUndefined();
    expect(
      queryClient.getQueryData<{ session?: { id: string } }>([
        'taskAttemptWithSession',
        'workspace-2',
      ])?.session?.id
    ).toBe('kept-session');
    expect(
      queryClient.getQueryData(['session', 'deleted-session'])
    ).toBeUndefined();
  });

  it('invalidates the workspace session list for a live import', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await invalidateWorkspaceSessions(queryClient, 'workspace-1');

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['workspaceSessions', 'workspace-1'],
    });
  });
});
