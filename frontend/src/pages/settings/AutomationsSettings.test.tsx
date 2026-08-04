import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import i18n from '@/i18n';
import type { BackendTransport } from '@/lib/backendTransport';
import { AutomationsSettings } from './AutomationsSettings';

function renderSettings(
  transport: BackendTransport,
  pollIntervalMs?: number,
  withRouter = false
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const settings = (
    <QueryClientProvider client={queryClient}>
      <AutomationsSettings
        transport={transport}
        pollIntervalMs={pollIntervalMs}
      />
    </QueryClientProvider>
  );
  return render(
    withRouter ? <MemoryRouter>{settings}</MemoryRouter> : settings
  );
}

function createTransport(
  options: {
    withComposerControls?: boolean;
    automations?: object[];
    templates?: object[];
    runNow?: object;
    runResponses?: object[][];
    failListOnce?: boolean;
    engineOwner?: boolean;
    projects?: object[];
  } = {}
) {
  let runResponseIndex = 0;
  let listAttempts = 0;
  const call = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'automation_engine_status':
          return { active: options.engineOwner ?? true };
        case 'automation_list':
          listAttempts += 1;
          if (options.failListOnce && listAttempts === 1) {
            throw new Error('database temporarily unavailable');
          }
          return options.automations ?? [];
        case 'automation_templates':
          return options.templates ?? [];
        case 'get_projects':
          return (
            options.projects ?? [
              {
                id: 'project-1',
                name: 'VibeX',
                created_at: '2026-07-30T00:00:00Z',
              },
            ]
          );
        case 'get_project_repositories':
          return [
            {
              id: 'repo-1',
              project_id: 'project-1',
              display_name: 'VibeX',
              path: '/workspace/VibeX',
              default_target_branch: 'main',
            },
          ];
        case 'get_repo_branches':
          return [
            { name: 'main', is_current: true },
            { name: 'feature/automation', is_current: false },
          ];
        case 'agent_management_bar':
          return [
            {
              agent_id: 'codex',
              display_name: 'Codex',
              enabled: true,
              retired: false,
              lifecycle: 'ready',
            },
          ];
        case 'agent_capability_catalog':
          return options.withComposerControls
            ? {
                current_mode: 'plan',
                modes: [
                  { id: 'plan', label: 'Plan' },
                  { id: 'agent', label: 'Agent' },
                ],
                config_options: [
                  {
                    key: 'model',
                    label: 'Model',
                    category: 'model',
                    value: 'balanced',
                    choices: [
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'fast', label: 'Fast' },
                    ],
                  },
                ],
              }
            : {
                current_mode: null,
                modes: [],
                config_options: [],
              };
        case 'plugin_action_catalog':
          return options.withComposerControls
            ? {
                actions: [
                  {
                    pluginId: 'office',
                    actionId: 'create-presentation',
                    label: 'Create presentation',
                    requiredSkills: ['slides'],
                    requiredTools: ['officecli'],
                    promptBlocks: [
                      { type: 'text', text: 'Create an editable deck.' },
                    ],
                    artifactIntent: {
                      mediaTypes: [
                        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                      ],
                      provider: 'officecli',
                    },
                  },
                ],
              }
            : { actions: [] };
        case 'automation_preview_next_runs':
          return [
            '2026-07-31T01:30:00Z',
            '2026-08-01T01:30:00Z',
            '2026-08-02T01:30:00Z',
          ];
        case 'automation_create':
          return {
            id: 'automation-1',
            ...(args?.input as object),
            specVersion: 1,
            nextRunAt: null,
            migrationRequired: false,
            unseenFailureCount: 0,
            lastRunStatus: null,
            createdAt: '2026-07-30T00:00:00Z',
            updatedAt: '2026-07-30T00:00:00Z',
          };
        case 'automation_run_now':
          return options.runNow;
        case 'automation_runs': {
          const responses = options.runResponses ?? [[]];
          const response =
            responses[Math.min(runResponseIndex, responses.length - 1)];
          runResponseIndex += 1;
          return response;
        }
        case 'automation_cancel_run':
          return null;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    }
  );
  return {
    transport: {
      environment: 'desktop' as const,
      call,
    },
    call,
  };
}

