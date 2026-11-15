import { Theme as AstryxTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowDefinitionSummary,
  WorkflowVersionView,
} from 'shared/types';
import { CANONICAL_WORKFLOW_STARTERS } from '@/components/kanban/automation/automationAgentBridge';
import { workflowsApi } from '@/features/workflow/workflowApi';
import i18n from '@/i18n';
import { projectsApi } from '@/lib/api/projects';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
import { sessionsApi } from '@/lib/api/sessions';
import { shouldShowKanbanMonitor } from '@/lib/kanbanZoneVisibility';
import { BoundHostTransport } from '@/lib/transport/boundHostTransport';
import type { RemoteDesktopTransport } from '@/lib/transport/remoteDesktopTransport';
import { PulseDeckView } from './PulseDeckView';
import { stashPendingWorkflowStudioOpen } from './pulseDeckEvents';

function renderDeck(projectId = 'proj-1') {
  return render(
    <AstryxTheme theme={neutralTheme} mode="light">
      <PulseDeckView projectId={projectId} />
    </AstryxTheme>
  );
}

vi.mock('@/features/workflow/WorkflowStudioDockPanel', () => ({
  WorkflowStudioDockPanel: () => (
    <div data-testid="mock-embedded-workflow-studio-canvas">
      Embedded Workflow Studio Canvas
    </div>
  ),
}));

vi.mock('@/features/workflow/workflowApi', () => ({
  workflowsApi: {
    listDefinitions: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    deleteDefinition: vi.fn(),
  },
}));

vi.mock('@/lib/api/sessions', () => ({
  sessionsApi: {
    createProject: vi.fn(),
  },
}));

vi.mock('@/lib/api/projects', () => ({
  projectsApi: {
    getAll: vi.fn().mockResolvedValue([
      {
        id: 'proj-1',
        name: 'VibeX',
        default_agent_working_dir: '/repo/vibex',
      },
    ]),
  },
}));

vi.mock('@/lib/api/pulse', () => ({
  pulseApi: {
    deckSnapshot: vi.fn(),
    upsertSource: vi.fn(),
    deleteSource: vi.fn(),
    testSource: vi.fn(),
    saveRule: vi.fn(),
    deleteRule: vi.fn(),
    promoteObservedCandidate: vi.fn(),
    dryRunRule: vi.fn(),
    setRuleMode: vi.fn(),
    setRuleEnabled: vi.fn(),
    emitCustomEvent: vi.fn(),
    listCapturedEvents: vi.fn(),
    resolveUserInteraction: vi.fn(),
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
  },
}));

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn().mockResolvedValue(() => undefined),
  };
});

function makeWorkflowSummaries(): WorkflowDefinitionSummary[] {
  const ciStarter = CANONICAL_WORKFLOW_STARTERS[0]!;
  return [
    {
      id: 'wf-triage',
      name: 'CI Incident Multi-Step Triage',
      latestVersionId: 'wfv-1',
      latestVersion: 2n,
      latestNormalizedJson: JSON.stringify(ciStarter.definition),
      updatedAt: '2026-11-15T10:00:00Z',
    },
  ];
}

