import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { pickAstryxOption } from './agentSettingsTestUtils';
import { AgentModelProviderManager } from './AgentModelProviderManager';

vi.mock('@/features/agent-management', () => ({
  agentManagementErrorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
  agentManagementApi: {
    modelProviders: vi.fn(),
    saveModelProvider: vi.fn(),
    bindModelProvider: vi.fn(),
    deleteModelProvider: vi.fn(),
    probeModelProvider: vi.fn(),
    previewModelProviderImport: vi.fn(),
    importModelProviders: vi.fn(),
    codexModelCatalog: vi.fn(),
    codexModelCatalogConfig: vi.fn(),
    modelProviderCatalog: vi.fn(),
  },
}));

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => ({
    contributionCatalog: async () => ({
      generation: 4,
      items: [
        {
          pluginId: 'vibex.provider-switch',
          id: 'claude-code',
          kind: 'provider_model_catalog',
          label: 'Claude Code presets',
          generation: 4,
          metadata: { agents: ['claude_code'] },
        },
      ],
    }),
    providerCatalogList: async () => ({
      agent_id: 'claude_code',
      generation: 4,
      templates: [
        {
          id: 'openrouter',
          plugin_id: 'vibex.provider-switch',
          contribution_id: 'claude-code',
          plugin_label: 'ProviderSwitch',
          agent_id: 'claude_code',
          name: 'OpenRouter',
          category: 'community',
          surface: 'reusable',
          api_url: 'https://openrouter.ai/api',
          model: '{"main":"anthropic/claude-sonnet-4"}',
          website_url: 'https://openrouter.ai',
        },
      ],
      sources: [],
    }),
    invokeContribution: async () => ({}),
  }),
}));

describe('AgentModelProviderManager catalog picker', () => {
  beforeEach(() => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [],
      bound_provider_id: null,
    });
    vi.mocked(agentManagementApi.saveModelProvider).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [
        {
          id: 'provider-1',
          name: 'OpenRouter',
          agent_id: 'claude_code',
          api_url: 'https://openrouter.ai/api',
          model: '{"main":"anthropic/claude-sonnet-4"}',
          api_key: 'secret',
          credential_present: true,
          bound: false,
          managed: true,
        },
      ],
      bound_provider_id: null,
    });
  });

  it('fills the new-provider form from a catalog template and still saves through Host IPC', async () => {
    const user = userEvent.setup();
    render(
      <AgentModelProviderManager
        agentId="claude_code"
        disabled={false}
        embedded
      />
    );

    await user.click(await screen.findByRole('button', { name: '新建供应商' }));
    await pickAstryxOption(
      user,
      await screen.findByRole('combobox', { name: '搜索预置' }),
      'OpenRouter'
    );

    expect(screen.getByLabelText('Provider 名称')).toHaveValue('OpenRouter');
    expect(screen.getByLabelText('Provider API URL')).toHaveValue(
      'https://openrouter.ai/api'
    );

    await user.type(screen.getByLabelText('Provider API Key'), 'secret');
    await user.click(screen.getByRole('button', { name: '创建 Provider' }));

    await waitFor(() => {
      expect(agentManagementApi.saveModelProvider).toHaveBeenCalledWith({
        id: null,
        name: 'OpenRouter',
        agent_id: 'claude_code',
        api_url: 'https://openrouter.ai/api',
        api_key: 'secret',
        model: '{"main":"anthropic/claude-sonnet-4"}',
      });
    });
  });
});
