import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from 'shared/types';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { WorkspaceSessionList } from './WorkspaceSessionList';
import {
  WORKSPACE_SESSION_GROUPS_COLLAPSED_KEY,
  WORKSPACE_SESSION_ORDER_KEY,
} from './workspaceSessionListModel';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    project_id: 'project-1',
    task_id: 'task-1',
    parent_workspace_id: null,
    container_ref: null,
    branch: 'main',
    use_worktree: false,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived: false,
    pinned: false,
    name: 'VibeX',
    ...overrides,
  };
}

function session(
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  const currentWorkspace = overrides.workspace ?? workspace();
  const id = overrides.id ?? 'session-1';
  return {
    id,
    placement: {
      sessionId: id,
      workspaceId: currentWorkspace.id,
    },
    workspace: currentWorkspace,
    task: null,
    taskId: currentWorkspace.task_id,
    name: null,
    status: 'todo',
    branch: currentWorkspace.branch,
    workspaceName: currentWorkspace.name ?? currentWorkspace.branch,
    workspaceDisplayLabel: `${currentWorkspace.name ?? currentWorkspace.branch} · ${currentWorkspace.branch}`,
    executor: 'grok',
    updatedAt: '2026-08-17T12:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
    firstPrompt: 'Double Password Prompt on Project Login',
    fullName: 'Double P',
    shortName: 'Double P',
    taskTitle: null,
    isCompleted: false,
    isRunning: false,
    isErrored: false,
    pinnedAt: null,
    ...overrides,
  };
}

describe('WorkspaceSessionList', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('groups sessions under the workspace branch or worktree name', () => {
    const main = workspace({ id: 'ws-main', branch: 'main', name: 'VibeX' });
    const worktree = workspace({
      id: 'ws-wt',
      branch: 'feature/login',
      name: 'review-login',
      use_worktree: true,
    });

    render(
      <WorkspaceSessionList
        sessions={[
          session({
            id: 's-main',
            workspace: main,
            branch: 'main',
            firstPrompt: 'Compare codeg vs custom APP',
          }),
          session({
            id: 's-wt',
            workspace: worktree,
            workspaceName: 'review-login',
            branch: 'feature/login',
            firstPrompt: 'Modify Plan component styles',
            executor: 'claude_code',
          }),
        ]}
        isLoading={false}
        activeSessionId="s-wt"
        activeWorkspaceId="ws-wt"
        onSessionClick={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'review-login' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'main' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'VibeX' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Claude Code', hidden: true })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Grok', hidden: true })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /Modify Plan component styles/,
      })
    ).toHaveAttribute('aria-current', 'true');
  });

  it('collapses a workspace group and remembers the choice', () => {
    const onSessionClick = vi.fn();
    render(
      <WorkspaceSessionList
        sessions={[
          session({
            firstPrompt: 'DeepSeek Harness full integration',
          }),
        ]}
        isLoading={false}
        activeSessionId={null}
        activeWorkspaceId="workspace-1"
        onSessionClick={onSessionClick}
      />
    );

    expect(
      screen.getByRole('button', {
        name: /DeepSeek Harness full integration/,
      })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'main' }));

    expect(
      screen.queryByRole('button', {
        name: /DeepSeek Harness full integration/,
      })
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(WORKSPACE_SESSION_GROUPS_COLLAPSED_KEY)).toBe(
      JSON.stringify(['workspace-1'])
    );

    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /DeepSeek Harness full integration/,
      })
    );
    expect(onSessionClick).toHaveBeenCalledTimes(1);
  });

  it('shows a running indicator instead of a compact age', () => {
    render(
      <WorkspaceSessionList
        sessions={[
          session({
            firstPrompt: 'Compare codeg vs custom APP',
            isRunning: true,
            status: 'inprogress',
          }),
        ]}
        isLoading={false}
        activeSessionId={null}
        activeWorkspaceId="workspace-1"
        onSessionClick={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', {
        name: /Compare codeg vs custom APP.*进行中/,
      })
    ).toBeInTheDocument();
    expect(document.querySelector('.workspace-session-age')).toBeNull();
    expect(
      document.querySelector('.workspace-session-status--inprogress')
    ).not.toBeNull();
  });

  it('colors each session by its workbench status', () => {
    const main = workspace({ id: 'ws-main', branch: 'main' });
    render(
      <WorkspaceSessionList
        sessions={[
          session({
            id: 'todo-session',
            workspace: main,
            firstPrompt: 'Todo session prompt',
            status: 'todo',
          }),
          session({
            id: 'review-session',
            workspace: main,
            firstPrompt: 'Review session prompt',
            status: 'inreview',
            updatedAt: '2026-08-17T11:00:00Z',
          }),
        ]}
        isLoading={false}
        activeSessionId={null}
        activeWorkspaceId="ws-main"
        onSessionClick={vi.fn()}
      />
    );

    expect(
      document.querySelector('.workspace-session-status--todo')
    ).not.toBeNull();
    expect(
      document.querySelector('.workspace-session-status--inreview')
    ).not.toBeNull();
  });

  it('keeps the selected row inside the workspace rail', () => {
    render(
      <WorkspaceSessionList
        sessions={[
          session({
            firstPrompt: 'Compare codeg vs custom APP',
          }),
        ]}
        isLoading={false}
        activeSessionId="session-1"
        activeWorkspaceId="workspace-1"
        onSessionClick={vi.fn()}
      />
    );

    const selected = document.querySelector(
      '.workspace-session-row.is-selected'
    );
    expect(selected?.closest('.workspace-session-rail')).not.toBeNull();
  });

  it('renders a saved session order inside a workspace', () => {
    localStorage.setItem(
      WORKSPACE_SESSION_ORDER_KEY,
      JSON.stringify({ 'workspace-1': ['older', 'newer'] })
    );

    render(
      <WorkspaceSessionList
        sessions={[
          session({
            id: 'newer',
            firstPrompt: 'Newer session prompt',
            updatedAt: '2026-08-17T12:00:00Z',
          }),
          session({
            id: 'older',
            firstPrompt: 'Older session prompt',
            updatedAt: '2026-08-17T10:00:00Z',
          }),
        ]}
        isLoading={false}
        activeSessionId={null}
        activeWorkspaceId="workspace-1"
        onSessionClick={vi.fn()}
      />
    );

    const titles = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => label.includes('session prompt'));

    expect(titles[0]).toMatch(/Older session prompt/);
    expect(titles[1]).toMatch(/Newer session prompt/);
  });

  it('reveals pin and archive actions on hover', () => {
    const onPinSession = vi.fn();
    const onArchiveSession = vi.fn();
    render(
      <WorkspaceSessionList
        sessions={[
          session({
            firstPrompt: 'Compare codeg vs custom APP',
          }),
        ]}
        isLoading={false}
        activeSessionId={null}
        activeWorkspaceId="workspace-1"
        onSessionClick={vi.fn()}
        onPinSession={onPinSession}
        onArchiveSession={onArchiveSession}
      />
    );

    fireEvent.mouseEnter(document.querySelector('.workspace-session-row')!);
    fireEvent.click(screen.getByRole('button', { name: '置顶' }));
    fireEvent.click(screen.getByRole('button', { name: '归档' }));

    expect(onPinSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      true
    );
    expect(onArchiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' })
    );
  });
});
