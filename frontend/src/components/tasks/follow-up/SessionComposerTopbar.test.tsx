import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspaceSessionSummary } from '@/hooks/useWorkspaceSessions';
import { SessionComposerTopbar } from './SessionComposerTopbar';

function sessionSummary(
  overrides: Partial<WorkspaceSessionSummary> = {}
): WorkspaceSessionSummary {
  return {
    id: 'session-1',
    workspace_id: 'workspace-1',
    task_id: null,
    taskId: null,
    name: null,
    initial_prompt: null,
    status: 'todo',
    executor: null,
    external_session_id: null,
    agent_type: null,
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:00.000Z',
    firstPrompt: null,
    isRunning: false,
    queueStatus: null,
    displayName: 'Main session',
    workspaceName: null,
    workspaceBranch: 'main',
    statusLabel: 'active',
    continuityMode: 'resume_in_place',
    continuityLabel: 'current',
    ...overrides,
  };
}

function renderTopbar(
  props: Partial<Parameters<typeof SessionComposerTopbar>[0]> = {}
) {
  return render(
    <TooltipProvider>
      <SessionComposerTopbar
        executorProfile={null}
        sessionExecutor={null}
        showChangedFileSummary={false}
        changedFileCount={0}
        added={0}
        deleted={0}
        codexGoalState={null}
        tokenUsageInfo={null}
        todos={[]}
        showSessionSelector={false}
        sessions={[]}
        selectedSessionId={undefined}
        compactSessionLabel="Session"
        selectedSessionLabel="Session"
        onJumpToPreviousUserMessage={undefined}
        onSelectSession={vi.fn()}
        onStartNewSession={vi.fn()}
        onRenameSession={vi.fn()}
        {...props}
      />
    </TooltipProvider>
  );
}

describe('SessionComposerTopbar', () => {
  it('renders file summary, todo status, and jump control behavior', () => {
    const onJump = vi.fn();

    renderTopbar({
      showChangedFileSummary: true,
      changedFileCount: 3,
      added: 12,
      deleted: 4,
      todos: [{ content: 'Review topbar', status: 'completed', priority: null }],
      onJumpToPreviousUserMessage: onJump,
    });

    expect(screen.getByText('3 \u4e2a\u6587\u4ef6\u66f4\u6539')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: '\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f',
      })
    );

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('gates the session selector and disabled jump control', () => {
    const onSelectSession = vi.fn();

    renderTopbar({
      showSessionSelector: true,
      sessions: [sessionSummary()],
      selectedSessionId: 'session-1',
      compactSessionLabel: 'Main',
      selectedSessionLabel: 'Main session',
      onSelectSession,
    });

    expect(screen.getByTitle('Main session')).toBeInTheDocument();

    const jumpButton = screen.getByRole('button', {
      name: '\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f',
    });
    expect(jumpButton).toBeDisabled();

    expect(onSelectSession).not.toHaveBeenCalled();
  });
});
