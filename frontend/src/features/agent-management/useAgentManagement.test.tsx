import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentOperationEvent } from 'shared/types';
import { beforeEach, expect, it, vi } from 'vitest';

import { useAgentManagement } from './useAgentManagement';

const mocks = vi.hoisted(() => ({
  bar: vi.fn(),
  listener: null as ((event: AgentOperationEvent) => void) | null,
  toastError: vi.fn(),
}));

vi.mock('./api', () => ({
  agentManagementApi: {
    bar: mocks.bar,
  },
}));

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(
    async (_event: string, listener: (event: AgentOperationEvent) => void) => {
      mocks.listener = listener;
      return vi.fn();
    }
  ),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

beforeEach(() => {
  mocks.bar.mockReset();
  mocks.bar.mockResolvedValue([]);
  mocks.listener = null;
  mocks.toastError.mockReset();
});

it('surfaces an asynchronous Agent installation failure', async () => {
  renderHook(() => useAgentManagement());
  await waitFor(() => expect(mocks.listener).not.toBeNull());

  await act(async () => {
    mocks.listener?.({
      sequence: 1,
      agent_id: 'grok-build',
      operation_id: 'operation-1',
      kind: 'repair',
      status: 'failed',
      progress_percent: null,
      message:
        'npm package `@xai-official/grok` did not create executable `grok`',
    });
  });

  expect(mocks.toastError).toHaveBeenCalledWith(
    'npm package `@xai-official/grok` did not create executable `grok`'
  );
});
