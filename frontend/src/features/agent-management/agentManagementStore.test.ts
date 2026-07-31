import { describe, expect, it } from 'vitest';
import type {
  AgentManagementView,
  AgentOperationEvent,
  AgentRegistryViewRow,
} from 'shared/types';

import {
  createAgentManagementState,
  mergeManagementSnapshot,
  optimisticAddRegistryAgent,
  reduceOperationEvent,
} from './agentManagementStore';

const codex: AgentManagementView = {
  agent_id: 'codex',
  display_name: 'Codex',
  description: 'Codex ACP',
  icon_light: '/agents/codex-light.svg',
  icon_dark: '/agents/codex-dark.svg',
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
};

const generic: AgentRegistryViewRow = {
  agent_id: 'vendor.agent',
  registry_id: 'vendor.agent',
  authors: [],
  display_name: 'Vendor Agent',
  description: 'Generic ACP Agent',
  version: '2.0.0',
  icon_light: null,
  icon_dark: null,
  icon_svg: null,
  built_in: false,
  added: false,
  installed: false,
  platform_supported: true,
};

describe('agentManagementStore', () => {
  it('reduces operation events, optimistic add, and authoritative refreshes', () => {
    const initial = createAgentManagementState([codex]);
    const optimistic = optimisticAddRegistryAgent(initial, generic);
    expect(optimistic.agents.map((agent) => agent.agent_id)).toEqual([
      'codex',
      'vendor.agent',
    ]);
    expect(optimistic.selectedAgentId).toBe('vendor.agent');
    expect(optimistic.agents[1].lifecycle).toBe('queued');

    const event: AgentOperationEvent = {
      sequence: 7,
      agent_id: 'vendor.agent',
      operation_id: 'operation-1',
      kind: 'install',
      status: 'running',
      progress_percent: 30,
      message: 'installing',
    };
    const running = reduceOperationEvent(optimistic, event);
    expect(running.operations['vendor.agent']?.progressPercent).toBe(30);
    expect(running.agents[1].lifecycle).toBe('installing');

    const stale = reduceOperationEvent(running, { ...event, sequence: 6 });
    expect(stale).toBe(running);

    const refreshed = mergeManagementSnapshot(running, [
      codex,
      {
        ...running.agents[1],
        lifecycle: 'needs_auth',
        authentication: 'not_logged_in',
        active_operation: null,
      },
    ]);
    expect(refreshed.agents[1].lifecycle).toBe('needs_auth');
    expect(refreshed.operations['vendor.agent']).toBeUndefined();
    expect(refreshed.snapshotRevision).toBe(initial.snapshotRevision + 1);
  });
});
