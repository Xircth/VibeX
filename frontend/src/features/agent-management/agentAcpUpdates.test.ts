import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView, AgentUpdateCheckView } from 'shared/types';

import {
  CHECK_TTL_MS,
  invalidateAgentAcpUpdate,
  readCachedAgentAcpUpdates,
  recordAgentAcpUpdateCheck,
  refreshAgentAcpUpdates,
  resetAgentAcpUpdatesForTests,
  subscribeAgentAcpUpdates,
} from './agentAcpUpdates';

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

describe('agent ACP update cache', () => {
  beforeEach(() => {
    resetAgentAcpUpdatesForTests();
    checkUpdate.mockReset();
  });

  afterEach(() => {
    resetAgentAcpUpdatesForTests();
  });

  it('records an ACP update and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentAcpUpdates(listener);

    recordAgentAcpUpdateCheck(updateCheck(), '1.1.0');

    expect(readCachedAgentAcpUpdates()).toEqual({
      codex: true,
    });
    expect(listener).toHaveBeenCalledWith({ codex: true });
    unsubscribe();
  });

  it('checks enabled Agents and skips Agents that cannot be updated in place', async () => {
    checkUpdate.mockImplementation(async (agentId: string) =>
      updateCheck({
        agent_id: agentId,
        update_available: agentId === 'codex',
        acp_available: agentId === 'codex' ? '1.7.0' : '1.1.0',
        acp_current: '1.1.0',
      })
    );

    const available = await refreshAgentAcpUpdates([
      agent({ agent_id: 'codex' }),
      agent({ agent_id: 'claude_code', acp_version: '1.1.0' }),
      agent({ agent_id: 'opencode', enabled: false }),
      agent({ agent_id: 'pi', lifecycle: 'uninstalled' }),
    ]);

    expect(available).toEqual({ codex: true });
    expect(checkUpdate).toHaveBeenCalledTimes(2);
    expect(checkUpdate).toHaveBeenCalledWith('codex');
    expect(checkUpdate).toHaveBeenCalledWith('claude_code');
  });

  it('reuses a fresh cache instead of checking again', async () => {
    checkUpdate.mockResolvedValue(updateCheck());
    const agents = [agent({ agent_id: 'codex' })];

    await refreshAgentAcpUpdates(agents);
    checkUpdate.mockClear();
    const available = await refreshAgentAcpUpdates(agents);

    expect(available).toEqual({ codex: true });
    expect(checkUpdate).not.toHaveBeenCalled();
  });

  it('rechecks when the installed ACP version changes', async () => {
    checkUpdate.mockResolvedValueOnce(updateCheck()).mockResolvedValueOnce(
      updateCheck({
        update_available: false,
        acp_current: '1.7.0',
        acp_available: '1.7.0',
      })
    );

    await refreshAgentAcpUpdates([agent({ agent_id: 'codex' })]);
    const available = await refreshAgentAcpUpdates([
      agent({ agent_id: 'codex', acp_version: '1.7.0' }),
    ]);

    expect(available).toEqual({});
    expect(checkUpdate).toHaveBeenCalledTimes(2);
  });

  it('clears a cached update when the Agent starts updating', async () => {
    checkUpdate.mockResolvedValue(updateCheck());
    await refreshAgentAcpUpdates([agent({ agent_id: 'codex' })]);
    expect(readCachedAgentAcpUpdates()).toEqual({ codex: true });

    invalidateAgentAcpUpdate('codex');
    expect(readCachedAgentAcpUpdates()).toEqual({});
  });

  it('does not cache a failed check as up to date', async () => {
    checkUpdate.mockRejectedValue(new Error('offline'));

    const available = await refreshAgentAcpUpdates([
      agent({ agent_id: 'codex' }),
    ]);

    expect(available).toEqual({});
    expect(readCachedAgentAcpUpdates()).toEqual({});
  });

  it('expires cached results after the TTL', async () => {
    vi.useFakeTimers();
    try {
      checkUpdate.mockResolvedValue(updateCheck());
      const agents = [agent({ agent_id: 'codex' })];

      await refreshAgentAcpUpdates(agents);
      checkUpdate.mockClear();
      vi.advanceTimersByTime(CHECK_TTL_MS + 1);
      await refreshAgentAcpUpdates(agents);

      expect(checkUpdate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
