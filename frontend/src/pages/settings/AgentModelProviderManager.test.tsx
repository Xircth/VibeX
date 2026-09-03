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
  api_key: 'secret',
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

  it('creates a Pi custom provider with wire protocol', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'pi',
      providers: [],
      bound_provider_id: null,
    });
    vi.mocked(agentManagementApi.saveModelProvider).mockResolvedValue({
      agent_id: 'pi',
      providers: [{ ...gateway, agent_id: 'pi' }],
      bound_provider_id: null,
    });
    render(
      <AgentModelProviderManager agentId="pi" disabled={false} embedded />
    );

    expect(
      await screen.findByRole('heading', { name: '模型供应商' })
    ).toBeVisible();
    expect(screen.getByText('暂未识别到供应商')).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: '新建供应商' })[0]
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '从外部导入' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '从外部导入' }));
    expect(
      screen.getByRole('menuitem', { name: '从当前配置导入' })
    ).toBeVisible();
    expect(
      screen.getByRole('menuitem', { name: '从 CC Switch 导入' })
    ).toBeVisible();

    await user.click(screen.getAllByRole('button', { name: '新建供应商' })[0]);
    await user.type(screen.getByLabelText('Provider 名称'), 'Gateway');
    await user.type(
      screen.getByLabelText('Provider API URL'),
      'https://gateway.example/v1'
    );
    await user.type(screen.getByLabelText('Provider API Key'), 'secret');
    await user.type(screen.getByLabelText('Provider 模型'), 'private-model');
    await user.selectOptions(
      screen.getByLabelText('接入协议'),
      'anthropic-messages'
    );
    await user.click(screen.getByRole('button', { name: '创建 Provider' }));

    expect(agentManagementApi.saveModelProvider).toHaveBeenCalledWith({
      id: null,
      name: 'Gateway',
      agent_id: 'pi',
      api_url: 'https://gateway.example/v1',
      api_key: 'secret',
      model: '{"id":"private-model","api":"anthropic-messages"}',
    });
  });

  it('lists a native Pi provider with the same actions as other providers', async () => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'pi',
      providers: [
        {
          id: 'private',
          name: 'private',
          agent_id: 'pi',
          api_url: 'https://private.example/v1',
          model: 'private-model',
          api_key: 'sk-pi',
          credential_present: true,
          bound: true,
          managed: true,
        },
      ],
      bound_provider_id: 'private',
    });
    render(
      <AgentModelProviderManager agentId="pi" disabled={false} embedded />
    );
    expect(
      await screen.findByRole('heading', { name: '模型供应商' })
    ).toBeVisible();
    expect(await screen.findByText('private')).toBeVisible();
    expect(screen.getByRole('button', { name: '已启用' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '编辑 private' })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: '删除 private' })
    ).toBeDisabled();
    expect(screen.queryByText('暂未识别到供应商')).not.toBeInTheDocument();
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

  it('loads the saved API key when editing so it can be revealed, copied, and used to detect models', async () => {
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
    vi.mocked(agentManagementApi.modelProviderCatalog).mockResolvedValue({
      agent_id: 'claude_code',
      source: 'live',
      models: [
        {
          id: 'gateway/sonnet',
          label: 'Sonnet',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: 'gateway/sonnet',
      error: null,
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
      await screen.findByRole('button', { name: '编辑 Gateway' })
    );
    const keyInput = screen.getByLabelText('Provider API Key');
    expect(keyInput).toHaveValue('secret');
    expect(keyInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: '显示 API Key' }));
    expect(keyInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: '复制 API Key' }));
    expect(writeText).toHaveBeenCalledWith('secret');

    await user.click(screen.getByRole('button', { name: '检测模型' }));
    expect(agentManagementApi.modelProviderCatalog).toHaveBeenCalledWith(
      'claude_code',
      'provider-1',
      'https://gateway.example/v1',
      'secret'
    );
  });

  it('lets a native Codex provider be enabled after another provider exists', async () => {
    const custom = {
      id: 'custom',
      name: 'Custom',
      agent_id: 'codex' as const,
      api_url: 'https://api.custom.example/v1',
      model: 'custom-model',
      api_key: 'sk-custom',
      credential_present: true,
      bound: false,
      managed: true,
    };
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        custom,
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
      default_model: 'custom-model',
      catalog_path: '/tmp/catalog.json',
      source_path: '/tmp/source.json',
      active: false,
    });
    vi.mocked(agentManagementApi.bindModelProvider).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        { ...custom, bound: true },
        { ...gateway, agent_id: 'codex', bound: false },
      ],
      bound_provider_id: 'custom',
    });

    const user = userEvent.setup();
    render(
      <AgentModelProviderManager agentId="codex" disabled={false} embedded />
    );

    expect(await screen.findByText('Custom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已启用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 Gateway' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 Custom' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '启用' }));
    expect(agentManagementApi.bindModelProvider).toHaveBeenCalledWith(
      'codex',
      'custom'
    );
  });

  it('keeps delete disabled when only one provider remains', async () => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        {
          ...gateway,
          agent_id: 'codex',
          bound: false,
        },
      ],
      bound_provider_id: null,
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

    expect(await screen.findByRole('button', { name: '启用' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除 Gateway' })).toBeDisabled();
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
