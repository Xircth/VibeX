import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelProviderSettings } from './ModelProviderSettings';

const agentsApiMock = vi.hoisted(() => ({
  refreshCapabilityCatalog: vi.fn(),
}));

const modelProviderApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  apply: vi.fn(),
  preview: vi.fn(),
  clearApiKey: vi.fn(),
  fetchModels: vi.fn(),
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: agentsApiMock,
}));

vi.mock('@/features/agent-management', () => ({
  useManagedAgentOptions: () => [
    { value: 'claude_code', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'opencode', label: 'OpenCode' },
    { value: 'pi', label: 'Pi Agent' },
  ],
}));

vi.mock('@/lib/api', () => ({
  modelProviderApi: modelProviderApiMock,
}));

const emptyView = (agentType: string) => ({
  agent_type: agentType,
  providers: [],
  current: null,
  supports_apply: true,
  config_path: null,
});

const openCodeView = {
  agent_type: 'opencode',
  providers: [
    {
      id: 'provider-1',
      name: 'My OpenAI Provider',
      api_url: 'https://api.example.test/v1',
      default_model: 'gpt-test',
      models: ['gpt-test'],
      auth_type: 'openai_compatible',
      wire_api: null,
      config_overrides: {},
      has_api_key: true,
      is_current: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  current: null,
  supports_apply: true,
  config_path: '/tmp/opencode.json',
};

describe('ModelProviderSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(agentsApiMock)) {
      fn.mockReset();
    }
    for (const fn of Object.values(modelProviderApiMock)) {
      fn.mockReset();
    }
    modelProviderApiMock.list.mockImplementation((agentType: string) =>
      Promise.resolve(
        agentType === 'opencode' ? openCodeView : emptyView(agentType)
      )
    );
    modelProviderApiMock.apply.mockResolvedValue(openCodeView);
    agentsApiMock.refreshCapabilityCatalog.mockResolvedValue(true);
  });

  it('refreshes the OpenCode capability catalog after applying a provider', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <ModelProviderSettings />
      </QueryClientProvider>
    );

    await screen.findByText('还没有供应商');
    await user.click(
      screen.getByRole('button', { name: /^OpenCodeOpenCode$/ })
    );
    await screen.findByText('My OpenAI Provider');

    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(modelProviderApiMock.apply).toHaveBeenCalledWith(
        'opencode',
        'provider-1'
      );
      expect(agentsApiMock.refreshCapabilityCatalog).toHaveBeenCalledWith(
        'opencode'
      );
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['agent-capability-catalog', 'opencode'],
      });
    });
  });
});
