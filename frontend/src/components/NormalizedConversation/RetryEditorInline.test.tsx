import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RetryEditorInline } from './RetryEditorInline';

const composerSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/tasks/follow-up/SessionComposerInput', () => ({
  SessionComposerInput: (props: Record<string, unknown>) => {
    composerSpy(props);
    return <div data-testid="full-session-composer" />;
  },
}));

vi.mock('@/components/tasks/follow-up/AgentMention', () => ({
  AgentMentionProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock('@/hooks/useAttemptExecution', () => ({
  useAttemptExecution: () => ({
    isAttemptRunning: false,
    attemptData: { processes: [] },
  }),
}));

vi.mock('@/hooks/useBranchStatus', () => ({
  useBranchStatus: () => ({ data: null }),
}));

vi.mock('@/hooks/useRetryProcess', () => ({
  useRetryProcess: () => ({ isPending: false, mutate: vi.fn() }),
}));

describe('RetryEditorInline', () => {
  it('uses the full six-trigger session composer with default submit', () => {
    render(
      <RetryEditorInline
        attempt={
          {
            id: 'workspace-1',
            project_id: 'project-1',
            task_id: 'task-1',
            session: { id: 'session-1', executor: 'codex' },
          } as never
        }
        executionProcessId="process-1"
        initialContent="retry this"
      />
    );

    expect(screen.getByTestId('full-session-composer')).toBeInTheDocument();
    expect(composerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          projectId: 'project-1',
          executorProfile: { executor: 'codex', variant: null },
        }),
      })
    );
  });
});
