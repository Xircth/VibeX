import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from 'shared/types';

import { BackendTransportProvider, type BackendTransport } from '@/lib/transport';
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
});
