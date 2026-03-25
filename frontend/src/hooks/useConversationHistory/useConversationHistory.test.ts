import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import { BaseCodingAgent, ExecutionProcessStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';
import { useConversationHistory } from './useConversationHistory';

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
  };
});

vi.mock('@/contexts/ExecutionProcessesContext', () => ({
  useExecutionProcessesContext: vi.fn(),
}));

vi.mock('@/contexts/EntriesContext', () => ({
  useEntries: vi.fn(),
}));

vi.mock('@/utils/streamJsonPatchEntries', () => ({
  streamJsonPatchEntries: vi.fn(),
}));

describe('useConversationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the active session stream on unmount', async () => {
    const close = vi.fn();
    const runningProcess: ExecutionProcess = {
      id: 'proc-1',
      session_id: 'session-1',
      run_reason: 'codingagent',
      executor_action: {
        typ: {
          type: 'CodingAgentInitialRequest',
          prompt: 'hello',
          executor_profile_id: {
            executor: BaseCodingAgent.CODEX,
            variant: null,
          },
          working_dir: null,
        },
        next_action: null,
      },
      status: ExecutionProcessStatus.running,
      exit_code: null,
      dropped: false,
      started_at: '2026-03-22T00:00:00.000Z',
      completed_at: null,
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
    };
    const attempt: WorkspaceWithSession = {
      id: 'workspace-1',
      task_id: 'task-1',
      container_ref: null,
      branch: 'main',
      use_worktree: true,
      agent_working_dir: null,
      setup_completed_at: null,
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
      archived: false,
      pinned: false,
      name: null,
      session: undefined,
    };

    vi.mocked(useEntries).mockReturnValue({
      entries: [],
      setEntries: vi.fn(),
      setTokenUsageInfo: vi.fn(),
      reset: vi.fn(),
      tokenUsageInfo: null,
    });

    vi.mocked(useExecutionProcessesContext).mockReturnValue({
      executionProcessesAll: [runningProcess],
      executionProcessesByIdAll: { 'proc-1': runningProcess },
      isAttemptRunningAll: true,
      executionProcessesVisible: [runningProcess],
      executionProcessesByIdVisible: { 'proc-1': runningProcess },
      isAttemptRunningVisible: true,
      isLoading: false,
      isConnected: true,
      error: null,
    });

    vi.mocked(streamJsonPatchEntries).mockReturnValue({
      getEntries: () => [],
      getSnapshot: () => ({ entries: [] }),
      isConnected: () => true,
      onChange: () => () => undefined,
      close,
    });

    const { unmount } = renderHook(() =>
      useConversationHistory({
        attempt,
        onEntriesUpdated: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
