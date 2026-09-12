import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { publishLiveSessionControls } from '@/features/agents/sessionControlsQuery';

import { AgentSessionConfigPicker } from './AgentSessionConfigPicker';

const capabilityCatalog = vi.fn();
const capabilityCatalogFresh = vi.fn();
const refreshCapabilityCatalog = vi.fn();
const sessionDefaults = vi.fn();
const agentManagementBar = vi.fn();

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: {
    bar: (...args: unknown[]) => agentManagementBar(...args),
  },
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    capabilityCatalog: (...args: unknown[]) => capabilityCatalog(...args),
    capabilityCatalogFresh: (...args: unknown[]) =>
      capabilityCatalogFresh(...args),
    refreshCapabilityCatalog: (...args: unknown[]) =>
      refreshCapabilityCatalog(...args),
    sessionDefaults: (...args: unknown[]) => sessionDefaults(...args),
  },
}));

const GROK_AGENT = {
  agent_id: 'grok',
  display_name: 'Grok',
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
  runtime_version: '1.0.0',
  acp_version: '1.0.0',
  active_operation: null,
  rollback_available: false,
} satisfies AgentManagementView;

const GROK_MODEL = {
  key: 'model',
  label: 'Model',
  description: null,
  category: 'model',
  value: 'grok-4.6',
  choices: [
    { value: 'grok-4.6', label: 'Grok 4.6', description: null },
    { value: 'grok-4.5', label: 'Grok 4.5', description: null },
  ],
};

const GROK_EFFORT = {
  key: 'effort',
  label: '推理强度',
  description: null,
  category: 'thought_level',
  value: 'high',
  choices: [
    { value: 'xhigh', label: 'Extra High Effort', description: null },
    { value: 'high', label: 'High Effort', description: null },
    { value: 'medium', label: 'Medium Effort', description: null },
    { value: 'low', label: 'Low Effort', description: null },
  ],
};

function renderPicker(
  pendingConfigValues: Record<string, string> = {},
  onSelectConfigValue = vi.fn()
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return {
    client,
    onSelectConfigValue,
    ...render(
      <AgentSessionConfigPicker
        agentId="grok"
        selectedModeId={null}
        pendingConfigValues={pendingConfigValues}
        onAgentChange={vi.fn()}
        onSelectMode={vi.fn()}
        onSelectConfigValue={onSelectConfigValue}
        agentLabel="Agent"
      />,
      { wrapper: Wrapper }
    ),
  };
}

describe('AgentSessionConfigPicker', () => {
  beforeEach(() => {
    capabilityCatalog.mockReset();
    capabilityCatalogFresh.mockReset();
    refreshCapabilityCatalog.mockReset();
    sessionDefaults.mockReset();
    agentManagementBar.mockReset();
    agentManagementBar.mockResolvedValue([GROK_AGENT]);
    capabilityCatalogFresh.mockResolvedValue(true);
    sessionDefaults.mockResolvedValue({ values: {}, staleIds: [] });
  });

  it('shows Grok model and effort from the capability catalog', async () => {
    capabilityCatalog.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [GROK_MODEL, GROK_EFFORT],
    });
    renderPicker();

    expect(await screen.findByTestId('session-control-model')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/Grok 4\.6/)
    );
    expect(screen.getByTestId('session-control-effort')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/High Effort|推理强度/)
    );
  });

  it('merges live schema so effort appears even when the catalog only has model', async () => {
    capabilityCatalog.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [GROK_MODEL],
    });
    const { client } = renderPicker();
    publishLiveSessionControls(client, {
      agentType: 'grok',
      workspaceId: 'workspace-other',
      controls: {
        modes: [],
        current_mode: null,
        config_options: [GROK_MODEL, GROK_EFFORT],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-control-effort')).toBeInTheDocument();
    });
    expect(screen.getByTestId('session-control-model')).toBeInTheDocument();
  });
});