function makeSnapshot(): PulseDeckSnapshot {
  return {
    engineActive: true,
    activeTicketCount: 2,
    pendingUserInteractionCount: 0,
    busyRuleIds: [],
    recentOutbox: [
      {
        id: 'outbox-1',
        ruleId: 'rule-1',
        targetKind: 'feishu_webhook',
        destination: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo',
        status: 'delivered',
        attempts: 1,
        createdAt: '2026-11-15T00:08:00Z',
        updatedAt: '2026-11-15T00:08:02Z',
      },
    ],
    sources: [
      {
        id: 'src-gh',
        kind: 'github',
        title: 'GitHub Main Webhook',
        enabled: true,
        healthy: true,
        statusMessage: null,
        cursorWatermark: 'ev_1092',
        publicWebhookPath: '/api/pulse/webhooks/src-gh',
        configJson: {
          mode: 'poll',
          repo: 'vibex/core',
          pollIntervalSeconds: 60,
        },
        receivedCount24h: 42,
        rejectedCount24h: 0,
        updatedAt: '2026-11-15T00:00:00Z',
      },
    ],
    rules: [
      {
        id: 'rule-1',
        revision: 1,
        enabled: true,
        draftOnly: false,
        mandateOrigin: 'explicit_human',
        spec: {
          name: 'Jira 缺陷自动排查',
          evalMode: 'auto',
          filter: {
            sourceKinds: ['jira'],
            sourceInstanceIds: [],
            eventTypes: ['jira.issue.created'],
            allowedActors: [],
            conditions: [{ op: 'not_bot_actor' }],
          },
          targets: [
            {
              kind: 'session',
              mode: 'ephemeral_fresh',
              agentId: 'claude_code',
              workspaceIsolation: 'isolated_worktree',
              promptTemplate: '排查 Jira 缺陷 {{payload.summary}}',
            },
            {
              kind: 'user',
              interactionKind: 'notify',
              titleTemplate: '排查完成通知',
              bodyTemplate: '已完成缺陷排查',
            },
          ],
          taskMeta: {
            taskKind: 'fast_task',
            lifecycleState: 'published',
          },
        },
        matchedCount: 5,
        observedCount: 0,
        createdAt: '2026-11-15T00:00:00Z',
        updatedAt: '2026-11-15T00:00:00Z',
      },
      {
        id: 'rule-wf-trigger',
        revision: 1,
        enabled: true,
        draftOnly: false,
        mandateOrigin: 'explicit_human',
        spec: {
          name: 'Trigger CI Workflow',
          evalMode: 'auto',
          filter: {
            sourceKinds: ['github'],
            sourceInstanceIds: ['src-gh'],
            eventTypes: ['github.workflow_run.completed'],
            allowedActors: [],
            conditions: [],
          },
          targets: [
            {
              kind: 'workflow',
              workflowId: 'wf-triage',
              pinnedVersion: 2,
            },
          ],
          taskMeta: {
            taskKind: 'workflow_trigger',
            lifecycleState: 'published',
          },
        },
        matchedCount: 9,
        observedCount: 0,
        createdAt: '2026-11-15T00:00:00Z',
        updatedAt: '2026-11-15T00:00:00Z',
      },
      {
        id: 'rule-tpl-1',
        revision: 1,
        enabled: true,
        draftOnly: false,
        mandateOrigin: 'explicit_human',
        spec: {
          name: 'Reusable CI Failure Filter',
          evalMode: 'observe',
          filter: {
            sourceKinds: ['github'],
            sourceInstanceIds: [],
            eventTypes: ['github.workflow_run.completed'],
            allowedActors: [],
            conditions: [
              {
                op: 'eq',
                pointer: '/workflow_run/conclusion',
                value: 'failure',
              },
            ],
          },
          targets: [],
          taskMeta: {
            taskKind: 'reusable_rule',
            lifecycleState: 'published',
          },
        },
        matchedCount: 12,
        observedCount: 4,
        createdAt: '2026-11-15T00:00:00Z',
        updatedAt: '2026-11-15T00:00:00Z',
      },
    ],
    observedCandidates: [],
    subscriptions: [],
    pendingInteractions: [],
  };
}

