import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { CodexModelCatalogEditor } from './CodexModelCatalogEditor';

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    codexModelCatalog: vi.fn(),
    codexModelCatalogConfig: vi.fn(),
    applyCodexModelCatalog: vi.fn(),
  },
}));

describe('CodexModelCatalogEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentManagementApi.codexModelCatalog).mockResolvedValue({
      agent_id: 'codex',
      source: 'live',
      models: [
        {
          id: 'gpt-official',
          label: 'GPT Official',
          context_window: null,
          reasoning_levels: ['low', 'high'],
        },
        {
          id: 'gpt-legacy',
          label: 'GPT Legacy',
          context_window: null,
          reasoning_levels: [],
        },
      ],
      default_model: 'gpt-official',
      error: null,
    });
    vi.mocked(agentManagementApi.codexModelCatalogConfig).mockResolvedValue({
      customs: [],
      excluded_officials: [],
      default_model: 'gpt-official',
      catalog_path: '/Users/example/.codex/vibex-model-catalog.json',
      source_path: '/Users/example/.codex/vibex-model-catalog.source.json',
      active: false,
    });
    vi.mocked(agentManagementApi.applyCodexModelCatalog).mockImplementation(
      async (request) => ({
        ...request,
        catalog_path: '/Users/example/.codex/vibex-model-catalog.json',
        source_path: '/Users/example/.codex/vibex-model-catalog.source.json',
        active: true,
      })
    );
  });

  it('loads on expansion and saves official exclusions plus a cloned custom model', async () => {
    render(<CodexModelCatalogEditor disabled={false} />);
    await userEvent.click(screen.getByText('高级模型清单'));
    expect(
      await screen.findByRole('checkbox', { name: /GPT Official/ })
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /GPT Legacy/ }));
    await userEvent.click(screen.getByRole('button', { name: '添加' }));
    const modelId = screen.getByLabelText('自定义模型 1 模型 ID');
    await userEvent.clear(modelId);
    await userEvent.type(modelId, 'gateway/sonnet');
    await userEvent.click(screen.getByText('高级行为与指令覆盖'));
    await userEvent.selectOptions(
      screen.getByLabelText('自定义模型 1 默认推理强度'),
      'high'
    );
    await userEvent.type(
      screen.getByLabelText('自定义模型 1 基础指令'),
      'Use the gateway tools.'
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Codex 模型清单默认项'),
      'gateway/sonnet'
    );
    await userEvent.click(screen.getByRole('button', { name: '保存模型清单' }));

    expect(agentManagementApi.applyCodexModelCatalog).toHaveBeenCalledWith({
      customs: [
        {
          slug: 'gateway/sonnet',
          display_name: null,
          context_window: null,
          base: 'gpt-official',
          overrides: {
            default_reasoning_level: 'high',
            base_instructions: 'Use the gateway tools.',
          },
        },
      ],
      excluded_officials: ['gpt-legacy'],
      default_model: 'gateway/sonnet',
    });
    expect(await screen.findByText(/目录已启用/)).toBeInTheDocument();
  });
});
