import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { automationApi } from '@/lib/api/automations';
import { AutomationsSettings } from './AutomationsSettings';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [{ id: 'project-1', name: 'VibeX' }],
  }),
}));

vi.mock('@/lib/api/automations', () => ({
  automationApi: {
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    runNow: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    runs: vi.fn(async () => []),
  },
}));

describe('AutomationsSettings PluginAction', () => {
  it('inserts the same editable action blocks into an automation draft', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
          plugin: {
            id: 'vibex.office',
            name: 'VibeX Office',
            version: '2.0.0',
            membership: 'builtin',
          },
          actions: [
            {
              pluginId: 'vibex.office',
              actionId: 'create-presentation',
              label: '创建 PPT',
              requiredSkills: ['office-pptx'],
              requiredTools: ['officecli'],
              promptBlocks: [
                {
                  type: 'text',
                  text: '澄清受众与目标后，创建新的 PPTX 并验证输出。',
                },
              ],
              artifactIntent: {
                mediaTypes: [
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                ],
                provider: 'officecli',
              },
            },
          ],
          readiness: {
            enabled: true,
            dependency: { id: 'officecli', status: 'ready' },
            skills: [{ id: 'office-pptx', status: 'ready' }],
            providers: [{ id: 'officecli', status: 'ready' }],
            overall: 'ready',
          },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    render(<AutomationsSettings transport={transport} />);
    await user.click(screen.getByRole('button', { name: '新建自动化' }));
    await user.type(
      screen.getByRole('textbox', { name: '提示词' }),
      '面向董事会。'
    );
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));

    expect(screen.getByText('Skill · office-pptx')).toBeVisible();
    expect(screen.getByText('Tool · officecli')).toBeVisible();
    expect(screen.getByText('Artifact · PPTX')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue(
      '面向董事会。\n\n澄清受众与目标后，创建新的 PPTX 并验证输出。'
    );

    await user.type(
      screen.getByPlaceholderText('如：夜间跑测试'),
      '董事会路线图'
    );
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(automationApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '面向董事会。\n\n澄清受众与目标后，创建新的 PPTX 并验证输出。',
        plugin_action_json: expect.stringContaining(
          '"actionId":"create-presentation"'
        ),
      })
    );
  });

  it('does not resave a corrupt stored PluginAction', async () => {
    const user = userEvent.setup();
    vi.mocked(automationApi.list).mockResolvedValue([
      {
        id: 'automation-1',
        name: '董事会路线图',
        project_id: 'project-1',
        executor: 'CLAUDE_CODE',
        prompt: '保留原提示词',
        plugin_action_json: '{"pluginId":"vibex.office"}',
        isolation: 'in_place',
        trigger_kind: 'manual',
        cron: null,
        enabled: false,
        next_run_at: null,
        created_at: '2026-07-30T00:00:00Z',
        updated_at: '2026-07-30T00:00:00Z',
      },
    ]);
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => ({
        actions: [],
        readiness: {
          enabled: false,
          dependency: { id: 'officecli', status: 'missing' },
          skills: [],
          providers: [],
          overall: 'not_ready',
        },
      })),
    };

    render(<AutomationsSettings transport={transport} />);
    await screen.findByText('董事会路线图');
    await user.click(screen.getByTitle('编辑'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(automationApi.update).toHaveBeenCalledWith(
      'automation-1',
      expect.objectContaining({
        prompt: '保留原提示词',
        plugin_action_json: null,
      })
    );
  });
});
