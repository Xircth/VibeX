import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { agentManagementApi } from '@/features/agent-management';

import { pickAstryxOption } from './agentSettingsTestUtils';
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
    codexModelCatalog: vi.fn(),
    codexModelCatalogConfig: vi.fn(),
    modelProviderCatalog: vi.fn(),
  },
}));

describe('AgentModelProviderManager', () => {
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
      providers: [
        {
          id: 'provider-1',
          name: 'Gateway',
          agent_id: 'claude_code',
          api_url: 'https://gateway.example/v1',
          model: 'gateway/sonnet',
          credential_present: true,
          bound: false,
          managed: true,
        },
      ],
      bound_provider_id: null,
    });
    vi.mocked(agentManagementApi.bindModelProvider).mockResolvedValue({
      agent_id: 'claude_code',
      providers: [
        {
          id: 'provider-1',
          name: 'Gateway',
          agent_id: 'claude_code',
          api_url: 'https://gateway.example/v1',
          model: 'gateway/sonnet',
          credential_present: true,
          bound: true,
          managed: true,
        },
      ],
      bound_provider_id: 'provider-1',
    });
  });

  it('creates a reusable provider and binds it through the typed API', async () => {
    render(
      <AgentModelProviderManager agentId="claude_code" disabled={false} />
    );
    await userEvent.click(screen.getByText('可复用 Model Provider'));
    expect(await screen.findByLabelText('Provider 名称')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Provider 名称'), 'Gateway');
    await userEvent.type(
      screen.getByLabelText('Provider API URL'),
      'https://gateway.example/v1'
    );
    await userEvent.type(screen.getByLabelText('Provider API Key'), 'secret');
    await userEvent.type(
      screen.getByLabelText('Provider 主模型'),
      'gateway/sonnet'
    );
    await userEvent.click(
      screen.getByRole('button', { name: '创建 Provider' })
    );
    expect(agentManagementApi.saveModelProvider).toHaveBeenCalledWith({
      id: null,
      name: 'Gateway',
      agent_id: 'claude_code',
      api_url: 'https://gateway.example/v1',
      api_key: 'secret',
      model: '{"main":"gateway/sonnet"}',
    });
    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('当前绑定的 Model Provider'),
      'Gateway'
    );
    expect(agentManagementApi.bindModelProvider).toHaveBeenCalledWith(
      'claude_code',
      'provider-1'
    );
  });

  it('detects models from the unsaved provider fields and preserves existing Claude mappings', async () => {
    vi.mocked(agentManagementApi.modelProviderCatalog).mockResolvedValue({
      agent_id: 'claude_code',
      source: 'live',
      models: [
        {
          id: 'claude-sonnet-4',
          label: 'Claude Sonnet 4',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: null,
      error: null,
    });

    render(
      <AgentModelProviderManager agentId="claude_code" disabled={false} />
    );
    await userEvent.click(screen.getByText('可复用 Model Provider'));
    await userEvent.type(
      screen.getByLabelText('Provider API URL'),
      'https://draft.example/v1'
    );
    await userEvent.type(
      screen.getByLabelText('Provider API Key'),
      'draft-secret'
    );
    await userEvent.type(
      screen.getByLabelText('Provider 推理模型'),
      'existing-reasoning'
    );
    await userEvent.click(screen.getByRole('button', { name: '检测模型' }));

    expect(agentManagementApi.modelProviderCatalog).toHaveBeenCalledWith(
      'claude_code',
      null,
      'https://draft.example/v1',
      'draft-secret'
    );
    expect(await screen.findByText('检测到 1 个模型')).toBeInTheDocument();
    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('选择检测到的模型'),
      'Claude Sonnet 4 · claude-sonnet-4'
    );

    expect(screen.getByLabelText('Provider 主模型')).toHaveValue(
      'claude-sonnet-4'
    );
    expect(screen.getByLabelText('Provider 推理模型')).toHaveValue(
      'existing-reasoning'
    );
  });

  it('shows loading, empty, and failure feedback for model detection', async () => {
    let rejectDetection: (cause: unknown) => void = () => undefined;
    vi.mocked(agentManagementApi.modelProviderCatalog).mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectDetection = reject;
      })
    );

    render(<AgentModelProviderManager agentId="gemini" disabled={false} />);
    await userEvent.click(screen.getByText('可复用 Model Provider'));
    await userEvent.type(
      screen.getByLabelText('Provider API URL'),
      'https://draft.example/v1'
    );
    await userEvent.type(
      screen.getByLabelText('Provider API Key'),
      'draft-secret'
    );
    await userEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(screen.getByText('正在检测模型…')).toBeInTheDocument();

    await act(async () => rejectDetection(new Error('HTTP 401')));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 401');

    vi.mocked(agentManagementApi.modelProviderCatalog).mockResolvedValueOnce({
      agent_id: 'gemini',
      source: 'live',
      models: [],
      default_model: null,
      error: null,
    });
    await userEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText('未检测到模型')).toBeInTheDocument();
  });

  it('clears loaded provider state when the selected Agent changes', async () => {
    vi.mocked(agentManagementApi.modelProviders)
      .mockResolvedValueOnce({
        agent_id: 'claude_code',
        providers: [
          {
            id: 'claude-provider',
            name: 'Claude Gateway',
            agent_id: 'claude_code',
            api_url: 'https://claude.example/v1',
            model: 'claude-model',
            credential_present: true,
            bound: false,
            managed: true,
          },
        ],
        bound_provider_id: null,
      })
      .mockResolvedValueOnce({
        agent_id: 'gemini',
        providers: [
          {
            id: 'gemini-provider',
            name: 'Gemini Gateway',
            agent_id: 'gemini',
            api_url: 'https://gemini.example/v1',
            model: 'gemini-model',
            credential_present: true,
            bound: false,
            managed: true,
          },
        ],
        bound_provider_id: null,
      });
    const { rerender } = render(
      <AgentModelProviderManager agentId="claude_code" disabled={false} />
    );
    const user = userEvent.setup();

    await user.click(screen.getByText('可复用 Model Provider'));
    expect(
      (await screen.findAllByText('Claude Gateway')).length
    ).toBeGreaterThan(0);

    rerender(<AgentModelProviderManager agentId="gemini" disabled={false} />);
    expect(screen.queryByText('Claude Gateway')).not.toBeInTheDocument();
    await user.click(screen.getByText('可复用 Model Provider'));
    expect(
      (await screen.findAllByText('Gemini Gateway')).length
    ).toBeGreaterThan(0);
    expect(agentManagementApi.modelProviders).toHaveBeenLastCalledWith(
      'gemini'
    );
  });

  it('shows a native Codex provider as bound without edit or delete controls', async () => {
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
      models: [
        {
          id: 'official-a',
          label: 'Official A',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: 'official-a',
      error: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalogConfig).mockResolvedValue({
      customs: [],
      excluded_officials: [],
      default_model: 'deepseek-v4-flash',
      catalog_path: '/home/user/.codex/vibex-model-catalog.json',
      source_path: '/home/user/.codex/vibex-model-catalog.source.json',
      active: false,
    });

    render(<AgentModelProviderManager agentId="codex" disabled={false} />);
    await userEvent.click(screen.getByText('可复用 Model Provider'));

    // 绑定下拉展示原生 provider 当前绑定（只读，不可选择切换）。
    expect(
      await screen.findByText('DeepSeek Gateway（原生配置）')
    ).toBeInTheDocument();
    // 右侧摘要只显示默认模型与端点（分隔线为独立元素），不再显示 Provider
    // 名称或徽章。
    expect(
      screen.getByText('deepseek-v4-flash', {
        selector: '.agent-model-provider-summary-model',
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://api.deepseek.example/v1', {
        selector: '.agent-model-provider-summary-endpoint',
      })
    ).toBeInTheDocument();
    expect(screen.queryByText('DeepSeek Gateway')).not.toBeInTheDocument();
    // 原生 provider 不可被 VibeX 编辑或删除。
    expect(
      screen.queryByRole('button', { name: '编辑 DeepSeek Gateway' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '删除 DeepSeek Gateway' })
    ).not.toBeInTheDocument();
  });

  it('deletes a managed Codex provider from the binding list after a switch-default confirmation', async () => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        {
          id: 'provider-1',
          name: 'Gateway',
          agent_id: 'codex',
          api_url: 'https://gateway.example/v1',
          model: 'gpt-5.2',
          credential_present: true,
          bound: true,
          managed: true,
        },
      ],
      bound_provider_id: 'provider-1',
    });
    vi.mocked(agentManagementApi.codexModelCatalog).mockResolvedValue({
      agent_id: 'codex',
      source: 'cache',
      models: [
        {
          id: 'official-a',
          label: 'Official A',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: 'official-a',
      error: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalogConfig).mockResolvedValue({
      customs: [],
      excluded_officials: [],
      default_model: null,
      catalog_path: '/home/user/.codex/vibex-model-catalog.json',
      source_path: '/home/user/.codex/vibex-model-catalog.source.json',
      active: false,
    });
    vi.mocked(agentManagementApi.deleteModelProvider).mockResolvedValue({
      agent_id: 'codex',
      providers: [],
      bound_provider_id: null,
    });
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');

    render(<AgentModelProviderManager agentId="codex" disabled={false} />);
    await userEvent.click(screen.getByText('可复用 Model Provider'));
    await userEvent.click(
      await screen.findByLabelText('当前绑定的 Model Provider')
    );
    await userEvent.click(
      await screen.findByRole('button', { name: '删除 Gateway' })
    );

    expect(ConfirmDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          '删除后无法找回，并将默认切换到其他供应商或切换至官方订阅登录，确定继续吗',
        variant: 'destructive',
      })
    );
    expect(agentManagementApi.deleteModelProvider).toHaveBeenCalledWith(
      'codex',
      'provider-1'
    );
  });

  it('loads a managed Codex provider into the form through the binding list edit action', async () => {
    vi.mocked(agentManagementApi.modelProviders).mockResolvedValue({
      agent_id: 'codex',
      providers: [
        {
          id: 'provider-1',
          name: 'Gateway',
          agent_id: 'codex',
          api_url: 'https://gateway.example/v1',
          model: 'gpt-5.2',
          credential_present: true,
          bound: false,
          managed: true,
        },
      ],
      bound_provider_id: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalog).mockResolvedValue({
      agent_id: 'codex',
      source: 'cache',
      models: [
        {
          id: 'official-a',
          label: 'Official A',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: 'official-a',
      error: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalogConfig).mockResolvedValue({
      customs: [],
      excluded_officials: [],
      default_model: null,
      catalog_path: '/home/user/.codex/vibex-model-catalog.json',
      source_path: '/home/user/.codex/vibex-model-catalog.source.json',
      active: false,
    });

    render(<AgentModelProviderManager agentId="codex" disabled={false} />);
    await userEvent.click(screen.getByText('可复用 Model Provider'));
    await userEvent.click(
      await screen.findByLabelText('当前绑定的 Model Provider')
    );
    await userEvent.click(
      await screen.findByRole('button', { name: '编辑 Gateway' })
    );

    expect(screen.getByLabelText('Provider 名称')).toHaveValue('Gateway');
    expect(screen.getByLabelText('Provider API URL')).toHaveValue(
      'https://gateway.example/v1'
    );
    expect(
      screen.getByRole('button', { name: '保存修改' })
    ).toBeInTheDocument();
    expect(agentManagementApi.deleteModelProvider).not.toHaveBeenCalled();
  });
});
