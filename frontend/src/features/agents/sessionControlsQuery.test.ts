import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import {
  loadAgentSessionControlsCatalog,
  publishLiveSessionControls,
  sessionControlsQueryKey,
} from './sessionControlsQuery';

const capabilityCatalog = vi.fn();
const refreshCapabilityCatalog = vi.fn();

vi.mock('./api', () => ({
  agentsApi: {
    capabilityCatalog: (...args: unknown[]) => capabilityCatalog(...args),
    refreshCapabilityCatalog: (...args: unknown[]) =>
      refreshCapabilityCatalog(...args),
  },
}));

const CONTROLS: AgentSessionControlsSnapshot = {
  modes: [{ id: 'plan', label: 'Plan', description: null }],
  current_mode: 'plan',
  config_options: [],
};

describe('session controls query cache', () => {
  it('reuses live composer controls only within the same agent and workspace', () => {
    const client = new QueryClient();

    publishLiveSessionControls(client, {
      agentType: 'codex',
      workspaceId: 'workspace-1',
      controls: CONTROLS,
    });

    expect(
      client.getQueryData(sessionControlsQueryKey('codex', 'workspace-1'))
    ).toEqual(CONTROLS);
    expect(
      client.getQueryData(sessionControlsQueryKey('codex', 'workspace-2'))
    ).toBeUndefined();
    expect(
      client.getQueryData(sessionControlsQueryKey('claude_code', 'workspace-1'))
    ).toBeUndefined();
  });
});

describe('loadAgentSessionControlsCatalog', () => {
  beforeEach(() => {
    capabilityCatalog.mockReset();
    refreshCapabilityCatalog.mockReset();
  });

  it('returns a matching persisted catalog without probing', async () => {
    capabilityCatalog.mockResolvedValue(CONTROLS);

    await expect(loadAgentSessionControlsCatalog('grok')).resolves.toEqual(
      CONTROLS
    );
    expect(refreshCapabilityCatalog).not.toHaveBeenCalled();
  });

  it('throws when refresh reports that discovery did not persist a catalog', async () => {
    capabilityCatalog.mockResolvedValue(null);
    refreshCapabilityCatalog.mockResolvedValue(false);

    await expect(loadAgentSessionControlsCatalog('grok')).rejects.toThrow(
      'Agent session controls discovery failed'
    );
  });

  it('reads the catalog after a successful refresh', async () => {
    capabilityCatalog
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CONTROLS);
    refreshCapabilityCatalog.mockResolvedValue(true);

    await expect(loadAgentSessionControlsCatalog('grok')).resolves.toEqual(
      CONTROLS
    );
    expect(refreshCapabilityCatalog).toHaveBeenCalledWith('grok');
  });
});