describe('PulseDeckView (Agent-First 2-Tab Automation Workbench)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    stashPendingWorkflowStudioOpen(null);
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(makeSnapshot());
    vi.mocked(pulseApi.listCapturedEvents).mockResolvedValue([]);
    vi.mocked(workflowsApi.listDefinitions).mockResolvedValue(
      makeWorkflowSummaries()
    );
    vi.mocked(workflowsApi.deleteDefinition).mockResolvedValue(true);
    vi.mocked(pulseApi.deleteRule).mockResolvedValue(undefined);
    vi.mocked(projectsApi.getAll).mockResolvedValue([
      {
        id: 'proj-1',
        name: 'VibeX',
        default_agent_working_dir: '/repo/vibex',
      } as never,
    ]);
  });

  it('keeps the Kanban monitor zone visible whenever Automation Tasks is open even with 0 monitored sessions', () => {
    expect(shouldShowKanbanMonitor(true, 0, false)).toBe(false);
    expect(shouldShowKanbanMonitor(true, 0, true)).toBe(true);
    expect(shouldShowKanbanMonitor(false, 0, true)).toBe(true);
  });

  it('renders only 2 primary tabs (自动化任务 + 事件源), unified semantic chains, governance groups, enable switch, delete, and embedded Workflow Studio', async () => {
    const user = userEvent.setup();
    vi.mocked(pulseApi.setRuleEnabled).mockResolvedValue({
      ...makeSnapshot().rules[1]!,
      enabled: false,
    });

    renderDeck('proj-1');

    // Only 2 primary tabs exist; Pending Events and Rules tabs are completely removed
    expect(await screen.findByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveTextContent(
      '自动化任务'
    );
    expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveTextContent(
      '事件源'
    );
    expect(
      screen.queryByTestId('pulse-deck-tab-pending')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('pulse-deck-tab-rules')
    ).not.toBeInTheDocument();

    // Agent-First creation CTA replaces legacy manual split menus
    expect(screen.getByTestId('automation-agent-create-btn')).toHaveTextContent(
      '让 Agent 创建'
    );
    expect(
      screen.queryByTestId('automation-new-menu-btn')
    ).not.toBeInTheDocument();

    // Both WorkflowDefinition and legacy PulseRule project into unified task rows; routing/reusable rules stay hidden
    expect(
      await screen.findByTestId('automation-task-row-wf-triage')
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId('automation-task-row-rule-1')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('automation-task-row-rule-wf-trigger')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('automation-task-row-rule-tpl-1')
    ).not.toBeInTheDocument();

    // Semantic chains display human-centric [从哪来 → 触发谁 → 结果给谁]
    expect(
      screen.getByTestId('automation-task-pipeline-wf-triage')
    ).toHaveTextContent('GitHub');
    expect(
      screen.getByTestId('automation-task-pipeline-rule-1')
    ).toHaveTextContent('Jira');

    // Governance group header collapses and expands cleanly
    expect(
      screen.getByTestId('automation-group-header-active')
    ).toHaveTextContent('启用中');
    await user.click(screen.getByTestId('automation-group-header-active'));
    expect(
      screen.queryByTestId('automation-task-row-wf-triage')
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('automation-group-header-active'));
    expect(
      await screen.findByTestId('automation-task-row-wf-triage')
    ).toBeInTheDocument();

    // Enable/disable switch calls pulseApi.setRuleEnabled without opening canvas
    await user.click(
      screen.getByRole('switch', { name: /CI Incident Multi-Step Triage/ })
    );
    await waitFor(() => {
      expect(pulseApi.setRuleEnabled).toHaveBeenCalledWith(
        'rule-wf-trigger',
        false
      );
    });

    // Clicking any task row opens the embedded Workflow Canvas directly
    await user.click(screen.getByTestId('automation-task-row-wf-triage'));
    expect(
      await screen.findByTestId('automation-embedded-workflow-studio')
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId('mock-embedded-workflow-studio-canvas')
    ).toBeInTheDocument();

    // Back button returns cleanly to Task List
    await user.click(screen.getByTestId('embedded-studio-back-btn'));
    expect(
      await screen.findByTestId('automation-tasks-list')
    ).toBeInTheDocument();

    // Unified delete removes both the WorkflowDefinition and its linked trigger rule
    await user.click(screen.getByTestId('automation-task-delete-wf-triage'));
    await waitFor(() => {
      expect(workflowsApi.deleteDefinition).toHaveBeenCalledWith('wf-triage');
      expect(pulseApi.deleteRule).toHaveBeenCalledWith('rule-wf-trigger');
    });
  });

  it('renders the 4 canonical workflow starter cards when empty, enables starters in 1 click, and dispatches Agent authoring sessions', async () => {
    const user = userEvent.setup();
    const emptySnapshot = makeSnapshot();
    emptySnapshot.rules = [];
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(emptySnapshot);
    vi.mocked(workflowsApi.listDefinitions).mockResolvedValue([]);
    vi.mocked(workflowsApi.publish).mockResolvedValue({
      id: 'wfv-starter-1',
      definitionId: 'wf-ci-autofix',
      version: 1n,
      digest: 'sha256:starter',
      normalizedJson: '{}',
      sourcePath: null,
      createdAt: '2026-11-16T00:00:00Z',
    } as WorkflowVersionView);
    vi.mocked(pulseApi.saveRule).mockImplementation(async ({ spec }) => ({
      id: 'rule-starter-1',
      revision: 1,
      enabled: true,
      draftOnly: false,
      mandateOrigin: 'explicit_human',
      spec,
      matchedCount: 0,
      observedCount: 0,
      createdAt: '2026-11-16T00:00:00Z',
      updatedAt: '2026-11-16T00:00:00Z',
    }));
    vi.mocked(sessionsApi.createProject).mockResolvedValue({
      conversation: { id: 'conv-agent-1' },
    } as never);

    renderDeck('proj-1');

    expect(
      await screen.findByTestId('automation-starter-gallery')
    ).toBeInTheDocument();
    for (const starter of CANONICAL_WORKFLOW_STARTERS) {
      expect(
        screen.getByTestId(`automation-starter-card-${starter.id}`)
      ).toBeInTheDocument();
    }

    // 1-click enable starter publishes canonical workflow and saves workflow_trigger rule
    await user.click(
      screen.getByTestId('automation-apply-starter-github-ci-autofix')
    );
    await waitFor(() => {
      expect(workflowsApi.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'PR CI 失败自动排查并评论' })
      );
      expect(pulseApi.saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          spec: expect.objectContaining({
            targets: [
              expect.objectContaining({
                kind: 'workflow',
                workflowId: 'wf-ci-autofix',
                pinnedVersion: 1,
              }),
            ],
          }),
        })
      );
    });

    // Open "让 Agent 创建" popover and dispatch a natural-language instruction
    await user.click(screen.getByTestId('automation-agent-create-btn'));
    const promptBox = await screen.findByTestId(
      'automation-agent-create-btn-input'
    );
    await user.type(
      promptBox,
      '当收到 GitHub PR 评论 @fix 时自动在隔离分支修复并回复'
    );
    await user.click(screen.getByTestId('automation-agent-create-btn-submit'));

    await waitFor(() => {
      expect(sessionsApi.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'proj-1',
          initial_prompt: expect.stringContaining('pulse-workflow-author'),
        })
      );
    });
  });

  it('configures Event Sources cleanly without exposing low-level thread subscriptions', async () => {
    const user = userEvent.setup();
    vi.mocked(pulseApi.upsertSource).mockImplementation(async (input) => ({
      id: input.id ?? 'src-created',
      kind: input.kind,
      title: input.title,
      enabled: input.enabled,
      healthy: true,
      cursorWatermark: '0',
      publicWebhookPath: `/api/pulse/webhooks/${input.id ?? 'src-created'}`,
      configJson: input.configJson,
      receivedCount24h: 1,
      rejectedCount24h: 0,
      updatedAt: '2026-11-16T00:00:00Z',
    }));
    vi.mocked(pulseApi.testSource).mockResolvedValue({
      ok: true,
      sourceId: 'src-gh',
      mode: 'poll',
      message: 'GitHub CLI token verified',
    });

    renderDeck('proj-1');
    await screen.findByTestId('pulse-deck-tab-tasks');

    await user.click(screen.getByTestId('pulse-deck-tab-sources'));

    expect(
      screen.getByTestId('pulse-source-watermark-src-gh')
    ).toHaveTextContent('已连接 · 游标 ev_1092');
    expect(screen.getByTestId('pulse-source-counts-src-gh')).toHaveTextContent(
      '24h 接收 42'
    );

    // No runtime thread subscriptions section is rendered in the UI
    expect(
      screen.queryByTestId('pulse-deck-subscribe-btn')
    ).not.toBeInTheDocument();

    // GitHub Poll & Webhook modes + secret generation + Save & Test
    expect(screen.getByTestId('github-repo-input')).toHaveValue('vibex/core');
    await user.click(screen.getByTestId('github-mode-webhook'));
    expect(screen.getByTestId('source-webhook-url')).toHaveValue(
      `${window.location.origin}/api/pulse/webhooks/src-gh`
    );
    await user.click(screen.getByTestId('source-generate-secret-btn'));
    expect(
      (screen.getByTestId('source-signing-secret') as HTMLInputElement).value
    ).toMatch(/^whsec_/);

    await user.click(screen.getByTestId('source-save-and-test-btn'));
    await waitFor(() => {
      expect(pulseApi.upsertSource).toHaveBeenCalled();
      expect(pulseApi.testSource).toHaveBeenCalledWith('src-gh', false);
    });
    expect(await screen.findByTestId('source-test-result')).toHaveTextContent(
      'GitHub CLI token verified'
    );

    // Feishu connector long-connection & webhook modes
    await user.click(screen.getByTestId('source-kind-feishu'));
    expect(screen.getByTestId('feishu-mode-long-connection')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.click(screen.getByTestId('feishu-mode-webhook'));
    expect(screen.getByTestId('source-webhook-url')).toBeInTheDocument();
  });

  it('surfaces inline pending approvals directly at the top of the Task List', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    snapshot.pendingUserInteractionCount = 1;
    snapshot.pendingInteractions = [
      {
        id: 'ix-notify-1',
        kind: 'notify',
        severity: 'info',
        title: 'Nightly SLA digest ready',
        body: '3 issues triaged overnight',
        approvalOptions: [],
        status: 'pending',
        createdAt: '2026-11-15T00:01:00Z',
      },
    ];
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(snapshot);
    vi.mocked(pulseApi.resolveUserInteraction).mockResolvedValue({
      id: 'ix-notify-1',
      kind: 'notify',
      severity: 'info',
      title: 'Resolved',
      body: '',
      approvalOptions: [],
      status: 'resolved',
      createdAt: '2026-11-15T00:01:00Z',
      resolvedAt: '2026-11-15T00:02:00Z',
    });

    renderDeck('proj-1');

    expect(
      await screen.findByTestId('automation-pending-approvals-strip')
    ).toBeInTheDocument();
    await user.click(
      await screen.findByTestId('pulse-acknowledge-ix-notify-1')
    );

    await waitFor(() => {
      expect(pulseApi.resolveUserInteraction).toHaveBeenCalledWith({
        interactionId: 'ix-notify-1',
        optionId: 'acknowledge',
        note: null,
        formValues: null,
      });
    });
  });

  it('switches Automation Workbench copy dynamically between zh-CN and en without residue', async () => {
    try {
      renderDeck('proj-1');

      expect(await screen.findByTestId('pulse-deck-tab-tasks')).toHaveTextContent(
        '自动化任务'
      );
      expect(screen.getByTestId('pulse-deck-engine-badge')).toHaveTextContent(
        '运行中'
      );
      expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveTextContent(
        '事件源'
      );
      expect(
        screen.getByTestId('automation-agent-create-btn')
      ).toHaveTextContent('让 Agent 创建');
      expect(
        await screen.findByTestId('automation-group-header-active')
      ).toHaveTextContent('启用中');

      await act(async () => {
        await i18n.changeLanguage('en');
      });

      expect(await screen.findByText('Automation Tasks')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-engine-badge')).toHaveTextContent(
        'Running'
      );
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveTextContent(
        'Tasks'
      );
      expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveTextContent(
        'Event Sources'
      );
      expect(
        screen.getByTestId('automation-agent-create-btn')
      ).toHaveTextContent('Create with Agent');
      expect(
        screen.getByTestId('automation-group-header-active')
      ).toHaveTextContent('Active');
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });

  it('forwards vibex://pulse-deck-changed push invalidations from the bound remote host', async () => {
    const remoteUnlisten = vi.fn();
    const remote = {
      call: vi.fn(),
      listen: vi.fn(async () => remoteUnlisten),
    } as unknown as RemoteDesktopTransport;
    const transport = new BoundHostTransport(remote);
    const handler = vi.fn();

    const dispose = await transport.listen(
      'vibex://pulse-deck-changed',
      handler
    );
    expect(remote.listen).toHaveBeenCalledWith(
      'vibex://pulse-deck-changed',
      handler
    );
    dispose();
    expect(remoteUnlisten).toHaveBeenCalledOnce();
  });
});
