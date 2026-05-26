import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionComposerSessionRename } from './useSessionComposerSessionRename';

const { renameMock } = vi.hoisted(() => ({
  renameMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  sessionsApi: {
    rename: renameMock,
  },
}));

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useSessionComposerSessionRename', () => {
  beforeEach(() => {
    renameMock.mockReset();
  });

  it('renames sessions and invalidates workspace plus session queries', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue();
    renameMock.mockResolvedValue(undefined);

    const { result } = renderHook(
      () => useSessionComposerSessionRename({ workspaceId: 'workspace-1' }),
      { wrapper: wrapperFor(queryClient) }
    );

    await act(async () => {
      await result.current.handleRenameSession('session-1', 'New name');
    });

    expect(renameMock).toHaveBeenCalledWith('session-1', 'New name');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['workspaceSessions', 'workspace-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['session', 'session-1'],
    });
  });

  it('skips workspace invalidation without a workspace id', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue();
    renameMock.mockResolvedValue(undefined);

    const { result } = renderHook(
      () => useSessionComposerSessionRename({ workspaceId: null }),
      { wrapper: wrapperFor(queryClient) }
    );

    await act(async () => {
      await result.current.handleRenameSession('session-1', null);
    });

    expect(renameMock).toHaveBeenCalledWith('session-1', null);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['session', 'session-1'],
    });
  });

  it('does not invalidate queries when rename fails', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue();
    renameMock.mockRejectedValue(new Error('rename failed'));

    const { result } = renderHook(
      () => useSessionComposerSessionRename({ workspaceId: 'workspace-1' }),
      { wrapper: wrapperFor(queryClient) }
    );

    await expect(
      result.current.handleRenameSession('session-1', 'Broken')
    ).rejects.toThrow('rename failed');

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
