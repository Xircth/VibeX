import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAuthModeView, DshProvidersView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';
import builtinDshPresets from '@/features/provider-presets/catalogs/deepseek_harness.json';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { clearAllAgentSettingsDrafts } from './agentSettingsDraftRetention';
import { pickAstryxOption } from './agentSettingsTestUtils';
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
      api_key: null,
      credential_present: true,
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    },
  ],
  catalog: [],
};

const saved: AgentAuthModeView = {
  agent_id: 'deepseek_harness',
  mode: 'deepseek',
  modes: ['deepseek', 'custom'],
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
          pluginId: 'acme.presets',
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
          plugin_id: 'acme.presets',
          contribution_id: 'deepseek-harness',
          plugin_label: 'Acme Presets',
          agent_id: 'deepseek_harness',
          name: 'Acme Gateway',
          category: 'community',
          surface: 'dsh',
          display_name: 'Acme Gateway',
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

  it('offers built-in presets before plugin ones', async () => {
    const user = userEvent.setup();
    render(<DshAuthPanel />);

    await user.click(await screen.findByRole('tab', { name: '供应商' }));
    await user.click(screen.getByRole('button', { name: '新建供应商' }));
    await pickAstryxOption(
      user,
      await screen.findByRole('combobox', { name: '搜索预置' }),
      builtinDshPresets[0].name
    );

    expect(screen.getByLabelText('Base URL')).toHaveValue(
      builtinDshPresets[0].base_url
    );
  });

  it('fills the custom form from a catalog template and still saves through Host IPC', async () => {
    const user = userEvent.setup();
    render(<DshAuthPanel />);

    await user.click(await screen.findByRole('tab', { name: '供应商' }));
    await user.click(screen.getByRole('button', { name: '新建供应商' }));
    await pickAstryxOption(
      user,
      await screen.findByRole('combobox', { name: '搜索预置' }),
      'Acme Gateway'
    );

    expect(screen.getByLabelText('显示名称')).toHaveValue('Acme Gateway');
    expect(screen.getByLabelText('备注')).toHaveValue(
      'OpenAI-compatible gateway'
    );
    expect(screen.getByLabelText('Base URL')).toHaveValue(
      'https://openrouter.ai/api/v1'
    );
    expect(screen.getByLabelText('API Key')).toHaveValue('');

    await user.type(screen.getByLabelText('API Key'), 'secret');
    await user.tab();

    await waitFor(() => {
      expect(agentManagementApi.saveDshProvider).toHaveBeenCalledWith({
        id: 'custom-gateway',
        display_name: 'Acme Gateway',
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
