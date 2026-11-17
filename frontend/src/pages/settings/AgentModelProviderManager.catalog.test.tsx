import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import builtinClaudePresets from '@/features/provider-presets/catalogs/claude_code.json';

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

const pluginCatalog = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => ({
    contributionCatalog: async () => ({
      generation: 4,
      items: pluginCatalog.enabled
        ? [
            {
              pluginId: 'acme.presets',
              id: 'claude-code',
              kind: 'provider_model_catalog',
              label: 'Claude Code presets',
              generation: 4,
              metadata: { agents: ['claude_code'] },
            },
          ]
        : [],
    }),
    providerCatalogList: async () => ({
      agent_id: 'claude_code',
      generation: 4,
      templates: [
        {
          id: 'acme-router',
          plugin_id: 'acme.presets',
          contribution_id: 'claude-code',
          plugin_label: 'Acme Presets',
          agent_id: 'claude_code',
          name: 'Acme Router',
          category: 'community',
          surface: 'reusable',
          api_url: 'https://router.acme.example/api',
          model: '{"main":"acme/sonnet"}',
        },
      ],
      sources: [],
    }),
    invokeContribution: async () => ({}),
  }),
}));

const firstBuiltin = builtinClaudePresets[0];

function savedProvider(name: string, apiUrl: string, model: string) {
  return {
    agent_id: 'claude_code',
    providers: [
      {
        id: 'provider-1',
        name,
        agent_id: 'claude_code',
        api_url: apiUrl,
        model,
        api_key: 'secret',
        credential_present: true,
        bound: false,
        managed: true,
      },
    ],
    bound_provider_id: null,
    multi_enable: false,
  };
}

async function openNewProviderForm(user: ReturnType<typeof userEvent.setup>) {
  render(
    <AgentModelProviderManager
      agentId="claude_code"
      disabled={false}
      embedded
    />
  );
  await user.click(await screen.findByRole('button', { name: '新建供应商' }));
}

describe('AgentModelProviderManager catalog picker', () => {
  beforeEach(() => {
    pluginCatalog.enabled = false;
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [],
      bound_provider_id: null,
      multi_enable: false,
    });
  });

  it('fills the form from a built-in preset without any plugin and saves through Host IPC', async () => {
    vi.mocked(agentManagementApi.saveModelProvider).mockResolvedValue(
      savedProvider(firstBuiltin.name, firstBuiltin.api_url, firstBuiltin.model)
    );
    const user = userEvent.setup();
    await openNewProviderForm(user);

    await pickAstryxOption(
      user,
      await screen.findByRole('combobox', { name: '搜索预置' }),
      firstBuiltin.name
    );

    expect(screen.getByLabelText('Provider 名称')).toHaveValue(
      firstBuiltin.name
    );
    expect(screen.getByLabelText('Provider API URL')).toHaveValue(
      firstBuiltin.api_url
    );
    const websiteInput = screen.getByRole('textbox', { name: '网站' });
    expect(websiteInput).toHaveValue(firstBuiltin.website_url);
    expect(websiteInput).toHaveAttribute('readonly');
    expect(
      screen.getByRole('link', { name: `网站: ${firstBuiltin.website_url}` })
    ).toHaveAttribute('href', firstBuiltin.website_url);

    const apiKeyInput = screen.getByLabelText('Provider API Key');
    expect(
      apiKeyInput.compareDocumentPosition(websiteInput) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await user.type(apiKeyInput, 'secret');
    await user.click(screen.getByRole('button', { name: '创建 Provider' }));

    await waitFor(() => {
      expect(agentManagementApi.saveModelProvider).toHaveBeenCalledWith({
        id: null,
        name: firstBuiltin.name,
        agent_id: 'claude_code',
        api_url: firstBuiltin.api_url,
        api_key: 'secret',
        model: firstBuiltin.model,
      });
    });
  });

  it('shows read-only website and get-key URL inputs alongside endpoints and clears them on custom', async () => {
    const presetWithLinks = builtinClaudePresets.find(
      (preset) =>
        preset.website_url &&
        preset.api_key_url &&
        (preset.endpoint_candidates?.length ?? 0) > 1
    );
    expect(presetWithLinks).toBeDefined();

    const user = userEvent.setup();
    await openNewProviderForm(user);

    await pickAstryxOption(
      user,
      await screen.findByRole('combobox', { name: '搜索预置' }),
      presetWithLinks!.name
    );

    expect(screen.getByRole('textbox', { name: '网站' })).toHaveValue(
      presetWithLinks!.website_url
    );
    expect(
      screen.getByRole('link', {
        name: `网站: ${presetWithLinks!.website_url}`,
      })
    ).toHaveAttribute('href', presetWithLinks!.website_url);

    const getKeyInput = screen.getByRole('textbox', { name: '获取密钥' });
    expect(getKeyInput).toHaveValue(presetWithLinks!.api_key_url);
    expect(getKeyInput).toHaveAttribute('readonly');
    expect(
      screen.getByRole('link', {
        name: `获取密钥: ${presetWithLinks!.api_key_url}`,
      })
    ).toHaveAttribute('href', presetWithLinks!.api_key_url);

    expect(
      screen.getByRole('combobox', { name: '可用端点' })
    ).toBeInTheDocument();

    await pickAstryxOption(
      user,
      screen.getByRole('combobox', { name: '搜索预置' }),
      '自定义'
    );

    expect(screen.queryByRole('textbox', { name: '网站' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '获取密钥' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '可用端点' })).toBeNull();
  });

  it('appends plugin-contributed presets after the built-in ones', async () => {
    pluginCatalog.enabled = true;
    const user = userEvent.setup();
    await openNewProviderForm(user);

    await user.click(await screen.findByRole('combobox', { name: '搜索预置' }));
    const labels = (await screen.findAllByRole('option')).map((option) =>
      option.getAttribute('aria-label')
    );

    expect(labels[0]).toBe('自定义');
    expect(labels[1]).toBe(firstBuiltin.name);
    expect(labels.at(-1)).toBe('Acme Router');
    expect(labels).toHaveLength(builtinClaudePresets.length + 2);
  });
});
