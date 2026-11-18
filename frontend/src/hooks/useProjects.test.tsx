import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from 'shared/types';

import {
  BackendTransportProvider,
  type BackendTransport,
  type RemoteEvent,
} from '@/lib/transport';
import { useProjects } from './useProjects';
import { useProjectMutations } from './useProjectMutations';

const projectsApiMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  projectsApi: projectsApiMocks,
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Alpha',
    root_path: '/tmp/alpha',
    parent_project_id: null,
    hidden: false,
    is_git: true,
    default_agent_working_dir: null,
    default_main_branch: null,
    is_home: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('useProjects and useProjectMutations in WebUI/remote mode', () => {
  beforeEach(() => {
    projectsApiMocks.create.mockReset();
    projectsApiMocks.update.mockReset();
  });

  it('does not open subscribe_projects_stream on remote transports and updates cache on project mutations', async () => {
    let serverProjects = [makeProject({ id: 'proj-1', name: 'Alpha' })];
    const subscribeSpy = vi.fn();
    const callSpy = vi.fn(async (command: string) => {
      if (command === 'get_projects') {
        return serverProjects;
      }
      return null;
    });

    const webTransport: BackendTransport = {
      environment: 'web',
      call: callSpy,
      subscribe: subscribeSpy,
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <BackendTransportProvider transport={webTransport}>
          {children}
        </BackendTransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        projects: useProjects(),
        mutations: useProjectMutations(),
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.projects.projects).toHaveLength(1);
    });
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(result.current.projects.projects[0]?.name).toBe('Alpha');

    const updatedProject = makeProject({ id: 'proj-1', name: 'Alpha Renamed' });
    projectsApiMocks.update.mockImplementation(async () => {
      serverProjects = [updatedProject];
      return updatedProject;
    });

    await act(async () => {
      await result.current.mutations.updateProject.mutateAsync({
        projectId: 'proj-1',
        data: { name: 'Alpha Renamed', default_main_branch: null },
      });
    });

    expect(projectsApiMocks.update).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.projects.projects[0]?.name).toBe('Alpha Renamed');
    });

    const createdProject = makeProject({
      id: 'proj-2',
      name: 'Beta',
      created_at: new Date('2026-01-02T00:00:00Z'),
    });
    projectsApiMocks.create.mockImplementation(async () => {
      serverProjects = [createdProject, updatedProject];
      return createdProject;
    });

    await act(async () => {
      await result.current.mutations.createProject.mutateAsync({
        name: 'Beta',
        repositories: [],
      });
    });

    expect(projectsApiMocks.create).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.projects.projects.map((p) => p.id)).toEqual([
        'proj-2',
        'proj-1',
      ]);
    });
  });

  it('keeps desktop isLoading true across transient startup stream lock error and recovers on retry', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempt = 0;
    let resolveTail: ((value: IteratorResult<RemoteEvent>) => void) | undefined;
    const savedProject = makeProject({
      id: 'proj-050',
      name: 'Migrated 0.5.0 Project',
      is_home: true,
    });

    const desktopTransport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        attempt += 1;
        const currentAttempt = attempt;
        let step = 0;
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (currentAttempt === 1) {
              return Promise.reject(
                'Database error: error returned from database: (code: 5) database is locked'
              );
            }
            step += 1;
            if (step === 1) {
              return {
                done: false,
                value: {
                  sequence: 1n,
                  kind: 'patch',
                  payload: {
                    JsonPatch: [
                      {
                        op: 'replace',
                        path: '/projects',
                        value: {
                          [savedProject.id]: JSON.parse(
                            JSON.stringify(savedProject)
                          ),
                        },
                      },
                    ],
                  },
                },
              };
            }
            if (step === 2) {
              return {
                done: false,
                value: {
                  sequence: 2n,
                  kind: 'patch',
                  payload: 'Ready',
                },
              };
            }
            return new Promise<IteratorResult<RemoteEvent>>((resolve) => {
              resolveTail = resolve;
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      }),
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <BackendTransportProvider transport={desktopTransport}>
          {children}
        </BackendTransportProvider>
      </QueryClientProvider>
    );

    try {
      const { result, unmount } = renderHook(() => useProjects(), { wrapper });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(attempt).toBe(1);
      // During the initial 1s retry window, isLoading stays true so the UI does not
      // prematurely render an empty zero-project welcome stage.
      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(attempt).toBe(2);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.projects).toHaveLength(1);
      expect(result.current.projects[0]?.name).toBe('Migrated 0.5.0 Project');

      resolveTail?.({ done: true, value: undefined });
      unmount();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
