import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
import { shouldShowKanbanMonitor } from '@/lib/kanbanZoneVisibility';
import { BoundHostTransport } from '@/lib/transport/boundHostTransport';
import type { RemoteDesktopTransport } from '@/lib/transport/remoteDesktopTransport';
import { OPEN_WORKFLOW_STUDIO_EVENT } from './pulseDeckEvents';
import { PulseDeckView } from './PulseDeckView';

const upsertRuleMock = vi.fn();

vi.mock('@/lib/api/pulse', () => ({
  pulseApi: {
    deckSnapshot: vi.fn(),
    upsertSource: vi.fn(),
    upsertRule: (...args: unknown[]) => upsertRuleMock(...args),
    saveRule: vi.fn(),
    promoteObservedCandidate: vi.fn(),
    dryRunRule: vi.fn(),
    setRuleMode: vi.fn(),
    setRuleEnabled: vi.fn(),
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

function makeSnapshot(): PulseDeckSnapshot {
  return {
    engineActive: true,
    activeTicketCount: 3,
    pendingUserInteractionCount: 1,
    sources: [
      {
        id: 'src-gh',
        kind: 'github',
        title: 'GitHub Main Webhook',
        enabled: true,
        healthy: true,
        statusMessage: null,
        cursorWatermark: 'ev_1092',
        publicWebhookPath: '/webhooks/github',
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
        },
        matchedCount: 5,
        observedCount: 3,
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

describe('PulseDeckView (Track U1 Guided Workbench & Bilingual i18n)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    upsertRuleMock.mockReset();
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(makeSnapshot());
  });

  it('keeps the Kanban monitor zone visible whenever Pulse Deck is open even with 0 monitored sessions', () => {
    expect(shouldShowKanbanMonitor(true, 0, false)).toBe(false);
    expect(shouldShowKanbanMonitor(true, 0, true)).toBe(true);
    expect(shouldShowKanbanMonitor(false, 0, true)).toBe(true);
  });

  it('renders human-readable source status strip, switch accessibility, dry-run, Observe promotion, and workflow thread subscriptions', async () => {
    const user = userEvent.setup();
    vi.mocked(pulseApi.promoteObservedCandidate).mockResolvedValue(undefined);
    vi.mocked(pulseApi.dryRunRule).mockResolvedValue({
      valid: true,
      matched: true,
      violations: [],
      unmatchedConditions: [],
      renderedPreviews: ['Investigate Checkout null pointer exception'],
    });
    vi.mocked(pulseApi.setRuleMode).mockResolvedValue({
      ...makeSnapshot().rules[0]!,
      spec: {
        ...makeSnapshot().rules[0]!.spec,
        evalMode: 'auto',
      },
    });
    vi.mocked(pulseApi.setRuleEnabled).mockResolvedValue({
      ...makeSnapshot().rules[0]!,
      enabled: false,
    });
    vi.mocked(pulseApi.subscribeThread).mockResolvedValue({
      id: 'sub-2',
      threadKey: 'github:vibex/core#12',
      subscriberKind: 'workflow',
      subscriberId: 'wf-release',
      active: true,
      createdAt: '2026-11-15T00:10:00Z',
    });
    vi.mocked(pulseApi.unsubscribeThread).mockResolvedValue(undefined);

    render(<PulseDeckView projectId="proj-1" />);

    expect(
      await screen.findByText('GitHub Main Webhook')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('pulse-source-watermark-src-gh')
    ).toHaveTextContent('已连接 · 游标 ev_1092');
    expect(screen.getByTestId('pulse-source-counts-src-gh')).toHaveTextContent(
      '24h 接收 42'
    );

    const ruleSwitch = screen.getByRole('switch', {
      name: '启用规则 Observe Jira Bugs',
    });
    expect(ruleSwitch).toHaveAttribute('aria-checked', 'true');
    await user.click(ruleSwitch);
    await waitFor(() => {
      expect(pulseApi.setRuleEnabled).toHaveBeenCalledWith('rule-1', false);
    });

    await user.click(screen.getByTestId('pulse-candidate-inspect-cand-1'));
    expect(
      await screen.findByTestId('pulse-candidate-dryrun-cand-1')
    ).toHaveTextContent('Investigate Checkout null pointer exception');

    await user.click(screen.getByTestId('pulse-candidate-promote-cand-1'));
    await waitFor(() => {
      expect(pulseApi.promoteObservedCandidate).toHaveBeenCalledWith('cand-1');
    });

    await user.click(screen.getByTestId('pulse-deck-rule-mode-rule-1-auto'));
    await waitFor(() => {
      expect(pulseApi.setRuleMode).toHaveBeenCalledWith('rule-1', 'auto');
    });

    await user.type(
      screen.getByLabelText('订阅外部线程标识'),
      'github:vibex/core#12'
    );
    await user.click(screen.getByTestId('deck-sub-kind-workflow'));
    await user.type(screen.getByLabelText('订阅目标 ID'), 'wf-release');
    await user.click(screen.getByTestId('pulse-deck-subscribe-btn'));

    await waitFor(() => {
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'github:vibex/core#12',
        'workflow',
        'wf-release'
      );
    });

    await user.click(screen.getByTestId('pulse-deck-unsubscribe-sub-1'));
    await waitFor(() => {
      expect(pulseApi.unsubscribeThread).toHaveBeenCalledWith('sub-1');
    });
  });

  it('guides empty projects through 3-step onboarding, scenario template rule creation, section filtering, and Workflow Studio cross-links', async () => {
    const user = userEvent.setup();
    const emptyRulesSnapshot = makeSnapshot();
    emptyRulesSnapshot.rules = [];
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(emptyRulesSnapshot);
    upsertRuleMock.mockImplementation(async ({ spec }) => ({
      id: 'rule-wf-99',
      revision: 1,
      enabled: true,
      draftOnly: false,
      mandateOrigin: 'explicit_human',
      spec,
      matchedCount: 0,
      observedCount: 0,
      createdAt: '2026-11-15T00:00:00Z',
      updatedAt: '2026-11-15T00:00:00Z',
    }));

    const studioEvents: Array<{ definitionId?: string | null }> = [];
    const onOpenStudio = (event: Event) => {
      event.preventDefault();
      studioEvents.push(
        (event as CustomEvent<{ definitionId?: string | null }>).detail ?? {}
      );
    };
    window.addEventListener(OPEN_WORKFLOW_STUDIO_EVENT, onOpenStudio);

    try {
      render(<PulseDeckView projectId="proj-1" />);

      const banner = await screen.findByTestId('pulse-onboarding-banner');
      expect(banner).toHaveTextContent('三步开启安全可验证的事件自动化');

      await user.click(screen.getByTestId('pulse-onboarding-open-workflow'));
      expect(studioEvents).toHaveLength(1);

      await user.click(screen.getByTestId('pulse-onboarding-create-rule'));
      expect(screen.getByTestId('pulse-rule-composer')).toBeInTheDocument();

      await user.click(screen.getByTestId('pulse-template-webhook_workflow'));
      await user.click(screen.getByTestId('pulse-composer-save-btn'));

      await waitFor(() => {
        expect(upsertRuleMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'proj-1',
            spec: expect.objectContaining({
              name: 'Webhook 触发工作流',
              evalMode: 'observe',
              targets: [
                expect.objectContaining({
                  kind: 'workflow',
                  workflowId: 'wf-webhook-triage',
                }),
              ],
            }),
          })
        );
      });

      expect(
        await screen.findByTestId('pulse-deck-rule-rule-wf-99')
      ).toBeInTheDocument();

      await user.click(
        screen.getByTestId('pulse-deck-rule-open-workflow-rule-wf-99')
      );
      expect(studioEvents).toHaveLength(2);
      expect(studioEvents[1]).toEqual({ definitionId: 'wf-webhook-triage' });

      // Progressive section filter tabs hide unrelated sections cleanly
      await user.click(screen.getByTestId('pulse-deck-tab-rules'));
      expect(
        screen.queryByTestId('pulse-deck-interactions-section')
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('pulse-deck-sources-strip')
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-rules-list')).toBeInTheDocument();

      await user.click(screen.getByTestId('pulse-deck-open-workflow-studio'));
      expect(studioEvents).toHaveLength(3);
    } finally {
      window.removeEventListener(OPEN_WORKFLOW_STUDIO_EVENT, onOpenStudio);
    }
  });

  it('switches PulseDeckView copy dynamically between zh-CN and en without residue', async () => {
    try {
      render(<PulseDeckView projectId="proj-1" />);

      expect(
        await screen.findByTestId('pulse-source-watermark-src-gh')
      ).toHaveTextContent('已连接 · 游标 ev_1092');
      expect(screen.getByText('脉冲自动化')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-engine-badge')).toHaveTextContent(
        '运行中'
      );
      expect(
        screen.getByTestId('pulse-deck-rule-counts-rule-1')
      ).toHaveTextContent('命中 5 · 观察 3');

      await act(async () => {
        await i18n.changeLanguage('en');
      });

      expect(await screen.findByText('Pulse Automation')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-deck-engine-badge')).toHaveTextContent(
        'Running'
      );
      expect(
        screen.getByTestId('pulse-source-watermark-src-gh')
      ).toHaveTextContent('Connected · Cursor ev_1092');
      expect(
        screen.getByTestId('pulse-deck-rule-counts-rule-1')
      ).toHaveTextContent('Matched 5 · Observed 3');
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });

  it('renders Pending Interactions & Approvals with typed ask_form coercion and notify acknowledgment', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    snapshot.pendingInteractions = [
      {
        id: 'ix-form-1',
        kind: 'ask_form',
        severity: 'warning',
        title: 'Release rollout parameters',
        body: 'Specify canary traffic percentage and dry-run toggle',
        approvalOptions: [],
        formSchema: {
          type: 'object',
          required: ['canaryPercent', 'environment'],
          properties: {
            canaryPercent: {
              type: 'integer',
              title: 'Canary %',
              description: 'Percentage of traffic',
            },
            dryRun: {
              type: 'boolean',
              title: 'Dry Run Only',
              default: true,
            },
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
    vi.mocked(pulseApi.resolveUserInteraction).mockImplementation(
      async ({ interactionId }) => ({
        id: interactionId,
        kind: 'notify',
        severity: 'info',
        title: 'Resolved',
        body: '',
        approvalOptions: [],
        status: 'resolved',
        createdAt: '2026-11-15T00:00:00Z',
        resolvedAt: '2026-11-15T00:02:00Z',
      })
    );

    render(<PulseDeckView projectId="proj-1" />);

    expect(
      await screen.findByText('Release rollout parameters')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('pulse-deck-interactions-section')
    ).toBeInTheDocument();

    const pctInput = await screen.findByLabelText('Canary %');
    await user.type(pctInput, '25');

    const envSelect = screen.getByLabelText('Environment');
    await user.selectOptions(envSelect, 'production');

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

    await user.click(screen.getByTestId('pulse-acknowledge-ix-notify-1'));
    await waitFor(() => {
      expect(pulseApi.resolveUserInteraction).toHaveBeenCalledWith({
        interactionId: 'ix-notify-1',
        optionId: 'acknowledge',
        note: null,
        formValues: null,
      });
    });
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
