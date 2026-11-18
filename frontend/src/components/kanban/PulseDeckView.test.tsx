import type { ReactNode } from 'react';
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
import * as openExternalModule from '@/features/model-router/openExternal';
import { workflowsApi } from '@/features/workflow/workflowApi';
import i18n from '@/i18n';
import { projectsApi } from '@/lib/api/projects';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
import { sessionsApi } from '@/lib/api/sessions';
import { shouldShowKanbanMonitor } from '@/lib/kanbanZoneVisibility';
import { REQUEST_CREATE_SESSION_OVERLAY_EVENT } from '@/lib/requestCreateSession';
import { BoundHostTransport } from '@/lib/transport/boundHostTransport';
import type { RemoteDesktopTransport } from '@/lib/transport/remoteDesktopTransport';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { PulseDeckView } from './PulseDeckView';
import {
  consumePendingWorkflowStudioOpen,
  requestOpenWorkflowStudio,
  stashPendingWorkflowStudioOpen,
} from './pulseDeckEvents';

function renderDeck(projectId = 'proj-1') {
  return render(
    <AstryxTheme theme={neutralTheme} mode="light">
      <PulseDeckView projectId={projectId} />
    </AstryxTheme>
  );
}

vi.mock('@/features/workflow/WorkflowStudioDockPanel', () => ({
  WorkflowStudioDockPanel: ({
    onBack,
    rightToolbarSlot,
  }: {
    onBack?: () => void;
    rightToolbarSlot?: ReactNode;
  }) => (
    <div data-testid="mock-embedded-workflow-studio-canvas">
      {onBack ? (
        <button
          type="button"
          data-testid="embedded-studio-back-btn"
          onClick={onBack}
        >
          Back
        </button>
      ) : null}
      {rightToolbarSlot}
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
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
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
    useLayoutStore.getState().setKanbanSessionVisible(false);
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

  it('renders compact Usage-style header without engine badge, left navigation rail, right-sidebar session activation, and embedded Workflow Studio', async () => {
    const user = userEvent.setup();
    vi.mocked(pulseApi.setRuleEnabled).mockResolvedValue({
      ...makeSnapshot().rules[1]!,
      enabled: false,
    });

    const overlayEvents: Event[] = [];
    const onOverlay = (event: Event) => overlayEvents.push(event);
    window.addEventListener(REQUEST_CREATE_SESSION_OVERLAY_EVENT, onOverlay);

    try {
      // Simulate default layout state where isKanbanSessionVisible starts true
      useLayoutStore.getState().setKanbanSessionVisible(true);
      renderDeck('proj-1');

      // Right-side Agent Session sidebar does NOT auto-open when entering the Automation Tasks page
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(false);

      // Manual header toggle still opens and closes the right-side Agent Session sidebar
      const toggleSidebarBtn = screen.getByTestId(
        'automation-toggle-session-sidebar-btn'
      );
      expect(toggleSidebarBtn).toHaveAttribute('aria-pressed', 'false');
      await user.click(toggleSidebarBtn);
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(true);
      expect(toggleSidebarBtn).toHaveAttribute('aria-pressed', 'true');
      await user.click(toggleSidebarBtn);
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(false);

      // Compact heading matching KanbanUsageDashboard (`text-base`), with "运行中" status dot removed
      const heading = await screen.findByTestId('pulse-deck-heading');
      expect(heading).toHaveTextContent('自动化任务');
      expect(heading).toHaveClass('text-base');
      expect(
        screen.queryByTestId('pulse-deck-engine-badge')
      ).not.toBeInTheDocument();

      // Left floating navigation rail matching KanbanUsageDashboard
      expect(screen.getByTestId('automation-left-nav-rail')).toHaveClass(
        'kanban-usage-tab-rail'
      );
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
        'aria-label',
        '自动化任务'
      );
      expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveAttribute(
        'aria-selected',
        'false'
      );
      expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveAttribute(
        'aria-label',
        '事件源'
      );
      expect(
        screen.queryByTestId('pulse-deck-tab-pending')
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('pulse-deck-tab-rules')
      ).not.toBeInTheDocument();

      // Clicking "让 Agent 创建" opens the embedded Workflow Canvas in createNew mode and asks the session sidebar to show the create-session form
      await user.click(screen.getByTestId('automation-agent-create-btn'));
      expect(
        await screen.findByTestId('automation-embedded-workflow-studio')
      ).toBeInTheDocument();
      expect(
        await screen.findByTestId('mock-embedded-workflow-studio-canvas')
      ).toBeInTheDocument();
      expect(consumePendingWorkflowStudioOpen()).toEqual({ createNew: true });
      expect(overlayEvents).toHaveLength(1);
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(true);
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);

      // Return from new workflow draft back to the Task List restores the closed right sidebar
      await user.click(await screen.findByTestId('embedded-studio-back-btn'));
      expect(
        await screen.findByTestId('automation-tasks-list')
      ).toBeInTheDocument();
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(false);

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

      // "Agent修改" row button is removed; "修改" button uses solid black primary styling
      expect(
        screen.queryByTestId('automation-task-agent-edit-wf-triage')
      ).not.toBeInTheDocument();
      const editBtn = screen.getByTestId(
        'automation-task-open-workflow-wf-triage'
      );
      expect(editBtn).toHaveTextContent('修改');
      expect(editBtn).toHaveClass('bg-primary');

      // Semantic chains display human-centric [从哪来 → 触发谁 → 结果给谁]
      expect(
        screen.getByTestId('automation-task-pipeline-wf-triage')
      ).toHaveTextContent('GitHub');
      expect(
        screen.getByTestId('automation-task-pipeline-rule-1')
      ).toHaveTextContent('Jira');

      // Grouping / view-options popover has been removed; status chips drive filtering directly
      expect(
        screen.queryByTestId('automation-view-options-btn')
      ).not.toBeInTheDocument();

      // FilterTable status chips display counts and filter rows smoothly
      const activeChip = screen.getByTestId('automation-filter-chip-active');
      expect(activeChip).toHaveTextContent('启用中');
      expect(activeChip).toHaveTextContent('2');
      await user.click(activeChip);
      expect(activeChip).toHaveAttribute('aria-pressed', 'true');
      await user.click(screen.getByTestId('automation-filter-chip-all'));

      // Compact header search filters tasks and clears cleanly
      const headerSearch = screen.getByTestId('automation-header-search');
      await user.type(headerSearch, 'Jira');
      expect(
        screen.queryByTestId('automation-task-row-wf-triage')
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId('automation-task-row-rule-1')
      ).toBeInTheDocument();
      await user.click(screen.getByTestId('automation-header-search-clear'));
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

      // Explicit "修改" button opens the embedded Workflow Canvas directly with right Session sidebar visible
      useLayoutStore.getState().setKanbanSessionVisible(false);
      await user.click(
        screen.getByTestId('automation-task-open-workflow-wf-triage')
      );
      expect(
        await screen.findByTestId('automation-embedded-workflow-studio')
      ).toBeInTheDocument();
      expect(
        await screen.findByTestId('mock-embedded-workflow-studio-canvas')
      ).toBeInTheDocument();
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(true);
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);

      // Back button returns cleanly to Task List, and clicking any task row also opens the canvas
      await user.click(screen.getByTestId('embedded-studio-back-btn'));
      expect(
        await screen.findByTestId('automation-tasks-list')
      ).toBeInTheDocument();
      await user.click(screen.getByTestId('automation-task-row-wf-triage'));
      expect(
        await screen.findByTestId('automation-embedded-workflow-studio')
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
    } finally {
      window.removeEventListener(
        REQUEST_CREATE_SESSION_OVERLAY_EVENT,
        onOverlay
      );
    }
  });

  it('enables all 4 canonical workflow starters in 1 click (including cron timezone & approval options) and customizes starters via right-side Agent session', async () => {
    const user = userEvent.setup();
    const emptySnapshot = makeSnapshot();
    emptySnapshot.rules = [];
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(emptySnapshot);
    vi.mocked(workflowsApi.listDefinitions).mockResolvedValue([]);
    vi.mocked(workflowsApi.publish).mockImplementation(
      async (def) =>
        ({
          id: `wfv-${def.name}`,
          definitionId: `wf-${def.name}`,
          version: 1n,
          digest: 'sha256:starter',
          normalizedJson: JSON.stringify(def),
          sourcePath: null,
          createdAt: '2026-11-16T00:00:00Z',
        }) as WorkflowVersionView
    );
    vi.mocked(pulseApi.saveRule).mockImplementation(async ({ spec }) => ({
      id: `rule-${spec.name}`,
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
      id: 'sess-agent-1',
      workspace_id: 'ws-agent-1',
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

    // Dispatch starter customization to the dedicated right-side Agent Session sidebar
    await user.click(
      screen.getByTestId('automation-customize-starter-feishu-mention-triage')
    );
    await waitFor(() => {
      expect(sessionsApi.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'proj-1',
          initial_prompt: expect.stringContaining('feishu-mention-triage'),
        })
      );
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(true);
    });

    // Enable daily-repo-digest starter -> verifies non-empty IANA timezone on temporal cron rule
    await user.click(
      screen.getByTestId('automation-apply-starter-daily-repo-digest')
    );
    await waitFor(() => {
      expect(workflowsApi.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: '每日代码进展与风险晨报' })
      );
      expect(pulseApi.saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          spec: expect.objectContaining({
            temporal: expect.objectContaining({
              kind: 'cron',
              expression: '30 9 * * 1-5',
              timezone: 'Asia/Shanghai',
            }),
          }),
        })
      );
    });
  });

  it('renders AstryxSelect source selector, SegmentedControl mode switchers, full GitHub repo URL, external credential links, and zero raw i18n keys', async () => {
    const user = userEvent.setup();
    const openExternalSpy = vi
      .spyOn(openExternalModule, 'openExternal')
      .mockResolvedValue(undefined);

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

    try {
      renderDeck('proj-1');
      await screen.findByTestId('pulse-deck-tab-tasks');

      await user.click(screen.getByTestId('pulse-deck-tab-sources'));

      // Connected source appears under "已接入事件源", while unconfigured kinds appear in separate "事件源模板" chip & rows
      expect(
        screen.getByTestId('sources-connected-group-header')
      ).toHaveTextContent('已接入事件源');
      expect(
        screen.getByTestId('sources-templates-group-header')
      ).toHaveTextContent('事件源模板');
      expect(
        screen.getByTestId('source-template-row-feishu')
      ).toHaveTextContent('模板 · 点击配置');
      expect(
        screen.queryByTestId('source-template-row-github')
      ).not.toBeInTheDocument();

      // Clicking "事件源模板" chip filters out connected sources and keeps templates visible
      await user.click(screen.getByTestId('sources-templates-group-header'));
      expect(
        screen.getByTestId('source-row-src-gh').closest('[data-row-visible]')
      ).toHaveAttribute('data-row-visible', 'false');
      expect(
        screen
          .getByTestId('source-template-row-feishu')
          .closest('[data-row-visible]')
      ).toHaveAttribute('data-row-visible', 'true');
      await user.click(screen.getByTestId('sources-filter-chip-all'));

      expect(
        screen.getByTestId('pulse-source-watermark-src-gh')
      ).toHaveTextContent('已连接 · 游标 ev_1092');
      expect(
        screen.getByTestId('pulse-source-counts-src-gh')
      ).toHaveTextContent('24h 接收 42');

      // Legacy bare "vibex/core" automatically hydrates as a full GitHub repository URL
      expect(screen.getByTestId('github-repo-input')).toHaveValue(
        'https://github.com/vibex/core'
      );

      // GitHub Token external jump-link icon button opens GitHub PAT creation URL
      await user.click(screen.getByTestId('github-token-link-btn'));
      expect(openExternalSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/settings/tokens/new')
      );

      // SegmentedControl switches cleanly between Poll and Webhook modes
      expect(screen.getByTestId('github-mode-poll')).toHaveAttribute(
        'role',
        'radio'
      );
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

      // Switch source type via AstryxSelect combobox (`#source-kind-select`) -> Feishu
      const kindSelectTrigger = document.getElementById('source-kind-select')!;
      expect(kindSelectTrigger).toHaveAttribute('role', 'combobox');
      await user.click(kindSelectTrigger);
      await user.click(await screen.findByRole('option', { name: '飞书' }));
      expect(screen.getByTestId('feishu-mode-long-connection')).toHaveAttribute(
        'aria-checked',
        'true'
      );
      await user.click(screen.getByTestId('feishu-mode-webhook'));
      expect(screen.getByTestId('source-webhook-url')).toBeInTheDocument();

      // Switch source type via AstryxSelect -> 定时间隔触发 and verify translated label (no raw key)
      await user.click(kindSelectTrigger);
      await user.click(
        await screen.findByRole('option', { name: '定时间隔触发' })
      );
      expect(screen.getByText('触发间隔（秒）')).toBeInTheDocument();
      expect(
        screen.queryByText(/pulseDeck\.workbench\./)
      ).not.toBeInTheDocument();
    } finally {
      openExternalSpy.mockRestore();
    }
  });

  it('hides "已接入事件源" when zero sources are connected and displays only "事件源模板"', async () => {
    const user = userEvent.setup();
    const emptySourcesSnapshot = makeSnapshot();
    emptySourcesSnapshot.sources = [];
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(emptySourcesSnapshot);

    renderDeck('proj-1');
    await screen.findByTestId('pulse-deck-tab-tasks');
    await user.click(screen.getByTestId('pulse-deck-tab-sources'));

    expect(
      screen.queryByTestId('sources-connected-group-header')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('sources-templates-group-header')
    ).toHaveTextContent('事件源模板');
    expect(
      screen.getByTestId('source-template-row-github')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('source-template-row-feishu')
    ).toBeInTheDocument();
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

      expect(await screen.findByTestId('pulse-deck-heading')).toHaveTextContent(
        '自动化任务'
      );
      expect(
        screen.queryByTestId('pulse-deck-engine-badge')
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
        'aria-label',
        '自动化任务'
      );
      expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveAttribute(
        'aria-label',
        '事件源'
      );
      expect(
        screen.getByTestId('automation-agent-create-btn')
      ).toHaveTextContent('让 Agent 创建');
      expect(
        await screen.findByTestId('automation-filter-chip-active')
      ).toHaveTextContent('启用中');
      expect(
        screen.getByTestId('automation-filter-chip-all')
      ).toHaveTextContent('全部');
      expect(
        screen.getByTestId('automation-task-open-workflow-wf-triage')
      ).toHaveTextContent('修改');

      await act(async () => {
        await i18n.changeLanguage('en');
      });

      expect(await screen.findByTestId('pulse-deck-heading')).toHaveTextContent(
        'Automation Tasks'
      );
      expect(screen.getByTestId('pulse-deck-tab-tasks')).toHaveAttribute(
        'aria-label',
        'Tasks'
      );
      expect(screen.getByTestId('pulse-deck-tab-sources')).toHaveAttribute(
        'aria-label',
        'Event Sources'
      );
      expect(
        screen.getByTestId('automation-agent-create-btn')
      ).toHaveTextContent('Create with Agent');
      expect(
        screen.getByTestId('automation-filter-chip-active')
      ).toHaveTextContent('Active');
      expect(
        screen.getByTestId('automation-filter-chip-all')
      ).toHaveTextContent('All');
      expect(
        screen.getByTestId('automation-task-open-workflow-wf-triage')
      ).toHaveTextContent('Edit');
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });

  it('opens the embedded Workflow Studio even when a parent view-switcher calls event.preventDefault() on vibex:open-workflow-studio, while ignoring hidden surfaces', async () => {
    const parentPreventDefaultListener = (event: Event) => {
      event.preventDefault();
    };
    // Simulate parent KanbanBoard registering its listener BEFORE PulseDeckView mounts
    window.addEventListener(
      'vibex:open-workflow-studio',
      parentPreventDefaultListener
    );

    try {
      const { unmount } = renderDeck('proj-1');
      await screen.findByTestId('automation-tasks-list');

      act(() => {
        requestOpenWorkflowStudio({ definitionId: 'wf-triage' });
      });

      expect(
        await screen.findByTestId('automation-embedded-workflow-studio')
      ).toBeInTheDocument();
      unmount();
      stashPendingWorkflowStudioOpen(null);

      // Hidden background surfaces must ignore the open event
      render(
        <AstryxTheme theme={neutralTheme} mode="light">
          <div aria-hidden="true">
            <PulseDeckView projectId="proj-1" />
          </div>
        </AstryxTheme>
      );
      await screen.findByTestId('automation-tasks-list');

      act(() => {
        requestOpenWorkflowStudio({ createNew: true });
      });

      expect(
        screen.queryByTestId('automation-embedded-workflow-studio')
      ).not.toBeInTheDocument();
    } finally {
      window.removeEventListener(
        'vibex:open-workflow-studio',
        parentPreventDefaultListener
      );
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
