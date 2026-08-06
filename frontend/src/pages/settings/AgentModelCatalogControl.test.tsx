import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { AgentModelCatalogControl } from './AgentModelCatalogControl';

vi.mock('@/features/agent-management', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/agent-management')>();
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      codexModelCatalog: vi.fn(),
      cursorModelCatalog: vi.fn(),
      kimiModelCatalog: vi.fn(),
    },
  };
});

describe('AgentModelCatalogControl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads Cursor Runtime models and projects a selection into native config', async () => {
    vi.mocked(agentManagementApi.cursorModelCatalog).mockResolvedValue({
      agent_id: 'cursor',
      source: 'live',
      models: [
        {
          id: 'composer-1',
          label: 'Composer 1',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: 'composer-1',
      error: null,
    });
    const onSelect = vi.fn();
    render(
      <AgentModelCatalogControl
        agentId="cursor"
        drafts={{ cursor_model: '' }}
        disabled={false}
        onSelect={onSelect}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: '读取模型' }));
    expect(await screen.findByText(/1 个模型/)).toHaveTextContent(
      'Runtime 实时目录'
    );
    await userEvent.selectOptions(
      screen.getByLabelText('选择目录模型'),
      'composer-1'
    );
    expect(onSelect).toHaveBeenCalledWith('cursor_model', 'composer-1');
  });

  it('uses only the current Kimi endpoint and key draft', async () => {
    vi.mocked(agentManagementApi.kimiModelCatalog).mockRejectedValue(
      new Error('Key 无权读取模型')
    );
    render(
      <AgentModelCatalogControl
        agentId="kimi_code"
        drafts={{
          kimi_base_url: 'https://api.example/v1',
          kimi_api_key: 'new-key',
        }}
        disabled={false}
        onSelect={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: '读取模型' }));
    expect(agentManagementApi.kimiModelCatalog).toHaveBeenCalledWith(
      'https://api.example/v1',
      'new-key'
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Key 无权读取模型'
    );
  });
});
