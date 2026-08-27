import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { agentManagementApi } from '@/features/agent-management';

import { AgentModelProviderManager } from './AgentModelProviderManager';

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

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

const gateway = {
  id: 'provider-1',
  name: 'Gateway',
  agent_id: 'claude_code' as const,
  api_url: 'https://gateway.example/v1',
  model: 'gateway/sonnet',
  credential_present: true,
  bound: false,
  managed: true,
};

describe('AgentModelProviderManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ConfirmDialog.show).mockResolvedValue('canceled');
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [],
      bound_provider_id: null,
    });
    vi.mocked(agentManagementApi.saveModelProvider).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [{ ...gateway }],
      bound_provider_id: null,
    });
    vi.mocked(agentManagementApi.bindModelProvider).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [{ ...gateway, bound: true }],
      bound_provider_id: 'provider-1',
    });
  });

  it('creates a provider from the empty list and enables it from the card', async () => {
    const user = userEvent.setup();
    render(
      <AgentModelProviderManager
        agentId="claude_code"
        disabled={false}
        embedded
      />
    );

    const heading = await screen.findByRole('heading', { name: '模型供应商' });
    expect(
      heading.compareDocumentPosition(
        screen.getAllByRole('button', { name: '新建供应商' })[0]
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '从外部导入' })).toBeVisible();

    await user.click(
      (await screen.findAllByRole('button', { name: '新建供应商' }))[0]
    );
    await user.type(screen.getByLabelText('Provider 名称'), 'Gateway');
    await user.type(
      screen.getByLabelText('Provider API URL'),
      'https://gateway.example/v1'
    );
    await user.type(screen.getByLabelText('Provider API Key'), 'secret');
    await user.type(screen.getByLabelText('Provider 主模型'), 'gateway/sonnet');
    await user.click(screen.getByRole('button', { name: '创建 Provider' }));

    expect(agentManagementApi.saveModelProvider).toHaveBeenCalledWith({
      id: null,
      name: 'Gateway',
      agent_id: 'claude_code',
      api_url: 'https://gateway.example/v1',
      api_key: 'secret',
      model: '{"main":"gateway/sonnet"}',
    });

    await user.click(await screen.findByRole('button', { name: '启用' }));
    expect(agentManagementApi.bindModelProvider).toHaveBeenCalledWith(
      'claude_code',
      'provider-1'
    );
  });

  it('copies a provider card without the API key', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'navigator',
      new Proxy(navigator, {
        get(target, prop, receiver) {
          if (prop === 'clipboard') return { writeText };
          return Reflect.get(target, prop, receiver);
        },
      })
    );
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [{ ...gateway }],
      bound_provider_id: null,
    });
    const user = userEvent.setup();
    render(
      <AgentModelProviderManager
        agentId="claude_code"
        disabled={false}
        embedded
      />
    );

    await user.click(
      await screen.findByRole('button', { name: '复制 Gateway 配置' })
    );
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(
        {
          agent_id: 'claude_code',
          name: 'Gateway',
          api_url: 'https://gateway.example/v1',
          model: 'gateway/sonnet',
        },
        null,
        2
      )
    );
  });

  it('does not let a native Codex provider be enabled, edited, or deleted', async () => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek Gateway',
          agent_id: 'codex',
          api_url: 'https://api.deepseek.example/v1',
          model: 'deepseek-v4-flash',
          credential_present: true,
          bound: true,
          managed: false,
        },
      ],
      bound_provider_id: 'deepseek',
    });
    vi.mocked(agentManagementApi.codexModelCatalog).mockResolvedValue({
      agent_id: 'codex',
      source: 'cache',
      models: [],
      default_model: null,
      error: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalogConfig).mockResolvedValue({
      customs: [],
      excluded_officials: [],
      default_model: 'deepseek-v4-flash',
      catalog_path: '/tmp/catalog.json',
      source_path: '/tmp/source.json',
      active: false,
    });

    render(
      <AgentModelProviderManager agentId="codex" disabled={false} embedded />
    );

    expect(await screen.findByText('DeepSeek Gateway')).toBeInTheDocument();
    expect(
      screen.getByText('https://api.deepseek.example/v1')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '启用' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '编辑 DeepSeek Gateway' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '删除 DeepSeek Gateway' })
    ).not.toBeInTheDocument();
  });

  it('keeps delete disabled while a managed provider is enabled', async () => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        {
          ...gateway,
          agent_id: 'codex',
          bound: true,
        },
      ],
      bound_provider_id: 'provider-1',
    });
    vi.mocked(agentManagementApi.codexModelCatalog).mockResolvedValue({
      agent_id: 'codex',
      source: 'cache',
      models: [],
      default_model: null,
      error: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalogConfig).mockResolvedValue({
      customs: [],
      excluded_officials: [],
      default_model: null,
      catalog_path: '/tmp/catalog.json',
      source_path: '/tmp/source.json',
      active: false,
    });

    render(
      <AgentModelProviderManager agentId="codex" disabled={false} embedded />
    );

    expect(
      await screen.findByRole('button', { name: '已启用' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 Gateway' })).toBeDisabled();
  });

  it('imports selectable CC Switch candidates after preview', async () => {
    vi.mocked(agentManagementApi.previewModelProviderImport).mockResolvedValue({
      agent_id: 'claude_code',
      source: 'cc_switch',
      source_path: '/home/user/.cc-switch/cc-switch.db',
      error: null,
      candidates: [
        {
          source_id: 'deepseek',
          name: 'DeepSeek',
          api_url: 'https://api.deepseek.com',
          model: '{"main":"deepseek-chat"}',
          credential_present: true,
          skip_reason: null,
        },
        {
          source_id: 'oauth',
          name: 'Codex OAuth',
          api_url: '',
          model: '',
          credential_present: false,
          skip_reason: '无法投影的认证方式',
        },
      ],
    });
    vi.mocked(agentManagementApi.importModelProviders).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [{ ...gateway, name: 'DeepSeek' }],
      bound_provider_id: null,
    });
    const user = userEvent.setup();
    render(
      <AgentModelProviderManager
        agentId="claude_code"
        disabled={false}
        embedded
      />
    );

    await user.click(await screen.findByRole('button', { name: '从外部导入' }));
    await user.click(
      screen.getByRole('menuitem', { name: '从 CC Switch 导入' })
    );
    expect(await screen.findByText('DeepSeek')).toBeInTheDocument();
    expect(screen.getByText('无法投影的认证方式')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导入所选' }));
    expect(agentManagementApi.importModelProviders).toHaveBeenCalledWith({
      agent_id: 'claude_code',
      source: 'cc_switch',
      source_ids: ['deepseek'],
    });
  });
});
