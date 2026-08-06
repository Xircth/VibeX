import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { OpenCodeProviderConnections } from './OpenCodeProviderConnections';

describe('OpenCodeProviderConnections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists saved connections and writes a structured provider request', async () => {
    const initial = {
      providers: [
        {
          provider_id: 'openrouter',
          name: 'OpenRouter',
          npm: '@ai-sdk/openai-compatible',
          api: null,
          base_url: 'https://openrouter.ai/api/v1',
          models: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
            },
          ],
          credential_present: true,
          enabled: true,
        },
      ],
    };
    vi.spyOn(agentManagementApi, 'openCodeProviders').mockResolvedValue(
      initial
    );
    const connect = vi
      .spyOn(agentManagementApi, 'connectOpenCodeProvider')
      .mockResolvedValue(initial);
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(<OpenCodeProviderConnections onChanged={onChanged} />);

    expect(await screen.findByText('OpenRouter')).toBeInTheDocument();
    expect(screen.getByText(/凭据已保存/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Provider ID'), 'my-provider');
    await user.type(screen.getByLabelText('显示名称'), 'My Provider');
    await user.selectOptions(
      screen.getByLabelText('AI SDK 包'),
      '@ai-sdk/openai-compatible'
    );
    await user.type(screen.getByLabelText('API 适配器'), 'openai.responses');
    await user.type(
      screen.getByLabelText('API URL'),
      'https://api.example.com/v1'
    );
    await user.type(screen.getByLabelText('API Key'), 'secret-key');
    await user.click(screen.getByRole('button', { name: '添加模型' }));
    await user.type(screen.getByLabelText('第 1 个模型 ID'), 'model-a');
    await user.type(screen.getByLabelText('第 1 个模型名称'), 'Model A');
    await user.click(screen.getByRole('button', { name: '添加模型' }));
    await user.type(screen.getByLabelText('第 2 个模型 ID'), 'model-b');
    await user.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({
        provider_id: 'my-provider',
        name: 'My Provider',
        npm: '@ai-sdk/openai-compatible',
        api: 'openai.responses',
        base_url: 'https://api.example.com/v1',
        api_key: 'secret-key',
        models: [
          { id: 'model-a', name: 'Model A', previous_id: null },
          { id: 'model-b', name: 'model-b', previous_id: null },
        ],
        enabled: true,
      })
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('enables and disables a saved provider', async () => {
    const enabledView = {
      providers: [
        {
          provider_id: 'openrouter',
          name: 'OpenRouter',
          npm: '@ai-sdk/openai-compatible',
          api: 'openai.responses',
          base_url: 'https://openrouter.ai/api/v1',
          models: [],
          credential_present: true,
          enabled: true,
        },
      ],
    };
    const disabledView = {
      providers: [{ ...enabledView.providers[0], enabled: false }],
    };
    vi.spyOn(agentManagementApi, 'openCodeProviders').mockResolvedValue(
      enabledView
    );
    const setEnabled = vi
      .spyOn(agentManagementApi, 'setOpenCodeProviderEnabled')
      .mockResolvedValue(disabledView);
    const user = userEvent.setup();

    render(<OpenCodeProviderConnections />);

    await user.click(
      await screen.findByRole('switch', { name: '停用 OpenRouter' })
    );

    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith('openrouter', false)
    );
    expect(
      screen.getByRole('switch', { name: '启用 OpenRouter' })
    ).not.toBeChecked();
  });

  it('prefills a saved provider for explicit editing without exposing its credential', async () => {
    const view = {
      providers: [
        {
          provider_id: 'openrouter',
          name: 'OpenRouter',
          npm: '@ai-sdk/openai-compatible',
          api: 'openai.responses',
          base_url: 'https://openrouter.ai/api/v1',
          models: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
            },
          ],
          credential_present: true,
          enabled: true,
        },
      ],
    };
    vi.spyOn(agentManagementApi, 'openCodeProviders').mockResolvedValue(view);
    const connect = vi
      .spyOn(agentManagementApi, 'connectOpenCodeProvider')
      .mockResolvedValue(view);

    render(<OpenCodeProviderConnections />);
    await userEvent.click(
      await screen.findByRole('button', { name: '编辑 OpenRouter' })
    );

    expect(screen.getByLabelText('Provider ID')).toHaveValue('openrouter');
    expect(screen.getByLabelText('API URL')).toHaveValue(
      'https://openrouter.ai/api/v1'
    );
    expect(screen.getByLabelText('第 1 个模型 ID')).toHaveValue(
      'anthropic/claude-sonnet-4'
    );
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).not.toBeRequired();

    await userEvent.clear(screen.getByLabelText('第 1 个模型 ID'));
    await userEvent.type(screen.getByLabelText('第 1 个模型 ID'), 'renamed');
    await userEvent.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          api_key: null,
          models: [
            {
              id: 'renamed',
              name: 'Claude Sonnet 4',
              previous_id: 'anthropic/claude-sonnet-4',
            },
          ],
        })
      )
    );
  });

  it('searches the models.dev catalog and adopts a provider model set', async () => {
    vi.spyOn(agentManagementApi, 'openCodeProviders').mockResolvedValue({
      providers: [],
    });
    vi.spyOn(agentManagementApi, 'openCodeProviderCatalog').mockResolvedValue({
      source: 'bundled',
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          npm: '@ai-sdk/openai-compatible',
          env: ['OPENROUTER_API_KEY'],
          doc: 'https://openrouter.ai/docs',
          auth_kind: 'api',
          models: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
              reasoning: true,
              tool_call: true,
              context: 200000,
              cost_in: 3,
              cost_out: 15,
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();

    render(<OpenCodeProviderConnections />);

    await user.type(
      await screen.findByRole('searchbox', { name: '搜索 Provider' }),
      'openrouter'
    );
    await user.click(screen.getByRole('button', { name: /选择 OpenRouter/ }));

    expect(screen.getByLabelText('Provider ID')).toHaveValue('openrouter');
    expect(screen.getByLabelText('AI SDK 包')).toHaveValue(
      '@ai-sdk/openai-compatible'
    );
    expect(screen.getByLabelText('第 1 个模型 ID')).toHaveValue(
      'anthropic/claude-sonnet-4'
    );
    expect(screen.getByText('离线内置目录')).toBeInTheDocument();
  });
});
