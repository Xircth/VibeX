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
  useProject: () => ({
    projectId: mocks.currentProjectId,
    project:
      mocks.currentProjectId === 'project-alpha'
        ? { id: 'project-alpha', name: 'Alpha' }
        : mocks.currentProjectId === 'project-beta'
          ? { id: 'project-beta', name: 'Beta' }
          : undefined,
  }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [
      { id: 'project-alpha', name: 'Alpha' },
      { id: 'project-beta', name: 'Beta' },
    ],
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

  it('renders a unified bottom-left project selector with integrated status indicator and project count', () => {
    render(<ProjectWindowStatusSummary />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-project-rail-toggle', 'true');
    expect(buttons[0]).toHaveAttribute(
      'data-testid',
      'bottom-left-project-selector'
    );
    expect(buttons[0]).toHaveTextContent('Alpha');
    expect(buttons[0]).toHaveTextContent('2');
    expect(buttons[0]).toHaveClass(
      'workspace-toolbar-button',
      'h-8',
      'rounded-lg'
    );
    expect(
      screen.getByTestId('project-selector-status-dot')
    ).toBeInTheDocument();
  });

  it('keeps the selector toggle visible while the project selector menu is open', () => {
    useWindowProjectsStore.setState({ railVisible: true });
    render(<ProjectWindowStatusSummary />);

    expect(screen.getByRole('button', { pressed: true })).toHaveAttribute(
      'data-project-rail-toggle',
      'true'
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('does not open a session status popover when hovering the project selector', () => {
    render(<ProjectWindowStatusSummary />);

    const selectorBtn = screen.getByTestId('bottom-left-project-selector');
    fireEvent.mouseEnter(selectorBtn);

    expect(screen.queryByText('Fix navigation')).not.toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('toggles the project selector menu when clicked', () => {
    render(<ProjectWindowStatusSummary />);

    fireEvent.click(screen.getByTestId('bottom-left-project-selector'));

    expect(useWindowProjectsStore.getState().railVisible).toBe(true);
  });
});

