import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionProcessStatus } from 'shared/types';
import { useConversationHistory } from './useConversationHistory';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';

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

  it('在卸载时关闭运行中的会话流订阅', async () => {
    const close = vi.fn();

    vi.mocked(useEntries).mockReturnValue({
      entries: [],
      setEntries: vi.fn(),
      setTokenUsageInfo: vi.fn(),
      reset: vi.fn(),
      tokenUsageInfo: null,
    });

    vi.mocked(useExecutionProcessesContext).mockReturnValue({
      executionProcessesVisible: [
        {
          id: 'proc-1',
          status: ExecutionProcessStatus.running,
          run_reason: 'codingagent',
          created_at: '2026-03-22T00:00:00.000Z',
          updated_at: '2026-03-22T00:00:00.000Z',
          executor_action: {
            typ: {
              type: 'CodingAgentInitialRequest',
              prompt: 'hello',
            },
          },
        },
      ],
      isLoading: false,
    } as any);

    vi.mocked(streamJsonPatchEntries).mockReturnValue({
      getEntries: () => [],
      getSnapshot: () => ({ entries: [] }),
      isConnected: () => true,
      onChange: () => () => undefined,
      close,
    });

    const { unmount } = renderHook(() =>
      useConversationHistory({
        attempt: {
          id: 'workspace-1',
          session: undefined,
        } as any,
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
