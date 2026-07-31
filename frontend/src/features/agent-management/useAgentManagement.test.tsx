import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useAgentManagement } from './useAgentManagement';

const mocks = vi.hoisted(() => ({
  bar: vi.fn(),
  refreshBar: vi.fn(),
  listeners: new Map<string, (event: unknown) => void>(),
  sequence: [] as string[],
  toastError: vi.fn(),
}));

vi.mock('./api', () => ({
  agentManagementApi: {
    bar: mocks.bar,
    refreshBar: mocks.refreshBar,
  },
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriListen: vi.fn(
    async (event: string, listener: (event: unknown) => void) => {
      mocks.sequence.push(`listen:${event}`);
      mocks.listeners.set(event, listener);
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
  mocks.sequence.length = 0;
  mocks.bar.mockReset();
  mocks.bar.mockImplementation(async () => {
    mocks.sequence.push('bar');
    return [];
  });
  mocks.refreshBar.mockReset();
  mocks.refreshBar.mockResolvedValue([]);
  mocks.listeners.clear();
  mocks.toastError.mockReset();
});

it('subscribes to snapshot invalidation before reading the initial snapshot', async () => {
  renderHook(() => useAgentManagement());

  await waitFor(() => expect(mocks.bar).toHaveBeenCalledTimes(1));
  expect(
    mocks.sequence.indexOf('listen:agent-management-snapshot-invalidated')
  ).toBeLessThan(mocks.sequence.indexOf('bar'));
});

it('surfaces an asynchronous Agent installation failure', async () => {
  renderHook(() => useAgentManagement());
  await waitFor(() =>
    expect(mocks.listeners.has('agent-management-event')).toBe(true)
  );

  await act(async () => {
    mocks.listeners.get('agent-management-event')?.({
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

it('runs expensive evidence refresh only when explicitly requested', async () => {
  const { result } = renderHook(() => useAgentManagement());
  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    await result.current.refreshFresh();
  });

  expect(mocks.bar).toHaveBeenCalledTimes(1);
  expect(mocks.refreshBar).toHaveBeenCalledTimes(1);
});

it('re-reads the fast snapshot when startup warmup finishes', async () => {
  const { result } = renderHook(() => useAgentManagement());
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() =>
    expect(mocks.listeners.has('agent-management-snapshot-invalidated')).toBe(
      true
    )
  );
  mocks.bar.mockResolvedValue([
    {
      agent_id: 'codex',
      display_name: 'Codex',
      description: 'Codex ACP',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'ready',
      authentication: 'account',
      runtime_version: '1.0.0',
      acp_version: '1.0.0',
      active_operation: null,
      rollback_available: false,
    },
  ]);

  await act(async () => {
    mocks.listeners.get('agent-management-snapshot-invalidated')?.(undefined);
  });

  await waitFor(() => expect(result.current.state.agents).toHaveLength(1));
  expect(mocks.bar).toHaveBeenCalledTimes(2);
});
