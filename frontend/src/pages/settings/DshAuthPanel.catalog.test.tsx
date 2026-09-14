import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshProvidersView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { clearAllAgentSettingsDrafts } from './agentSettingsDraftRetention';
import { DshAuthPanel } from './DshAuthPanel';

const pluginControl = vi.hoisted(() => ({
  contributionCatalog: vi.fn(),
  providerCatalogList: vi.fn(),
}));

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      dshProviders: vi.fn(),
      saveDshProvider: vi.fn(),
      deleteDshProvider: vi.fn(),
      setAuthMode: vi.fn(),
      authMode: vi.fn(),
      discoverDshModels: vi.fn(),
    },
  };
});

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => ({
    contributionCatalog: pluginControl.contributionCatalog,
    providerCatalogList: pluginControl.providerCatalogList,
    invokeContribution: async () => ({}),
  }),
}));

const view: DshProvidersView = {
  settings_path: '/tmp/.dsh/settings.yaml',
  credentials_path: '/tmp/.dsh/.credentials.yaml',
  default_provider: 'deepseek-official',
  default_model: 'deepseek-v4-flash',
  providers: [
    {
      id: 'deepseek-official',
      display_name: 'DeepSeek',
      kind: 'official',
      notes: null,
      api: null,
      base_url: null,
      api_key_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    },
  ],
  catalog: [],
};

const saved = {
  agent_id: 'deepseek_harness' as const,
  mode: 'deepseek' as const,
  modes: ['deepseek', 'custom'] as const,
  options: [],
  credential_env: 'DEEPSEEK_API_KEY',
  credential_present: true,
};

describe('DshAuthPanel catalog picker', () => {
  beforeEach(() => {
    clearAllAgentSettingsDrafts();
    pluginControl.contributionCatalog.mockResolvedValue({
      generation: 4,
      items: [
        {
          pluginId: 'vibex.provider-switch',
          id: 'deepseek-harness',
          kind: 'provider_model_catalog',
          label: 'DeepSeek Harness presets',
          generation: 4,
          metadata: { agents: ['deepseek_harness'] },
        },
      ],
    });
    pluginControl.providerCatalogList.mockResolvedValue({
      agent_id: 'deepseek_harness',
      generation: 4,
      templates: [
        {
          id: 'openrouter',
          plugin_id: 'vibex.provider-switch',
          contribution_id: 'deepseek-harness',
          plugin_label: 'ProviderSwitch',
          agent_id: 'deepseek_harness',
          name: 'OpenRouter',
          category: 'community',
          surface: 'dsh',
          display_name: 'OpenRouter',
          notes: 'OpenAI-compatible gateway',
          base_url: 'https://openrouter.ai/api/v1',
          default_model: 'openai/gpt-4o',
          models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
        },
      ],
      sources: [],
    });
    vi.mocked(agentManagementApi.dshProviders).mockResolvedValue(view);
    vi.mocked(agentManagementApi.authMode).mockResolvedValue(saved);
    vi.mocked(agentManagementApi.setAuthMode).mockResolvedValue({
      ...saved,
      mode: 'custom',
    });
    vi.mocked(agentManagementApi.saveDshProvider).mockResolvedValue(view);
  });

  it('fills the custom form from a catalog template and still saves through Host IPC', async () => {
    const user = userEvent.setup();
    render(<DshAuthPanel />);

    await user.click(await screen.findByRole('tab', { name: '供应商' }));
    await user.click(screen.getByRole('button', { name: '新建供应商' }));
    expect(await screen.findByRole('button', { name: '自定义' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'OpenRouter' }));

    expect(screen.getByLabelText('显示名称')).toHaveValue('OpenRouter');
    expect(screen.getByLabelText('备注')).toHaveValue(
      'OpenAI-compatible gateway'
    );
    expect(screen.getByLabelText('Base URL')).toHaveValue(
      'https://openrouter.ai/api/v1'
    );
    expect(screen.getByLabelText('API Key')).toHaveValue('');

    await user.type(screen.getByLabelText('API Key'), 'secret');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(agentManagementApi.saveDshProvider).toHaveBeenCalledWith({
        id: 'custom-gateway',
        display_name: 'OpenRouter',
        notes: 'OpenAI-compatible gateway',
        api: 'openai-completions',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'secret',
        models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
        set_default: true,
        default_model: 'openai/gpt-4o',
      });
    });
  });
});
