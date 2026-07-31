import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { useSelectableAgents } from './useSelectableAgents';

const bar = vi.fn();

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    bar: (...args: unknown[]) => bar(...args),
  },
}));

function managedAgent(
  agentId: string,
  overrides: Partial<AgentManagementView> = {}
): AgentManagementView {
  return {
    agent_id: agentId,
    display_name: agentId,
    description: '',
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: 'official_registry',
    built_in: false,
    retired: false,
    enabled: true,
    position: 0,
    lifecycle: 'ready',
    authentication: 'not_logged_in',
    runtime_version: '1.0.0',
    acp_version: '1.0.0',
    active_operation: null,
    rollback_available: false,
    ...overrides,
  };
}

describe('useSelectableAgents', () => {
  beforeEach(() => {
    bar.mockReset();
  });

  it('uses the management projection and includes a ready generic AgentId', async () => {
    bar.mockResolvedValue([
      managedAgent('vendor.agent', { display_name: 'Vendor Agent' }),
    ]);

    const { result } = renderHook(() => useSelectableAgents());
    await waitFor(() => expect(result.current).toHaveLength(1));

    expect(result.current[0]).toMatchObject({
      agentId: 'vendor.agent',
      displayName: 'Vendor Agent',
      enabled: true,
      runnable: true,
    });
  });

  it('keeps visible non-ready Agents but does not mark them runnable', async () => {
    bar.mockResolvedValue([
      managedAgent('codex', {
        lifecycle: 'needs_repair',
        active_operation: 'repair',
      }),
    ]);

    const { result } = renderHook(() => useSelectableAgents());
    await waitFor(() => expect(result.current).toHaveLength(1));

    expect(result.current[0]).toMatchObject({
      agentId: 'codex',
      enabled: true,
      lifecycle: 'needs_repair',
      runnable: false,
    });
  });
});
