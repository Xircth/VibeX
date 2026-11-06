import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publishLiveSessionControls } from '@/features/agents/sessionControlsQuery';

import { MemberSessionConfigControls } from './MemberSessionConfigControls';

const capabilityCatalog = vi.fn();
const capabilityCatalogFresh = vi.fn();
const refreshCapabilityCatalog = vi.fn();

vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    capabilityCatalog: (...args: unknown[]) => capabilityCatalog(...args),
    capabilityCatalogFresh: (...args: unknown[]) =>
      capabilityCatalogFresh(...args),
    refreshCapabilityCatalog: (...args: unknown[]) =>
      refreshCapabilityCatalog(...args),
  },
}));

const CODEX_MODEL = {
  key: 'model',
  label: 'Model',
  description: null,
  category: 'model',
  value: 'gpt-5',
  choices: [
    { value: 'gpt-5', label: 'GPT-5', description: null },
    { value: 'gpt-5-codex', label: 'GPT-5 Codex', description: null },
  ],
};

const CODEX_EFFORT = {
  key: 'effort',
  label: '推理强度',
  description: null,
  category: 'thought_level',
  value: 'high',
  choices: [
    { value: 'high', label: 'High', description: null },
    { value: 'medium', label: 'Medium', description: null },
  ],
};

function renderControls(agentId = 'codex') {
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
    ...render(
      <MemberSessionConfigControls
        agentId={agentId}
        modeId=""
        values={{}}
        onModeId={vi.fn()}
        onValues={vi.fn()}
      />,
      { wrapper: Wrapper }
    ),
  };
}

describe('MemberSessionConfigControls', () => {
  beforeEach(() => {
    capabilityCatalog.mockReset();
    capabilityCatalogFresh.mockReset();
    refreshCapabilityCatalog.mockReset();
    capabilityCatalogFresh.mockResolvedValue(true);
  });

  it('shows advertised Codex session controls from the capability catalog', async () => {
    capabilityCatalog.mockResolvedValue({
      modes: [{ id: 'agent', label: 'Agent', description: null }],
      current_mode: 'agent',
      config_options: [CODEX_MODEL, CODEX_EFFORT],
    });
    renderControls();

    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    expect(screen.queryByText('暂不可用')).not.toBeInTheDocument();
    expect(capabilityCatalog).toHaveBeenCalledWith('codex');
  });

  it('keeps live schema controls when the persisted catalog is missing', async () => {
    capabilityCatalog.mockResolvedValue(null);
    refreshCapabilityCatalog.mockResolvedValue(false);
    const { client } = renderControls();
    publishLiveSessionControls(client, {
      agentType: 'codex',
      workspaceId: 'workspace-1',
      controls: {
        modes: [{ id: 'agent', label: 'Agent', description: null }],
        current_mode: 'agent',
        config_options: [CODEX_MODEL, CODEX_EFFORT],
      },
    });

    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    expect(screen.queryByText('暂不可用')).not.toBeInTheDocument();
  });

  it('shows error card and does not show 暂不可用 when session control discovery fails', async () => {
    capabilityCatalog.mockResolvedValue(null);
    refreshCapabilityCatalog.mockResolvedValue(false);
    renderControls();

    await waitFor(() => {
      expect(refreshCapabilityCatalog).toHaveBeenCalledWith('codex');
    });
    expect(screen.queryByText('暂不可用')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('session-settings-summary')
    ).not.toBeInTheDocument();
    expect(
      await screen.findByTestId('session-creation-status-card')
    ).toBeInTheDocument();
  });

  it('shows last matching Codex controls while a stale catalog refreshes in the background', async () => {
    capabilityCatalog.mockResolvedValue({
      modes: [{ id: 'agent', label: 'Agent', description: null }],
      current_mode: 'agent',
      config_options: [CODEX_MODEL, CODEX_EFFORT],
    });
    capabilityCatalogFresh
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    refreshCapabilityCatalog.mockResolvedValue(true);
    renderControls();

    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    expect(screen.queryByText('暂不可用')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(refreshCapabilityCatalog).toHaveBeenCalledWith('codex')
    );
  });

  it('normalizes uppercase agent ids when loading capability catalog', async () => {
    capabilityCatalog.mockResolvedValue({
      modes: [{ id: 'agent', label: 'Agent', description: null }],
      current_mode: 'agent',
      config_options: [CODEX_MODEL, CODEX_EFFORT],
    });
    renderControls('CODEX');

    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    expect(capabilityCatalog).toHaveBeenCalledWith('codex');
  });
});
