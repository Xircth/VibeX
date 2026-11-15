import { Theme as AstryxTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinitionSummary, WorkflowVersionView } from 'shared/types';
import { workflowsApi } from '@/features/workflow/workflowApi';
import i18n from '@/i18n';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
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
  return [
    {
      id: 'wf-triage',
      name: 'CI Incident Multi-Step Triage',
      latestVersionId: 'wfv-1',
      latestVersion: 2n,
      updatedAt: '2026-11-15T10:00:00Z',
    },
  ];
}

function makeSnapshot(): PulseDeckSnapshot {
  return {
    engineActive: true,
    activeTicketCount: 3,
    pendingUserInteractionCount: 1,
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
        configJson: { mode: 'poll', repo: 'vibex/core', pollIntervalSeconds: 60 },
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
          name: 'Observe Jira Bugs',
          evalMode: 'observe',
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
              agentId: 'claude-code',
              workspaceIsolation: 'isolated_worktree',
              promptTemplate: 'Investigate {{payload.summary}}',
            },
          ],
          taskMeta: {
            taskKind: 'fast_task',
            lifecycleState: 'pending_test',
          },
        },
        matchedCount: 5,
        observedCount: 3,
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
              { op: 'eq', pointer: '/workflow_run/conclusion', value: 'failure' },
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
    observedCandidates: [
      {
        id: 'cand-1',
        ruleId: 'rule-1',
        ruleName: 'Observe Jira Bugs',
        eventId: 'evt-99',
        eventType: 'jira.issue.created',
        sourceKind: 'jira',
        threadKey: 'jira:BUG-99',
        summary: 'Checkout null pointer exception',
        occurredAt: '2026-11-15T00:05:00Z',
        promoted: false,
      },
    ],
    subscriptions: [
      {
        id: 'sub-1',
        threadKey: 'jira:BUG-99',
        subscriberKind: 'session',
        subscriberId: 'sess-1',
        active: true,
        createdAt: '2026-11-15T00:06:00Z',
      },
    ],
    pendingInteractions: [],
  };
}

