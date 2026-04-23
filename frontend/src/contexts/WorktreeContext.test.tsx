import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProjectProvider } from '@/contexts/ProjectContext';
import { WorktreeProvider, useWorktree } from '@/contexts/WorktreeContext';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

vi.mock('@/hooks/useProjects', () => {
  const project = {
    id: 'project-1',
    name: 'Project One',
    created_at: '2026-03-24T00:00:00.000Z',
  };

  return {
    useProjects: () => ({
      projects: [project],
      projectsById: {
        [project.id]: project,
      },
      isLoading: false,
      isConnected: true,
      error: null,
    }),
  };
});

function WorktreeProbe() {
  const { activeWorktreeId, activeTaskId } = useWorktree();

  return (
    <>
      <div data-testid="active-worktree">{activeWorktreeId ?? 'none'}</div>
      <div data-testid="active-task">{activeTaskId ?? 'none'}</div>
    </>
  );
}

function renderWorktreeRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/local-projects/:projectId/sessions"
          element={
            <ProjectProvider>
              <WorktreeProvider>
                <WorktreeProbe />
              </WorktreeProvider>
            </ProjectProvider>
          }
        />
        <Route
          path="/local-projects/:projectId/workspaces/:workspaceId"
          element={
            <ProjectProvider>
              <WorktreeProvider>
                <WorktreeProbe />
              </WorktreeProvider>
            </ProjectProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('WorktreeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProjectViewStateStore.setState({
      worktreeByProject: {},
      kanbanByProject: {},
    });
    useLayoutStore.getState().resetLayout();
  });

  it('uses the route workspace when the URL points at a specific attempt', async () => {
    useProjectViewStateStore.getState().setWorktreeState('project-1', {
      activeWorktreeId: 'stored-worktree',
      activeTaskId: 'stored-task',
    });

    renderWorktreeRoute('/local-projects/project-1/workspaces/route-worktree');

    await waitFor(() => {
      expect(screen.getByTestId('active-worktree').textContent).toBe(
        'route-worktree'
      );
      expect(screen.getByTestId('active-task').textContent).toBe('none');
    });
  });

  it('falls back to the stored workspace when the URL has no attempt', async () => {
    useProjectViewStateStore.getState().setWorktreeState('project-1', {
      activeWorktreeId: 'stored-worktree',
      activeTaskId: 'stored-task',
    });

    renderWorktreeRoute('/local-projects/project-1/sessions');

    await waitFor(() => {
      expect(screen.getByTestId('active-worktree').textContent).toBe(
        'stored-worktree'
      );
      expect(screen.getByTestId('active-task').textContent).toBe('stored-task');
    });
  });
});
