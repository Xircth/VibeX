import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import { BaseCodingAgent, ExecutionProcessStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';
import {
  stripPreviouslyDisplayedAssistantPrefix,
  useConversationHistory,
} from './useConversationHistory';

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('strips assistant transcript replay prefixes from later ACP turns', () => {
    const firstReply =
      'I checked the frontend startup path and found the dev server.';
    const secondReply =
      'I will now restart the backend and verify the frontend URL.';

    expect(
      stripPreviouslyDisplayedAssistantPrefix(
        `${firstReply}\n\n${secondReply}`,
        firstReply
      )
    ).toBe(secondReply);
    expect(
      stripPreviouslyDisplayedAssistantPrefix(secondReply, firstReply)
    ).toBe(secondReply);
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
      project_id: 'project-1',
      task_id: 'task-1',
      parent_workspace_id: null,
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

  it('keeps waiting for delayed historic entries instead of settling empty too early', async () => {
    vi.useFakeTimers();

    const completedProcess: ExecutionProcess = {
      id: 'proc-historic',
      session_id: 'session-1',
      run_reason: 'codingagent',
      executor_action: {
        typ: {
          type: 'CodingAgentInitialRequest',
          prompt: 'historic prompt',
          executor_profile_id: {
            executor: BaseCodingAgent.CODEX,
            variant: null,
          },
          working_dir: null,
        },
        next_action: null,
      },
      status: ExecutionProcessStatus.completed,
      exit_code: BigInt(0),
      dropped: false,
      started_at: '2026-03-22T00:00:00.000Z',
      completed_at: '2026-03-22T00:00:05.000Z',
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:05.000Z',
    };
    const attempt: WorkspaceWithSession = {
      id: 'workspace-1',
      project_id: 'project-1',
      task_id: 'task-1',
      parent_workspace_id: null,
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
      session: {
        id: 'session-1',
        workspace_id: 'workspace-1',
        task_id: 'task-1',
        name: null,
        initial_prompt: null,
        status: 'todo',
        executor: BaseCodingAgent.CODEX,
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
      },
    };
    const onEntriesUpdated = vi.fn();

    vi.mocked(useEntries).mockReturnValue({
      entries: [],
      setEntries: vi.fn(),
      setTokenUsageInfo: vi.fn(),
      reset: vi.fn(),
      tokenUsageInfo: null,
    });

    vi.mocked(useExecutionProcessesContext).mockReturnValue({
      executionProcessesAll: [completedProcess],
      executionProcessesByIdAll: { 'proc-historic': completedProcess },
      isAttemptRunningAll: false,
      executionProcessesVisible: [completedProcess],
      executionProcessesByIdVisible: { 'proc-historic': completedProcess },
      isAttemptRunningVisible: false,
      isLoading: false,
      isConnected: true,
      error: null,
    });

    vi.mocked(streamJsonPatchEntries).mockImplementation((_, opts) => {
      setTimeout(() => {
        opts?.onFinished?.([
          {
            type: 'NORMALIZED_ENTRY',
            content: {
              entry_type: { type: 'assistant_message' },
              content: 'historic reply',
              timestamp: null,
            },
          } as never,
        ]);
      }, 3500);

      return {
        getEntries: () => [],
        getSnapshot: () => ({ entries: [] }),
        isConnected: () => true,
        onChange: () => () => undefined,
        close: vi.fn(),
      };
    });

    renderHook(() =>
      useConversationHistory({
        attempt,
        onEntriesUpdated,
      })
    );

    await vi.advanceTimersByTimeAsync(3500);
    await Promise.resolve();

    expect(
      onEntriesUpdated.mock.calls.some(([entries]) =>
        entries.some(
          (entry: (typeof entries)[number]) =>
            entry.type === 'NORMALIZED_ENTRY' &&
            entry.content.entry_type.type === 'assistant_message' &&
            entry.content.content === 'historic reply'
        )
      )
    ).toBe(true);
  }, 15000);

  it('loads a completed process that first appears after the initial history pass', async () => {
    const onEntriesUpdated = vi.fn();
    const completedProcess: ExecutionProcess = {
      id: 'proc-late-complete',
      session_id: 'session-1',
      run_reason: 'codingagent',
      executor_action: {
        typ: {
          type: 'CodingAgentInitialRequest',
          prompt: 'late prompt',
          executor_profile_id: {
            executor: BaseCodingAgent.CODEX,
            variant: null,
          },
          working_dir: null,
        },
        next_action: null,
      },
      status: ExecutionProcessStatus.completed,
      exit_code: BigInt(0),
      dropped: false,
      started_at: '2026-03-22T00:00:00.000Z',
      completed_at: '2026-03-22T00:00:05.000Z',
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:05.000Z',
    };
    const attempt: WorkspaceWithSession = {
      id: 'workspace-1',
      project_id: 'project-1',
      task_id: 'task-1',
      parent_workspace_id: null,
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
      session: {
        id: 'session-1',
        workspace_id: 'workspace-1',
        task_id: 'task-1',
        name: null,
        initial_prompt: null,
        status: 'todo',
        executor: BaseCodingAgent.CODEX,
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
      },
    };

    let visibleProcesses: ExecutionProcess[] = [];

    vi.mocked(useEntries).mockReturnValue({
      entries: [],
      setEntries: vi.fn(),
      setTokenUsageInfo: vi.fn(),
      reset: vi.fn(),
      tokenUsageInfo: null,
    });

    vi.mocked(useExecutionProcessesContext).mockImplementation(() => ({
      executionProcessesAll: visibleProcesses,
      executionProcessesByIdAll: Object.fromEntries(
        visibleProcesses.map((process) => [process.id, process])
      ),
      isAttemptRunningAll: visibleProcesses.some(
        (process) => process.status === ExecutionProcessStatus.running
      ),
      executionProcessesVisible: visibleProcesses,
      executionProcessesByIdVisible: Object.fromEntries(
        visibleProcesses.map((process) => [process.id, process])
      ),
      isAttemptRunningVisible: visibleProcesses.some(
        (process) => process.status === ExecutionProcessStatus.running
      ),
      isLoading: false,
      isConnected: true,
      error: null,
    }));

    vi.mocked(streamJsonPatchEntries).mockImplementation((params, opts) => {
      if (params.executionProcessId === completedProcess.id) {
        queueMicrotask(() => {
          opts?.onFinished?.([
            {
              type: 'NORMALIZED_ENTRY',
              content: {
                entry_type: { type: 'assistant_message' },
                content: 'late completed reply',
                timestamp: null,
              },
            } as never,
          ]);
        });
      }

      return {
        getEntries: () => [],
        getSnapshot: () => ({ entries: [] }),
        isConnected: () => true,
        onChange: () => () => undefined,
        close: vi.fn(),
      };
    });

    const { rerender } = renderHook(() =>
      useConversationHistory({
        attempt,
        onEntriesUpdated,
      })
    );

    await waitFor(() => {
      expect(onEntriesUpdated).toHaveBeenCalled();
    });

    visibleProcesses = [completedProcess];
    rerender();

    await waitFor(() => {
      expect(
        onEntriesUpdated.mock.calls.some(([entries]) =>
          entries.some(
            (entry: (typeof entries)[number]) =>
              entry.type === 'NORMALIZED_ENTRY' &&
              entry.content.entry_type.type === 'assistant_message' &&
              entry.content.content === 'late completed reply'
          )
        )
      ).toBe(true);
    });
  });

  it('drops loading immediately when a live process stops and keeps streamed file edits visible', async () => {
    const onEntriesUpdated = vi.fn();
    const liveStreamClose = vi.fn();
    let liveStreamOptions:
      | Parameters<typeof streamJsonPatchEntries>[1]
      | undefined;

    const runningProcess: ExecutionProcess = {
      id: 'proc-live',
      session_id: 'session-1',
      run_reason: 'codingagent',
      executor_action: {
        typ: {
          type: 'CodingAgentInitialRequest',
          prompt: 'fix the bug',
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
    const completedProcess: ExecutionProcess = {
      ...runningProcess,
      status: ExecutionProcessStatus.completed,
      exit_code: BigInt(0),
      completed_at: '2026-03-22T00:00:05.000Z',
      updated_at: '2026-03-22T00:00:05.000Z',
    };
    const attempt: WorkspaceWithSession = {
      id: 'workspace-1',
      project_id: 'project-1',
      task_id: 'task-1',
      parent_workspace_id: null,
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
      session: {
        id: 'session-1',
        workspace_id: 'workspace-1',
        task_id: 'task-1',
        name: null,
        initial_prompt: null,
        status: 'todo',
        executor: BaseCodingAgent.CODEX,
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
      },
    };

    let visibleProcesses: ExecutionProcess[] = [runningProcess];

    vi.mocked(useEntries).mockReturnValue({
      entries: [],
      setEntries: vi.fn(),
      setTokenUsageInfo: vi.fn(),
      reset: vi.fn(),
      tokenUsageInfo: null,
    });

    vi.mocked(useExecutionProcessesContext).mockImplementation(() => ({
      executionProcessesAll: visibleProcesses,
      executionProcessesByIdAll: Object.fromEntries(
        visibleProcesses.map((process) => [process.id, process])
      ),
      isAttemptRunningAll: visibleProcesses.some(
        (process) => process.status === ExecutionProcessStatus.running
      ),
      executionProcessesVisible: visibleProcesses,
      executionProcessesByIdVisible: Object.fromEntries(
        visibleProcesses.map((process) => [process.id, process])
      ),
      isAttemptRunningVisible: visibleProcesses.some(
        (process) => process.status === ExecutionProcessStatus.running
      ),
      isLoading: false,
      isConnected: true,
      error: null,
    }));

    vi.mocked(streamJsonPatchEntries).mockImplementation((_, opts) => {
      liveStreamOptions = opts;

      return {
        getEntries: () => [],
        getSnapshot: () => ({ entries: [] }),
        isConnected: () => true,
        onChange: () => () => undefined,
        close: liveStreamClose,
      };
    });

    const { rerender } = renderHook(() =>
      useConversationHistory({
        attempt,
        onEntriesUpdated,
      })
    );

    await waitFor(() => {
      expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1);
    });

    act(() => {
      liveStreamOptions?.onEntries?.([
        {
          type: 'NORMALIZED_ENTRY',
          content: {
            entry_type: {
              type: 'tool_use',
              tool_name: 'Edit',
              action_type: {
                action: 'file_edit',
                path: 'src/app.ts',
                changes: [
                  {
                    action: 'write',
                    content: 'const fixed = true;\n',
                  },
                ],
              },
              status: {
                status: 'success',
              },
            },
            content: '',
            timestamp: null,
          },
        } as never,
      ]);
    });

    await waitFor(() => {
      expect(
        onEntriesUpdated.mock.calls.some(([entries]) =>
          entries.some(
            (entry: (typeof entries)[number]) =>
              entry.type === 'NORMALIZED_ENTRY' &&
              entry.content.entry_type.type === 'tool_use' &&
              entry.content.entry_type.action_type.action === 'file_edit'
          )
        )
      ).toBe(true);
    });

    const callsBeforeStop = onEntriesUpdated.mock.calls.length;
    visibleProcesses = [completedProcess];
    rerender();

    await waitFor(() => {
      expect(onEntriesUpdated.mock.calls.length).toBeGreaterThan(
        callsBeforeStop
      );
    });

    const latestEntries =
      onEntriesUpdated.mock.calls[
        onEntriesUpdated.mock.calls.length - 1
      ]?.[0] ?? [];

    expect(
      latestEntries.some(
        (entry: (typeof latestEntries)[number]) =>
          entry.type === 'NORMALIZED_ENTRY' &&
          entry.content.entry_type.type === 'loading'
      )
    ).toBe(false);
    expect(
      latestEntries.some(
        (entry: (typeof latestEntries)[number]) =>
          entry.type === 'NORMALIZED_ENTRY' &&
          entry.content.entry_type.type === 'tool_use' &&
          entry.content.entry_type.action_type.action === 'file_edit'
      )
    ).toBe(true);
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1);
    expect(liveStreamClose).toHaveBeenCalledTimes(1);
  });
});
