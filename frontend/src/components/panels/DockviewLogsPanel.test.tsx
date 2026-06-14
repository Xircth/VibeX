import { render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from 'shared/types';
import DockviewLogsPanel from './DockviewLogsPanel';

const { useTaskAttemptWithSessionMock, useWorktreeMock } = vi.hoisted(() => ({
  useTaskAttemptWithSessionMock: vi.fn(),
  useWorktreeMock: vi.fn(() => ({ activeWorktreeId: 'workspace-1' })),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: useWorktreeMock,
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttemptWithSession: useTaskAttemptWithSessionMock,
}));

vi.mock('@/contexts/EntriesContext', () => ({
  EntriesProvider: ({
    children,
    runtimeKey,
  }: {
    children: ReactNode;
    runtimeKey?: string;
  }) => (
    <div data-testid="entries-provider" data-runtime-key={runtimeKey}>
      {children}
    </div>
  ),
}));

vi.mock('@/contexts/ExecutionProcessesContext', () => ({
  ExecutionProcessesProvider: ({ children }: { children: ReactNode }) =>
    children,
}));

vi.mock('@/contexts/RetryUiContext', () => ({
  RetryUiProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/components/logs/VirtualizedList', () => ({
  default: ({
    attempt,
  }: {
    attempt: { id: string; session?: { id?: string } | undefined };
  }) => (
    <div data-testid="virtualized-list">
      {attempt.id}:{attempt.session?.id ?? 'none'}
    </div>
  ),
}));

function createAttempt(session?: Session): Workspace & { session?: Session } {
  return {
    id: 'workspace-1',
    project_id: 'project-1',
    task_id: 'task-1',
    parent_workspace_id: null,
    container_ref: null,
    branch: 'main',
    use_worktree: true,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    archived: false,
    pinned: false,
    name: null,
    session,
  };
}

function renderPanel() {
  return render(<DockviewLogsPanel {...({} as IDockviewPanelProps)} />);
}

describe('DockviewLogsPanel', () => {
  it('uses the shared session conversation cache key without a logs suffix', () => {
    const session: Session = {
      id: 'session-1',
      workspace_id: 'workspace-1',
      task_id: 'task-1',
      name: null,
      initial_prompt: null,
      status: 'todo',
      executor: null,
      external_session_id: null,
      agent_type: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    };
    useTaskAttemptWithSessionMock.mockReturnValue({
      data: createAttempt(session),
      isLoading: false,
    });

    renderPanel();

    expect(screen.getByTestId('virtualized-list')).toHaveTextContent(
      'workspace-1:session-1'
    );
    expect(screen.getByTestId('entries-provider')).toHaveAttribute(
      'data-runtime-key',
      'workspace-1:session-1'
    );
  });

  it('uses the same no-session cache key as conversation history', () => {
    useTaskAttemptWithSessionMock.mockReturnValue({
      data: createAttempt(),
      isLoading: false,
    });

    renderPanel();

    expect(screen.getByTestId('entries-provider')).toHaveAttribute(
      'data-runtime-key',
      'workspace-1:no-session'
    );
  });
});
