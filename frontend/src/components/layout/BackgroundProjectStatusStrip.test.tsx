import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import {
  BackgroundProjectStatusStrip,
  selectBackgroundActiveProjects,
} from './BackgroundProjectStatusStrip';

const switchProject = vi.hoisted(() => vi.fn());

const mockProjectsState = vi.hoisted(() => ({
  activeProjectId: 'proj-current' as string | undefined,
  projects: [
    {
      id: 'proj-current',
      name: 'Current Workspace',
      root_path: 'C:\\Users\\dev\\acme\\current',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-idle',
      name: 'Idle Project',
      root_path: 'C:\\Users\\dev\\acme\\idle',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-done',
      name: 'Finished Service',
      root_path: 'C:\\Users\\dev\\acme\\finished-service',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-running',
      name: 'Dimo Core',
      root_path: 'C:\\Users\\dev\\dimo\\core',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-blocked',
      name: 'Payment API',
      root_path: 'C:\\Users\\dev\\acme\\payment-api',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-extra-1',
      name: 'Docs Portal',
      root_path: 'C:\\Users\\dev\\acme\\docs-portal',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-extra-2',
      name: 'Mobile App',
      root_path: 'C:\\Users\\dev\\acme\\mobile-app',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
  ],
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useOptionalProject: () => {
    const active = mockProjectsState.projects.find(
      (item) => item.id === mockProjectsState.activeProjectId
    );
    return {
      projectId: mockProjectsState.activeProjectId,
      project: active,
      isLoading: false,
      error: null,
      isError: false,
    };
  },
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: mockProjectsState.projects,
    projectsById: Object.fromEntries(
      mockProjectsState.projects.map((item) => [item.id, item])
    ),
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useProjectSwitcher', () => ({
  useProjectSwitcher: () => switchProject,
}));

function renderStrip(initialEntry = '/local-projects/proj-current/sessions') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BackgroundProjectStatusStrip />
    </MemoryRouter>
  );
}

