import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectWindowStatusSummary } from './ProjectWindowStatusSummary';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import type { ProjectActivitySnapshot } from '@/stores/useWindowProjectsStore';

const mocks = vi.hoisted(() => ({
  switchProject: vi.fn(),
  currentProjectId: 'project-alpha' as string | undefined,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: mocks.currentProjectId }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projectsById: {
      'project-alpha': { id: 'project-alpha', name: 'Alpha' },
      'project-beta': { id: 'project-beta', name: 'Beta' },
    },
  }),
}));

vi.mock('@/hooks/useProjectSwitcher', () => ({
  useProjectSwitcher: () => mocks.switchProject,
}));

function snapshot(
  overrides: Partial<ProjectActivitySnapshot> = {}
): ProjectActivitySnapshot {
  return {
    isLoading: false,
    hasRunning: false,
    runningCount: 0,
    hasError: false,
    hasSessions: true,
    recentSessions: [
      {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        taskId: null,
        title: 'Fix navigation',
        subtitle: 'main',
        statusLabel: 'Completed',
        visualState: 'success',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('ProjectWindowStatusSummary', () => {
  beforeEach(() => {
    mocks.switchProject.mockReset();
    mocks.currentProjectId = 'project-alpha';
    useWindowProjectsStore.getState().resetProjectWindowState();
    useWindowProjectsStore.setState({
      railVisible: false,
      openProjectIds: ['project-alpha', 'project-beta'],
      projectSnapshots: {
        'project-alpha': snapshot(),
        'project-beta': snapshot({
          recentSessions: [
            {
              sessionId: 'session-2',
              workspaceId: 'workspace-2',
              taskId: null,
              title: 'Review diffs',
              subtitle: 'feature',
              statusLabel: 'Running',
              visualState: 'loading',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
      },
    });
  });

  it('opens a hovered project session status popover', () => {
    render(<ProjectWindowStatusSummary />);

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: 'openProject:Beta' })
    );

    expect(screen.getByText('Review diffs')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('switches to the clicked project without opening the project rail', () => {
    render(<ProjectWindowStatusSummary />);

    fireEvent.click(screen.getByRole('button', { name: 'openProject:Beta' }));

    expect(mocks.switchProject).toHaveBeenCalledWith('project-beta');
    expect(useWindowProjectsStore.getState().railVisible).toBe(false);
  });

  it('does not switch when the clicked project is already current', () => {
    render(<ProjectWindowStatusSummary />);

    fireEvent.click(screen.getByRole('button', { name: 'openProject:Alpha' }));

    expect(mocks.switchProject).not.toHaveBeenCalled();
  });
});