describe('PulseDeckView (Track A2 Automation Tasks Master-Detail Workbench)', () => {
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
  });

  it('keeps the Kanban monitor zone visible whenever Automation Tasks is open even with 0 monitored sessions', () => {
    expect(shouldShowKanbanMonitor(true, 0, false)).toBe(false);
    expect(shouldShowKanbanMonitor(true, 0, true)).toBe(true);
    expect(shouldShowKanbanMonitor(false, 0, true)).toBe(true);
  });

  it('renders 4 primary tabs, unified FastTask + Workflow Master-Detail list, 4-segment info pills, status transitions, and embedded Workflow Studio', async () => {
    const user = userEvent.setup();
    vi.mocked(pulseApi.dryRunRule).mockResolvedValue({
      valid: true,
      matched: true,
      violations: [],
      unmatchedConditions: [],
      renderedPreviews: ['Investigate Checkout null pointer exception'],
    });
    vi.mocked(pulseApi.saveRule).mockImplementation(async ({ id, enabled, spec }) => ({
      id: id ?? 'rule-created-1',
      revision: 2,
      enabled: enabled ?? true,
      draftOnly: false,
      mandateOrigin: 'explicit_human',
      spec,
      matchedCount: 5,
      observedCount: 3,
      createdAt: '2026-11-15T00:00:00Z',
      updatedAt: '2026-11-16T00:00:00Z',
    }));
    vi.mocked(workflowsApi.publish).mockResolvedValue({
      id: 'wfv-converted',
      definitionId: 'wf-converted-1',
      version: 1n,
    } as unknown as WorkflowVersionView);

    renderDeck('proj-1');

    // 4 primary tabs exist with Task List active by default
    expect(await screen.findByText('自动化任务')).toBeInTheDocument();
    expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByTestId('pulse-deck-tab-pending')).toHaveTextContent(
      '待办事件'
    );
    expect(screen.getByTestId('pulse-deck-tab-rules')).toHaveTextContent(
      '自动化规则'
    );
    expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveTextContent(
      '事件源与订阅'
    );

    // Unified single "新建" menu button instead of two separate creation buttons
    expect(screen.getByTestId('automation-new-menu-btn')).toHaveTextContent(
      '新建'
    );
    expect(
      screen.queryByTestId('automation-new-fasttask-btn')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('automation-new-workflow-btn')
    ).not.toBeInTheDocument();

    // Master pane fills full width initially; detail LayoutPanel stays closed until selection
    expect(
      screen.getByTestId('automation-tab-tasks-split-master')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('automation-tab-tasks-split-detail')
    ).not.toBeInTheDocument();

    // table-grouped separates 任务 and 工作流 into distinct collapsible group sections
    expect(
      await screen.findByTestId('automation-group-header-fast_task')
    ).toHaveTextContent('任务');
    expect(
      await screen.findByTestId('automation-group-header-workflow')
    ).toHaveTextContent('工作流');
    expect(
      await screen.findByTestId('automation-task-row-rule-1')
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId('automation-workflow-row-wf-triage')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('automation-task-row-rule-wf-trigger')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('automation-task-row-rule-tpl-1')
    ).not.toBeInTheDocument();

    // Collapsing and expanding the 任务 group header toggles its rows cleanly
    await user.click(screen.getByTestId('automation-group-header-fast_task'));
    expect(
      screen.queryByTestId('automation-task-row-rule-1')
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('automation-group-header-fast_task'));
    expect(
      await screen.findByTestId('automation-task-row-rule-1')
    ).toBeInTheDocument();

    // Status badge shows 待测试 initially for rule-1
    expect(
      screen.getByTestId('automation-task-status-rule-1')
    ).toHaveTextContent('待测试');

    // Clicking each segment of the 4-segment FastTask pipeline opens the collapsible detail LayoutPanel on that stage
    await user.click(screen.getByTestId('automation-seg-rule-rule-1'));
    expect(
      screen.getByTestId('automation-tab-tasks-split-detail')
    ).toBeInTheDocument();
    expect(screen.getByTestId('fasttask-rule-editor')).toBeInTheDocument();

    await user.click(screen.getByTestId('automation-seg-target-rule-1'));
    expect(screen.getByTestId('fasttask-target-editor')).toBeInTheDocument();

    await user.click(screen.getByTestId('automation-seg-callback-rule-1'));
    expect(screen.getByTestId('fasttask-callback-editor')).toBeInTheDocument();

    // Records button opens Records sub-tab showing outbox delivery
    await user.click(screen.getByTestId('automation-task-records-rule-1'));
    expect(screen.getByTestId('fasttask-records-pane')).toHaveTextContent(
      'feishu_webhook'
    );

    // Test Task runs dryRunRule and saves lastTestedAt
    await user.click(screen.getByTestId('fasttask-test-btn'));
    await waitFor(() => {
      expect(pulseApi.dryRunRule).toHaveBeenCalled();
    });
    expect(await screen.findByTestId('fasttask-test-report')).toHaveTextContent(
      '测试通过'
    );

    // Publish Task validates and transitions status to 已发布
    await user.click(screen.getByTestId('fasttask-publish-btn'));
    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'rule-1',
          enabled: true,
          draftOnly: false,
          spec: expect.objectContaining({
            evalMode: 'auto',
            taskMeta: expect.objectContaining({
              lifecycleState: 'published',
            }),
          }),
        })
      );
    });
    expect(
      await screen.findByTestId('automation-task-status-rule-1')
    ).toHaveTextContent('已发布');

    // Closing the complementary detail panel restores full-width table view
    await user.click(screen.getByTestId('automation-detail-close-btn'));
    expect(
      screen.queryByTestId('automation-tab-tasks-split-detail')
    ).not.toBeInTheDocument();

    // Clicking Workflow row Info opens embedded Workflow Studio inside Automation Tasks
    await user.click(screen.getByTestId('automation-workflow-info-wf-triage'));
    expect(
      await screen.findByTestId('automation-embedded-workflow-studio')
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId('mock-embedded-workflow-studio-canvas')
    ).toBeInTheDocument();

    // Clicking ← 返回任务列表 returns to Task List
    await user.click(screen.getByTestId('embedded-studio-back-btn'));
    expect(
      await screen.findByTestId('automation-tasks-list')
    ).toBeInTheDocument();
  });

  it('displays 执行中 status when busyRuleIds contains the task rule and opens 编辑中 / Workflow Studio from the unified 新建 menu', async () => {
    const user = userEvent.setup();
    const busySnapshot = makeSnapshot();
    busySnapshot.busyRuleIds = ['rule-1'];
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(busySnapshot);

    renderDeck('proj-1');

    expect(
      await screen.findByTestId('automation-task-status-rule-1')
    ).toHaveTextContent('执行中');

    // Open unified "新建" menu -> shows "任务" and "工作流"
    await user.click(screen.getByTestId('automation-new-menu-btn'));
    const newTaskItem = await screen.findByRole('menuitem', { name: '任务' });
    expect(
      screen.getByRole('menuitem', { name: '工作流' })
    ).toBeInTheDocument();
    await user.click(newTaskItem);

    expect(
      screen.getByTestId('fasttask-editor-status-badge')
    ).toHaveTextContent('编辑中');

    // Clear name to verify exhaustive publish validation
    const nameInput = screen.getByTestId('fasttask-name-input');
    await user.clear(nameInput);
    await user.click(screen.getByTestId('fasttask-publish-btn'));
    expect(
      screen.getByTestId('fasttask-validation-errors')
    ).toHaveTextContent('请填写任务名称。');

    // Open unified "新建" menu -> choose "工作流" to open embedded Workflow Studio
    await user.click(screen.getByTestId('automation-new-menu-btn'));
    await user.click(await screen.findByRole('menuitem', { name: '工作流' }));
    expect(
      await screen.findByTestId('automation-embedded-workflow-studio')
    ).toBeInTheDocument();
  });

  it('configures GitHub (Poll + Webhook) and Feishu (Long-connection + Webhook) sources, copies Webhook URL, runs testSource, and manages subscriptions', async () => {
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
    vi.mocked(pulseApi.subscribeThread).mockResolvedValue({
      id: 'sub-2',
      threadKey: 'github:vibex/core#12',
      subscriberKind: 'workflow',
      subscriberId: 'wf-triage',
      active: true,
      createdAt: '2026-11-15T00:10:00Z',
    });
    vi.mocked(pulseApi.unsubscribeThread).mockResolvedValue(undefined);

    renderDeck('proj-1');
    await screen.findByText('自动化任务');

    await user.click(screen.getByTestId('pulse-deck-tab-sources'));

    expect(
      screen.getByTestId('pulse-source-watermark-src-gh')
    ).toHaveTextContent('已连接 · 游标 ev_1092');
    expect(screen.getByTestId('pulse-source-counts-src-gh')).toHaveTextContent(
      '24h 接收 42'
    );

    // GitHub Poll mode fields + switch to Webhook mode with copyable URL & secret generation
    expect(screen.getByTestId('github-repo-input')).toHaveValue('vibex/core');
    await user.click(screen.getByTestId('github-mode-webhook'));
    expect(screen.getByTestId('source-webhook-url')).toHaveValue(
      `${window.location.origin}/api/pulse/webhooks/src-gh`
    );
    await user.click(screen.getByTestId('source-generate-secret-btn'));
    expect(
      (screen.getByTestId('source-signing-secret') as HTMLInputElement).value
    ).toMatch(/^whsec_/);

    // Save & Test Connectivity calls upsertSource + testSource
    await user.click(screen.getByTestId('source-save-and-test-btn'));
    await waitFor(() => {
      expect(pulseApi.upsertSource).toHaveBeenCalled();
      expect(pulseApi.testSource).toHaveBeenCalledWith('src-gh', false);
    });
    expect(await screen.findByTestId('source-test-result')).toHaveTextContent(
      'GitHub CLI token verified'
    );

    // Switch to Feishu connector: Long-connection bridge & HTTP Webhook modes
    await user.click(screen.getByTestId('source-kind-feishu'));
    expect(
      screen.getByTestId('feishu-mode-long-connection')
    ).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('feishu-mode-webhook'));
    expect(screen.getByTestId('source-webhook-url')).toBeInTheDocument();

    // Thread subscriptions bind & unsubscribe
    await user.type(
      screen.getByLabelText('订阅外部线程标识'),
      'github:vibex/core#12'
    );
    await user.click(screen.getByTestId('deck-sub-kind-workflow'));
    await user.type(screen.getByLabelText('订阅目标 ID'), 'wf-triage');
    await user.click(screen.getByTestId('pulse-deck-subscribe-btn'));

    await waitFor(() => {
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'github:vibex/core#12',
        'workflow',
        'wf-triage'
      );
    });

    await user.click(screen.getByTestId('pulse-deck-unsubscribe-sub-1'));
    await waitFor(() => {
      expect(pulseApi.unsubscribeThread).toHaveBeenCalledWith('sub-1');
    });
  });

  it('handles Pending Events queue (ask_form, notify, and observed candidate dry-run & promote) and Rules Lab', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    snapshot.pendingInteractions = [
      {
        id: 'ix-form-1',
        kind: 'ask_form',
        severity: 'warning',
        title: 'Release rollout parameters',
        body: 'Specify canary traffic percentage',
        approvalOptions: [],
        formSchema: {
          type: 'object',
          required: ['canaryPercent', 'environment'],
          properties: {
            canaryPercent: { type: 'integer', title: 'Canary %' },
            dryRun: { type: 'boolean', title: 'Dry Run Only', default: true },
            environment: {
              type: 'string',
              title: 'Environment',
              enum: ['staging', 'production'],
            },
          },
        },
        status: 'pending',
        createdAt: '2026-11-15T00:00:00Z',
      },
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
    vi.mocked(pulseApi.promoteObservedCandidate).mockResolvedValue(undefined);
    vi.mocked(pulseApi.dryRunRule).mockResolvedValue({
      valid: true,
      matched: true,
      violations: [],
      unmatchedConditions: [],
      renderedPreviews: ['Investigate Checkout null pointer exception'],
    });
    vi.mocked(pulseApi.resolveUserInteraction).mockImplementation(
      async ({ interactionId }) => {
        snapshot.pendingInteractions = snapshot.pendingInteractions.filter(
          (item) => item.id !== interactionId
        );
        return {
          id: interactionId,
          kind: 'notify',
          severity: 'info',
          title: 'Resolved',
          body: '',
          approvalOptions: [],
          status: 'resolved',
          createdAt: '2026-11-15T00:00:00Z',
          resolvedAt: '2026-11-15T00:02:00Z',
        };
      }
    );

    renderDeck('proj-1');
    await screen.findByText('自动化任务');

    await user.click(screen.getByTestId('pulse-deck-tab-pending'));

    // Submit ask_form interaction
    const pctInput = await screen.findByLabelText('Canary %');
    await user.type(pctInput, '25');
    await user.selectOptions(screen.getByLabelText('Environment'), 'production');
    await user.click(screen.getByTestId('pulse-interaction-submit-ix-form-1'));

    await waitFor(() => {
      expect(pulseApi.resolveUserInteraction).toHaveBeenCalledWith({
        interactionId: 'ix-form-1',
        optionId: 'submit',
        note: null,
        formValues: {
          canaryPercent: 25,
          dryRun: true,
          environment: 'production',
        },
      });
    });

    // Acknowledge notify interaction
    await user.click(await screen.findByTestId('pulse-acknowledge-ix-notify-1'));
    await waitFor(() => {
      expect(pulseApi.resolveUserInteraction).toHaveBeenCalledWith({
        interactionId: 'ix-notify-1',
        optionId: 'acknowledge',
        note: null,
        formValues: null,
      });
    });

    // Observed candidate dry-run & promote
    await user.click(await screen.findByTestId('pending-item-cand-cand-1'));
    await user.click(screen.getByTestId('pulse-candidate-inspect-cand-1'));
    expect(
      await screen.findByTestId('pulse-candidate-dryrun-cand-1')
    ).toHaveTextContent('Investigate Checkout null pointer exception');

    await user.click(screen.getByTestId('pulse-candidate-promote-cand-1'));
    await waitFor(() => {
      expect(pulseApi.promoteObservedCandidate).toHaveBeenCalledWith('cand-1');
    });

    // Switch to Tab 3 (Automation Rules) and create FastTask from Rule
    await user.click(screen.getByTestId('pulse-deck-tab-rules'));
    expect(
      screen.getByTestId('pulse-deck-rule-counts-rule-tpl-1')
    ).toHaveTextContent('命中 12 · 观察 4');
    await user.click(screen.getByTestId('pulse-deck-rule-rule-tpl-1'));
    await user.click(screen.getByTestId('rule-create-fasttask-btn'));

    expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByTestId('fasttask-target-editor')).toBeInTheDocument();
  });

  it('switches Automation Tasks copy dynamically between zh-CN and en without residue', async () => {
    try {
      renderDeck('proj-1');

      expect(await screen.findByText('自动化任务')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-engine-badge')).toHaveTextContent(
        '运行中'
      );
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveTextContent(
        '任务列表'
      );
      expect(screen.getByTestId('automation-new-menu-btn')).toHaveTextContent(
        '新建'
      );
      expect(
        await screen.findByTestId('automation-group-header-fast_task')
      ).toHaveTextContent('任务');
      expect(
        screen.getByTestId('automation-group-header-workflow')
      ).toHaveTextContent('工作流');

      await act(async () => {
        await i18n.changeLanguage('en');
      });

      expect(await screen.findByText('Automation Tasks')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-engine-badge')).toHaveTextContent(
        'Running'
      );
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveTextContent(
        'Task List'
      );
      expect(screen.getByTestId('automation-new-menu-btn')).toHaveTextContent(
        'New'
      );
      expect(
        screen.getByTestId('automation-group-header-fast_task')
      ).toHaveTextContent('Tasks');
      expect(
        screen.getByTestId('automation-group-header-workflow')
      ).toHaveTextContent('Workflows');
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

    const dispose = await transport.listen('vibex://pulse-deck-changed', handler);
    expect(remote.listen).toHaveBeenCalledWith(
      'vibex://pulse-deck-changed',
      handler
    );
    dispose();
    expect(remoteUnlisten).toHaveBeenCalledOnce();
  });
});
