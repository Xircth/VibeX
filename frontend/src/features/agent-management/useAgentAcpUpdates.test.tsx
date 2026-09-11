import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView, AgentUpdateCheckView } from 'shared/types';

import { resetAgentAcpUpdatesForTests } from './agentAcpUpdates';
import { useAgentAcpUpdates } from './useAgentAcpUpdates';

const checkUpdate = vi.hoisted(() => vi.fn());

vi.mock('./api', () => ({
  agentManagementApi: {
    checkUpdate: (...args: unknown[]) => checkUpdate(...args),
  },
}));

function agent(
  overrides: Partial<AgentManagementView> &
    Pick<AgentManagementView, 'agent_id'>
): AgentManagementView {
  return {
    display_name: overrides.agent_id,
    description: '',
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
    runtime_version: null,
    acp_version: '1.1.0',
    active_operation: null,
    rollback_available: false,
    ...overrides,
  };
}

function updateCheck(
  overrides: Partial<AgentUpdateCheckView> = {}
): AgentUpdateCheckView {
  return {
    agent_id: 'codex',
    current_version: '1.1.0',
    available_version: '1.7.0',
    update_available: true,
    acp_current: '1.1.0',
    acp_available: '1.7.0',
    snapshot_id: null,
    fetched_at: null,
    fresh: true,
    ...overrides,
  };
}

describe('useAgentAcpUpdates', () => {
  beforeEach(() => {
    resetAgentAcpUpdatesForTests();
    checkUpdate.mockReset();
    checkUpdate.mockResolvedValue(updateCheck());
  });

  afterEach(() => {
    resetAgentAcpUpdatesForTests();
  });

  it('exposes Agent ids whose ACP adapter can be updated', async () => {
    const { result } = renderHook(() =>
      useAgentAcpUpdates([
        agent({ agent_id: 'codex' }),
        agent({ agent_id: 'claude_code' }),
      ])
    );

    await waitFor(() => expect(result.current.has('codex')).toBe(true));
    expect(checkUpdate).toHaveBeenCalled();
  });

  it('hides a pending update while that Agent is updating', async () => {
    const { result, rerender } = renderHook(
      ({ agents }) => useAgentAcpUpdates(agents),
      { initialProps: { agents: [agent({ agent_id: 'codex' })] } }
    );

    await waitFor(() => expect(result.current.has('codex')).toBe(true));

    rerender({
      agents: [
        agent({
          agent_id: 'codex',
          lifecycle: 'updating',
          active_operation: 'update',
        }),
      ],
    });

    await waitFor(() => expect(result.current.has('codex')).toBe(false));
  });

  it('drops an Agent after a successful update changes its ACP version', async () => {
    const initial = [agent({ agent_id: 'codex' })];
    const { result, rerender } = renderHook(
      ({ agents }) => useAgentAcpUpdates(agents),
      { initialProps: { agents: initial } }
    );

    await waitFor(() => expect(result.current.has('codex')).toBe(true));

    checkUpdate.mockResolvedValue(
      updateCheck({
        update_available: false,
        acp_current: '1.7.0',
        acp_available: '1.7.0',
      })
    );

    rerender({
      agents: [agent({ agent_id: 'codex', acp_version: '1.7.0' })],
    });

    await waitFor(() => expect(result.current.has('codex')).toBe(false));
  });

  it('stays empty when no Agent is checkable', async () => {
    const { result } = renderHook(() =>
      useAgentAcpUpdates([
        agent({ agent_id: 'opencode', enabled: false }),
        agent({ agent_id: 'pi', lifecycle: 'uninstalled' }),
      ])
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.size).toBe(0);
    expect(checkUpdate).not.toHaveBeenCalled();
  });
});
