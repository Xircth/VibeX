import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { AgentModelProviderManager } from './AgentModelProviderManager';

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    modelProviders: vi.fn(),
    saveModelProvider: vi.fn(),
    bindModelProvider: vi.fn(),
    deleteModelProvider: vi.fn(),
  },
}));

describe('AgentModelProviderManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    await userEvent.selectOptions(
      screen.getByLabelText('当前绑定的 Model Provider'),
      'provider-1'
    );
    expect(agentManagementApi.bindModelProvider).toHaveBeenCalledWith(
      'claude_code',
      'provider-1'
    );
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
});