function automationView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'automation-1',
    name: 'Nightly review',
    enabled: true,
    specVersion: 1,
    trigger: { kind: 'manual' },
    nextRunAt: null,
    launch: {
      specVersion: 1,
      promptBlocks: [{ type: 'text', text: 'Review the branch.' }],
      displayText: 'Review the branch.',
      agent: {
        agentId: 'codex',
        executorProfileId: { executor: 'codex', variant: null },
      },
      modeId: null,
      configValues: [],
      pluginActions: [],
      skills: [],
      workspace: {
        projectId: 'project-1',
        rootFolder: '/workspace/VibeX',
        branch: 'main',
        isolation: 'worktree_per_run',
      },
      labelSnapshot: 'Nightly review',
    },
    migrationRequired: false,
    unseenFailureCount: 0,
    lastRunStatus: null,
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
    ...overrides,
  };
}

function runView(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    trigger: 'manual',
    scheduledFor: null,
    status,
    cancellationRequested: false,
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    workspaceId: 'workspace-run-1',
    stopReason: null,
    summary: null,
    error: null,
    seen: false,
    startedAt: '2026-07-30T01:00:00Z',
    finishedAt: status === 'running' ? null : '2026-07-30T01:01:00Z',
    ...overrides,
  };
}

describe('AutomationsSettings', () => {
  it('describes the user-facing scheduling capability without implementation details', async () => {
    const { transport } = createTransport();
    renderSettings(transport);

    expect(await screen.findByText('让任务按需或定时自动运行。')).toBeVisible();
    expect(screen.queryByText(/worktree|IANA|后端/)).not.toBeInTheDocument();
  });

  it('explains an empty project list and links to project setup', async () => {
    const user = userEvent.setup();
    const { transport } = createTransport({ projects: [] });
    renderSettings(transport, undefined, true);

    await user.click(await screen.findByRole('button', { name: '新建自动化' }));

    expect(screen.getByRole('combobox', { name: '项目' })).toBeDisabled();
    expect(screen.getByText('还没有可用于自动化的项目。')).toBeVisible();
    expect(screen.getByRole('link', { name: '添加项目' })).toHaveAttribute(
      'href',
      '/local-projects'
    );
  });

  it('shows a read-only state when another host owns the Automation Engine', async () => {
    const { transport, call } = createTransport({
      automations: [automationView()],
      engineOwner: false,
    });
    renderSettings(transport);

    expect(
      await screen.findByRole('status', {
        name: /Automation Engine.*another host|自动化引擎.*其他宿主/i,
      })
    ).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: /Run Nightly review|运行 Nightly review/i,
      })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /New automation|新建自动化/i })
    ).toBeDisabled();
    expect(call).toHaveBeenCalledWith('automation_engine_status');
  });

  beforeEach(() => {
    vi.useRealTimers();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
  });
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('zh-CN');
  });

  it('creates a manual Automation from canonical Composer input in an isolated worktree', async () => {
    const user = userEvent.setup();
    const { transport, call } = createTransport();
    renderSettings(transport);

    await user.click(await screen.findByRole('button', { name: '新建自动化' }));
    await user.type(screen.getByRole('textbox', { name: '名称' }), '检查变更');

    const composer = screen.getByRole('textbox', { name: '消息' });
    composer.textContent = '检查当前分支并总结风险。';
    fireEvent.input(composer);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('automation_create', {
        input: {
          name: '检查变更',
          enabled: true,
          trigger: { kind: 'manual' },
          launch: {
            promptBlocks: [{ type: 'text', text: '检查当前分支并总结风险。' }],
            displayText: '检查当前分支并总结风险。',
            agent: {
              agentId: 'codex',
              executorProfileId: {
                executor: 'codex',
                variant: null,
              },
            },
            modeId: null,
            configValues: [],
            pluginActions: [],
            skills: [],
            workspace: {
              projectId: 'project-1',
              rootFolder: '/workspace/VibeX',
              branch: 'main',
              isolation: 'worktree_per_run',
            },
            labelSnapshot: '检查变更',
          },
        },
      });
    });
  });

  it('uses the backend to preview a cron builder schedule in its IANA timezone', async () => {
    const user = userEvent.setup();
    const { transport, call } = createTransport();
    renderSettings(transport);

    await user.click(await screen.findByRole('button', { name: '新建自动化' }));
    screen.getByRole('combobox', { name: '触发' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByRole('option', { name: '定时 (cron)' }));

    const timezone = screen.getByRole('textbox', { name: 'IANA 时区' });
    await user.clear(timezone);
    await user.type(timezone, 'Asia/Shanghai');
    fireEvent.change(screen.getByLabelText('运行时间'), {
      target: { value: '09:30' },
    });
    await user.click(
      screen.getByRole('button', { name: '预览接下来 5 次运行' })
    );

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('automation_preview_next_runs', {
        cron: '30 9 * * *',
        timezone: 'Asia/Shanghai',
        count: 5,
      });
    });
    expect(
      await screen.findByRole('list', { name: '后端计算的运行预览' })
    ).toHaveTextContent('2026');
  }, 15_000);

  it('saves the shared Agent controls and an editable PluginAction', async () => {
    const user = userEvent.setup();
    const { transport, call } = createTransport({
      withComposerControls: true,
    });
    renderSettings(transport);

    await user.click(await screen.findByRole('button', { name: '新建自动化' }));
    await user.type(screen.getByRole('textbox', { name: '名称' }), '生成周报');
    const composer = screen.getByRole('textbox', { name: '消息' });
    composer.textContent = '根据本周记录生成汇报。';
    fireEvent.input(composer);

    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));
    const actionPrompt = screen.getByRole('textbox', {
      name: '动作提示词',
    });
    await user.clear(actionPrompt);
    await user.type(actionPrompt, 'Create a concise editable weekly deck.');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const createCall = call.mock.calls.find(
        ([command]) => command === 'automation_create'
      );
      expect(createCall?.[1]).toMatchObject({
        input: {
          launch: {
            modeId: 'plan',
            configValues: [{ key: 'model', value: 'balanced' }],
            pluginActions: [
              {
                pluginId: 'office',
                action: {
                  id: 'create-presentation',
                  requiredSkills: ['slides'],
                  requiredTools: ['officecli'],
                  promptBlocks: [
                    {
                      type: 'text',
                      text: 'Create a concise editable weekly deck.',
                    },
                  ],
                  artifactIntent: {
                    provider: 'officecli',
                  },
                },
              },
            ],
          },
        },
      });
    });
  }, 15_000);

  it('opens one of seven templates as an editable draft without running it', async () => {
    const user = userEvent.setup();
    const templates = Array.from({ length: 7 }, (_, index) => ({
      id: index === 0 ? 'code-review' : `template-${index + 1}`,
      draft: {
        name: index === 0 ? 'Code review' : `Template ${index + 1}`,
        enabled: false,
        trigger: { kind: 'manual' },
        launch: automationView().launch,
      },
    }));
    const { transport, call } = createTransport({ templates });
    renderSettings(transport);

    expect(
      await screen.findAllByRole('button', { name: /使用模板/ })
    ).toHaveLength(7);
    await user.click(
      screen.getByRole('button', { name: '使用模板 Code review' })
    );
    const name = screen.getByRole('textbox', { name: '名称' });
    expect(name).toHaveValue('Code review');
    await user.clear(name);
    await user.type(name, '每晚审查');

    expect(call).not.toHaveBeenCalledWith(
      'automation_create',
      expect.anything()
    );
    expect(call).not.toHaveBeenCalledWith(
      'automation_run_now',
      expect.anything()
    );
    expect(name).toHaveValue('每晚审查');
  });

  it('follows backend Run status through a real Turn and can cancel it', async () => {
    const user = userEvent.setup();
    const running = runView('running');
    const { transport, call } = createTransport({
      automations: [automationView()],
      runNow: running,
      runResponses: [
        [running],
        [runView('completed', { summary: 'Artifact report.pptx' })],
      ],
    });
    renderSettings(transport, 1_000);

    await user.click(
      await screen.findByRole('button', { name: '运行 Nightly review' })
    );
    expect(await screen.findByText('运行中')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消运行' }));
    expect(call).toHaveBeenCalledWith('automation_cancel_run', {
      runId: 'run-1',
    });
    expect(
      await screen.findByText('已完成', {}, { timeout: 3_000 })
    ).toBeInTheDocument();
    expect(screen.getByText('Artifact report.pptx')).toBeInTheDocument();
  });

  it('renders skipped and Interrupted exactly as backend terminal states', async () => {
    const user = userEvent.setup();
    const { transport } = createTransport({
      automations: [
        automationView({
          unseenFailureCount: 2,
          lastRunStatus: 'interrupted',
        }),
      ],
      runResponses: [
        [
          runView('skipped', {
            id: 'run-skip',
            stopReason: 'overlapping_run',
          }),
          runView('interrupted', {
            id: 'run-interrupted',
            stopReason: 'restart_reconciliation',
          }),
        ],
      ],
    });
    renderSettings(transport);

    await user.click(
      await screen.findByRole('button', {
        name: '查看 Nightly review 的运行历史',
      })
    );
    expect(await screen.findByText('已跳过')).toBeInTheDocument();
    expect(screen.getByText('已中断')).toBeInTheDocument();
    expect(screen.getByText('2 次未读失败')).toBeInTheDocument();
    expect(screen.getByText(/上次：已中断/)).toBeInTheDocument();
  });

  it('recovers an accessible empty state after a transport error', async () => {
    const user = userEvent.setup();
    const { transport } = createTransport({ failListOnce: true });
    renderSettings(transport);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'database temporarily unavailable'
    );
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(
      await screen.findByRole('button', { name: '新建自动化' })
    ).toBeInTheDocument();
    expect(screen.getByText('还没有运行计划')).toBeInTheDocument();
  });

  it('keeps an invalid draft editable and does not send it', async () => {
    const user = userEvent.setup();
    const { transport, call } = createTransport();
    renderSettings(transport);

    await user.click(await screen.findByRole('button', { name: '新建自动化' }));
    await user.type(
      screen.getByRole('textbox', { name: '名称' }),
      '缺少提示词'
    );
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(call).not.toHaveBeenCalledWith(
      'automation_create',
      expect.anything()
    );
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue(
      '缺少提示词'
    );
  });

  it('provides English labels and an explicit shared-root risk', async () => {
    await i18n.changeLanguage('en');
    const user = userEvent.setup();
    const { transport } = createTransport();
    renderSettings(transport);

    await user.click(
      await screen.findByRole('button', { name: 'New automation' })
    );
    const isolation = screen.getByRole('combobox', { name: 'Isolation' });
    isolation.focus();
    await user.keyboard('{ArrowDown}');
    await user.click(
      screen.getByRole('option', { name: 'Shared project root' })
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'backend rejects dirty roots'
    );
  });

  it('preserves a saved non-default branch while editing', async () => {
    const user = userEvent.setup();
    const existing = automationView();
    existing.launch.workspace.branch = 'feature/automation';
    const { transport, call } = createTransport({ automations: [existing] });
    renderSettings(transport);

    await user.click(
      await screen.findByRole('button', { name: '编辑 Nightly review' })
    );
    expect(
      await screen.findByRole('button', { name: 'feature/automation' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'automation_update',
        expect.objectContaining({
          id: 'automation-1',
          input: expect.objectContaining({
            launch: expect.objectContaining({
              workspace: expect.objectContaining({
                branch: 'feature/automation',
              }),
            }),
          }),
        })
      );
    });
  });
});
