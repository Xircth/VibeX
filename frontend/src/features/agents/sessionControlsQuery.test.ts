import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import {
  publishLiveSessionControls,
  sessionControlsQueryKey,
} from './sessionControlsQuery';

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
