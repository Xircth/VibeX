import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshProvidersView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { clearAllAgentSettingsDrafts } from './agentSettingsDraftRetention';
import { pickAuthModeTab } from './agentSettingsTestUtils';
import { DshAuthPanel } from './DshAuthPanel';

const pluginControl = vi.hoisted(() => ({
  contributionCatalog: vi.fn(),
  providerCatalogList: vi.fn(),
}));

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => ({
    contributionCatalog: pluginControl.contributionCatalog,
    providerCatalogList: pluginControl.providerCatalogList,
    invokeContribution: async () => ({}),
  }),
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

describe('DshAuthPanel', () => {
  beforeEach(() => {
    pluginControl.contributionCatalog.mockResolvedValue({
      generation: 0,
      items: [],
    });
    pluginControl.providerCatalogList.mockResolvedValue({
      agent_id: 'deepseek_harness',
      generation: 0,
      templates: [],
      sources: [],
    });
    clearAllAgentSettingsDrafts();
    vi.mocked(agentManagementApi.dshProviders).mockResolvedValue(view);
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    vi.mocked(agentManagementApi.setAuthMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    vi.mocked(agentManagementApi.saveDshProvider).mockResolvedValue(view);
    vi.mocked(agentManagementApi.deleteDshProvider).mockResolvedValue(view);
  });

  it('saves the official DeepSeek API key and model and supports switching official API URL', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    render(<DshAuthPanel />);

    expect(
      await screen.findByRole('tab', { name: '官方 API' })
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '供应商' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    const urlSelect = await screen.findByRole('combobox', { name: 'API URL' });
    expect(urlSelect).toHaveTextContent('https://api.deepseek.com');
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.tab();

    expect(agentManagementApi.setAuthMode).toHaveBeenCalledWith(
      'deepseek_harness',
      'deepseek',
      'sk-test'
    );
    expect(agentManagementApi.saveDshProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'deepseek-official',
        base_url: 'https://api.deepseek.com',
        api_key: 'sk-test',
        set_default: true,
      })
    );

    await user.click(urlSelect);
    await user.click(
      await screen.findByRole('option', {
        name: 'https://api.deepseek.com/anthropic',
      })
    );
    expect(agentManagementApi.saveDshProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'deepseek-official',
        base_url: 'https://api.deepseek.com/anthropic',
      })
    );
  });

  it('masks saved API key by default and toggles plaintext when clicking the eye button', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.dshProviders).mockResolvedValue({
      ...view,
      providers: [
        {
          ...view.providers[0],
          api_key: 'sk-saved-secret',
        },
      ],
    });
    render(<DshAuthPanel />);

    const apiKeyInput = await screen.findByLabelText('API Key');
    expect(apiKeyInput).toHaveValue('sk-saved-secret');
    expect(apiKeyInput).toHaveAttribute('type', 'password');

    const showBtn = screen.getByRole('button', { name: '显示 API Key' });
    await user.click(showBtn);
    expect(apiKeyInput).toHaveAttribute('type', 'text');

    const hideBtn = screen.getByRole('button', { name: '隐藏 API Key' });
    await user.click(hideBtn);
    expect(apiKeyInput).toHaveAttribute('type', 'password');
  });

  it('shows custom provider fields and centered empty state copy', async () => {
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'custom',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: false,
    });
    render(<DshAuthPanel />);

    expect(await screen.findByRole('tab', { name: '供应商' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('heading', { name: '模型供应商' })).toBeVisible();
    expect(screen.getByText('暂无供应商')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '新建供应商' }));
    expect(await screen.findByLabelText('显示名称')).toBeInTheDocument();
    expect(screen.getByLabelText('备注')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
  });

  it('keeps an unsaved custom endpoint after the panel remounts', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DshAuthPanel />);

    expect(
      await screen.findByRole('combobox', { name: 'API URL' })
    ).toHaveTextContent('https://api.deepseek.com');

    await pickAuthModeTab(user, '供应商');
    await user.click(screen.getByRole('button', { name: '新建供应商' }));
    await user.type(
      screen.getByLabelText('Base URL'),
      'https://example.com/v1'
    );

    unmount();
    render(<DshAuthPanel />);

    expect(await screen.findByLabelText('Base URL')).toHaveValue(
      'https://example.com/v1'
    );
    expect(
      screen.queryByRole('combobox', { name: 'API URL' })
    ).not.toBeInTheDocument();
  });

  it('uses editingId when discovering models, renders available model checkboxes, and updates default model options', async () => {
    const user = userEvent.setup();
    const multiView: DshProvidersView = {
      ...view,
      default_provider: 'custom-2',
      providers: [
        ...view.providers,
        {
          id: 'custom-1',
          display_name: 'First Gateway',
          kind: 'custom',
          notes: null,
          api: 'openai-completions',
          base_url: 'https://first.example.com/v1',
          api_key_env: 'DSH_CUSTOM_1_KEY',
          credential_present: false,
          models: [{ id: 'm1', name: 'M1' }],
        },
        {
          id: 'custom-2',
          display_name: 'Second Gateway',
          kind: 'custom',
          notes: null,
          api: 'openai-completions',
          base_url: 'https://second.example.com/v1',
          api_key_env: 'DSH_CUSTOM_2_KEY',
          credential_present: true,
          models: [{ id: 'm2', name: 'M2' }],
        },
      ],
    };
    const discoveredModels = [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ];
    vi.mocked(agentManagementApi.dshProviders).mockResolvedValue(multiView);
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'custom',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    vi.mocked(agentManagementApi.discoverDshModels).mockResolvedValue(
      discoveredModels
    );
    vi.mocked(agentManagementApi.saveDshProvider).mockImplementation(
      async (req) => ({
        ...multiView,
        default_provider: req.id,
        default_model: req.default_model ?? 'deepseek-chat',
        providers: multiView.providers.map((item) =>
          item.id === req.id
            ? {
                ...item,
                models: req.models,
              }
            : item
        ),
      })
    );

    render(<DshAuthPanel />);

    const editButtons = await screen.findAllByRole('button', {
      name: '编辑 Provider',
    });
    await user.click(editButtons[1]);
    await user.click(screen.getByRole('button', { name: '拉取模型' }));

    expect(agentManagementApi.discoverDshModels).toHaveBeenCalledWith({
      base_url: 'https://second.example.com/v1',
      api_key: null,
      provider_id: 'custom-2',
    });
    expect(agentManagementApi.saveDshProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'custom-2',
        base_url: 'https://second.example.com/v1',
        models: discoveredModels,
        default_model: 'deepseek-chat',
      })
    );

    // Re-open edit to toggle available models and verify default model updates
    const updatedEditButtons = await screen.findAllByRole('button', {
      name: '编辑 Provider',
    });
    await user.click(updatedEditButtons[1]);
    const group = await screen.findByRole('group', { name: '可用模型' });
    expect(group).toBeVisible();
    const chatCheckbox = screen.getByRole('checkbox', {
      name: /DeepSeek Chat/,
    });
    expect(chatCheckbox).toBeChecked();
    await user.click(chatCheckbox);

    expect(agentManagementApi.saveDshProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'custom-2',
        models: [{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
        default_model: 'deepseek-reasoner',
      })
    );
  });
});