describe('BackgroundProjectStatusStrip', () => {
  beforeEach(() => {
    switchProject.mockReset();
    mockProjectsState.activeProjectId = 'proj-current';
    useWindowProjectsStore.getState().resetProjectWindowState();
  });

  it('renders nothing when background projects are idle, transiently loading, or only the current project is running', () => {
    const store = useWindowProjectsStore.getState();

    // Active current project running should not appear in background strip
    store.setProjectSnapshot('proj-current', {
      isLoading: false,
      hasRunning: true,
      runningCount: 2,
      hasError: false,
      hasSessions: true,
      recentSessions: [],
    });

    // Transient initial query loading without running sessions should not flash a pill
    store.setProjectSnapshot('proj-idle', {
      isLoading: true,
      hasRunning: false,
      runningCount: 0,
      hasError: false,
      hasSessions: true,
      recentSessions: [],
    });

    // Already-read alert should not appear
    store.setProjectAlert({
      projectId: 'proj-done',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      taskId: null,
      kind: 'success',
      unread: false,
      createdAt: '2026-04-18T10:00:00Z',
      title: 'Done',
      description: 'Finished',
    });

    const { container } = renderStrip();
    expect(container).toBeEmptyDOMElement();
  });

  it('orders pills by attention priority (error-unread -> running -> success-unread) and displays multi-session running counts', () => {
    const store = useWindowProjectsStore.getState();

    store.setProjectAlert({
      projectId: 'proj-done',
      workspaceId: 'ws-done',
      sessionId: 'sess-done',
      taskId: null,
      kind: 'success',
      unread: true,
      createdAt: '2026-04-18T10:00:00Z',
      title: '已完成',
      description: 'Auth refactor completed',
    });

    store.setProjectSnapshot('proj-running', {
      isLoading: false,
      hasRunning: true,
      runningCount: 3,
      hasError: false,
      hasSessions: true,
      recentSessions: [],
    });

    store.setProjectAlert({
      projectId: 'proj-blocked',
      workspaceId: 'ws-blocked',
      sessionId: 'sess-blocked',
      taskId: null,
      kind: 'error',
      unread: true,
      createdAt: '2026-04-18T10:01:00Z',
      title: '等待权限批准',
      description: 'Needs Bash approval',
    });

    renderStrip();

    const strip = screen.getByTestId('background-project-status-strip');
    const pills = strip.querySelectorAll(
      'button[data-testid^="background-project-pill-"]'
    );
    expect(
      Array.from(pills).map((node) => node.getAttribute('data-testid'))
    ).toEqual([
      'background-project-pill-proj-blocked',
      'background-project-pill-proj-running',
      'background-project-pill-proj-done',
    ]);

    expect(
      screen.getByTestId('background-project-spinner-proj-running')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('background-project-running-count-proj-running')
    ).toHaveTextContent('3');
    expect(
      screen.getByTestId('background-project-dot-proj-blocked')
    ).toHaveClass('bg-destructive');
    expect(screen.getByTestId('background-project-dot-proj-done')).toHaveClass(
      'bg-[hsl(var(--success))]'
    );
  });

  it('previews recent sessions and alert details on hover, and switches + clears unread state on click', async () => {
    const user = userEvent.setup();
    const store = useWindowProjectsStore.getState();

    store.setProjectSnapshot('proj-blocked', {
      isLoading: false,
      hasRunning: false,
      runningCount: 0,
      hasError: true,
      hasSessions: true,
      recentSessions: [
        {
          sessionId: 'sess-42',
          workspaceId: 'ws-42',
          taskId: 'task-42',
          title: 'Fix Stripe webhook signature verification',
          subtitle: 'feat/stripe-webhook',
          statusLabel: '执行中',
          visualState: 'error',
          updatedAt: '2026-04-18T10:05:00Z',
        },
      ],
    });

    store.setProjectAlert({
      projectId: 'proj-blocked',
      workspaceId: 'ws-42',
      sessionId: 'sess-42',
      taskId: 'task-42',
      kind: 'error',
      unread: true,
      createdAt: '2026-04-18T10:05:00Z',
      title: '等待权限批准',
      description: 'Allow cargo test in payment-api',
    });

    renderStrip();

    const pill = screen.getByTestId('background-project-pill-proj-blocked');
    fireEvent.mouseEnter(pill);

    const preview = screen.getByTestId(
      'background-project-preview-proj-blocked'
    );
    expect(preview).toHaveTextContent('~/acme/payment-api');
    expect(preview).toHaveTextContent('Allow cargo test in payment-api');
    expect(preview).toHaveTextContent('Fix Stripe webhook s...');
    expect(preview).toHaveTextContent('feat/stripe-webhook');

    await user.click(pill);

    expect(switchProject).toHaveBeenCalledWith('proj-blocked');
    expect(
      useWindowProjectsStore.getState().projectAlerts['proj-blocked']?.unread
    ).toBe(false);
    expect(
      useWindowProjectsStore.getState().consumeProjectFocus('proj-blocked')
    ).toMatchObject({
      workspaceId: 'ws-42',
      sessionId: 'sess-42',
    });
  });

  it('collapses more than 4 active background projects into a +N overflow popover and switches from it', async () => {
    const user = userEvent.setup();
    const store = useWindowProjectsStore.getState();

    for (const id of [
      'proj-blocked',
      'proj-running',
      'proj-done',
      'proj-extra-1',
      'proj-extra-2',
    ]) {
      store.setProjectSnapshot(id, {
        isLoading: false,
        hasRunning: true,
        runningCount: 1,
        hasError: false,
        hasSessions: true,
        recentSessions: [],
      });
    }

    renderStrip();

    expect(screen.getAllByTestId(/^background-project-pill-/)).toHaveLength(4);

    const overflowTrigger = screen.getByTestId(
      'background-project-overflow-trigger'
    );
    expect(overflowTrigger).toHaveTextContent('+1');

    await user.click(overflowTrigger);

    const overflowItem = await screen.findByTestId(
      'background-project-overflow-item-proj-extra-2'
    );
    expect(overflowItem).toHaveTextContent('Mobile App');

    await user.click(overflowItem);
    expect(switchProject).toHaveBeenCalledWith('proj-extra-2');
  });

  it('hides on /settings routes and excludes removed projects', () => {
    const store = useWindowProjectsStore.getState();
    store.setProjectSnapshot('proj-running', {
      isLoading: false,
      hasRunning: true,
      runningCount: 1,
      hasError: false,
      hasSessions: true,
      recentSessions: [],
    });

    const { container } = renderStrip('/settings/general');
    expect(container).toBeEmptyDOMElement();

    const items = selectBackgroundActiveProjects({
      projects: mockProjectsState.projects,
      currentProjectId: 'proj-current',
      openProjectIds: [],
      projectSnapshots: useWindowProjectsStore.getState().projectSnapshots,
      projectAlerts: {},
      removedProjectIds: { 'proj-running': true },
      resolveProjectName: (project) => project.name,
    });
    expect(items).toEqual([]);
  });
});
