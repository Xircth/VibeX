import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexModelCatalogConfigRequest } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { pickAstryxOption } from './agentSettingsTestUtils';
import {
  CodexModelCatalogEditor,
  CodexModelConfigFields,
} from './CodexModelCatalogEditor';

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
    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('自定义模型 1 默认推理强度'),
      'high'
    );
    await userEvent.type(
      screen.getByLabelText('自定义模型 1 基础指令'),
      'Use the gateway tools.'
    );
    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('Codex 模型清单默认项'),
      'gateway/sonnet · 自定义'
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

  it('keeps focus while typing a custom model id', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [draft, setDraft] = useState<CodexModelCatalogConfigRequest>({
        customs: [
          {
            slug: 'custom-model-1',
            display_name: null,
            context_window: null,
            base: 'gpt-official',
            overrides: null,
          },
        ],
        excluded_officials: [],
        default_model: null,
      });
      return (
        <CodexModelConfigFields
          catalog={{
            agent_id: 'codex',
            source: 'live',
            models: [
              {
                id: 'gpt-official',
                label: 'GPT Official',
                context_window: null,
                reasoning_levels: [],
              },
            ],
            default_model: null,
            error: null,
          }}
          defaultModels={[
            {
              id: 'gpt-5.5',
              label: 'GPT-5.5',
              context_window: null,
              reasoning_levels: [],
            },
          ]}
          disabled={false}
          draft={draft}
          showOfficialModels={false}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    const modelId = screen.getByLabelText('自定义模型 1 模型 ID');
    await user.click(modelId);
    await user.keyboard('a');
    expect(screen.getByLabelText('自定义模型 1 模型 ID')).toHaveFocus();
    expect(screen.getByLabelText('自定义模型 1 模型 ID')).toHaveValue(
      'custom-model-1a'
    );
  });

  it('includes custom models in the default model picker', async () => {
    const user = userEvent.setup();
    render(
      <CodexModelConfigFields
        catalog={{
          agent_id: 'codex',
          source: 'live',
          models: [],
          default_model: null,
          error: null,
        }}
        defaultModels={[
          {
            id: 'gpt-5.5',
            label: 'GPT-5.5',
            context_window: null,
            reasoning_levels: [],
          },
        ]}
        disabled={false}
        draft={{
          customs: [
            {
              slug: 'my-gateway-model',
              display_name: 'Gateway',
              context_window: null,
              base: 'gpt-5.5',
              overrides: null,
            },
          ],
          excluded_officials: [],
          default_model: null,
        }}
        showOfficialModels={false}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByLabelText('Codex 模型清单默认项'));
    expect(
      screen.getByRole('option', { name: 'Gateway · 自定义' })
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: 'GPT-5.5 · gpt-5.5' })
    ).toBeVisible();
  });
});
