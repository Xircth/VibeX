import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import {
  loadAgentSessionControlsCatalog,
  mergeCreateSessionControls,
  publishLiveSessionControls,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
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

  it('publishes an agent-wide schema so every create surface sees live options', () => {
    const client = new QueryClient();
    const withEffort: AgentSessionControlsSnapshot = {
      modes: CONTROLS.modes,
      current_mode: 'plan',
      config_options: [
        {
          key: 'reasoning_effort',
          label: '思考强度',
          category: 'thought_level',
          value: 'high',
          choices: [
            { value: 'low', label: '低' },
            { value: 'high', label: '高' },
          ],
        },
      ],
    };

    publishLiveSessionControls(client, {
      agentType: 'codex',
      workspaceId: 'workspace-1',
      controls: withEffort,
    });

    expect(
      client.getQueryData(sessionControlsSchemaQueryKey('codex'))
    ).toEqual(withEffort);
    expect(
      client.getQueryData(sessionControlsSchemaQueryKey('claude_code'))
    ).toBeUndefined();
  });
});

describe('mergeCreateSessionControls', () => {
  it('adds live effort and fast options onto a catalog that only has model', () => {
    const catalog: AgentSessionControlsSnapshot = {
      modes: [{ id: 'auto', label: 'Auto', description: null }],
      current_mode: 'auto',
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'gpt-6-astra',
          choices: [{ value: 'gpt-6-astra', label: 'gpt-6-astra' }],
        },
      ],
    };
    const live: AgentSessionControlsSnapshot = {
      modes: [
        { id: 'auto', label: 'Auto', description: null },
        { id: 'agent-full-access', label: '完全访问', description: null },
      ],
      current_mode: 'agent-full-access',
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'other-model',
          choices: [
            { value: 'gpt-6-astra', label: 'gpt-6-astra' },
            { value: 'other-model', label: 'other-model' },
          ],
        },
        {
          key: 'reasoning_effort',
          label: '思考强度',
          category: 'thought_level',
          value: 'high',
          choices: [
            { value: 'low', label: '低' },
            { value: 'high', label: '高' },
          ],
        },
        {
          key: 'fast_mode',
          label: 'Fast',
          category: 'model_config',
          value: false,
          choices: [
            { value: false, label: 'Off' },
            { value: true, label: 'On' },
          ],
        },
      ],
    };

    const merged = mergeCreateSessionControls([catalog, live]);
    expect(merged?.current_mode).toBe('auto');
    expect(merged?.config_options.map((option) => option.key)).toEqual([
      'model',
      'reasoning_effort',
      'fast_mode',
    ]);
    expect(
      merged?.config_options.find((option) => option.key === 'model')?.value
    ).toBe('gpt-6-astra');
    expect(merged?.modes.map((mode) => mode.id)).toEqual([
      'auto',
      'agent-full-access',
    ]);
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
