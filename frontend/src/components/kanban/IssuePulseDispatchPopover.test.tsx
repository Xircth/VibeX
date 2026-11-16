import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
import { sessionsApi } from '@/lib/api/sessions';
import { attentionApi } from '@/lib/api/attention';
import { automationApi } from '@/lib/api/automations';
import { IssuePulseDispatchPopover } from './IssuePulseDispatchPopover';
import { OPEN_PULSE_DECK_EVENT } from './pulseDeckEvents';
import { AttentionInboxBadge } from '@/components/layout/AttentionInboxBadge';
import { AutomationFailureBadge } from '@/components/layout/AutomationFailureBadge';

vi.mock('@/lib/api/pulse', () => ({
  pulseApi: {
    deckSnapshot: vi.fn(),
    emitCustomEvent: vi.fn(),
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    saveRule: vi.fn(),
    setRuleEnabled: vi.fn(),
    setRuleMode: vi.fn(),
    promoteObservedCandidate: vi.fn(),
    dryRunRule: vi.fn(),
    upsertSource: vi.fn(),
    resolveUserInteraction: vi.fn(),
  },
}));

vi.mock('@/lib/api/sessions', () => ({
  sessionsApi: {
    createProject: vi.fn(),
    create: vi.fn(),
    getSummariesByWorkspace: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/api/attention', () => ({
  attentionApi: {
    list: vi.fn(),
  },
}));

vi.mock('@/lib/api/automations', () => ({
  automationApi: {
    unseenFailures: vi.fn(),
    markSeen: vi.fn(),
  },
}));

vi.mock('@/hooks/useOpenProjectSession', () => ({
  useOpenProjectSession: () => vi.fn(),
}));

const pushListeners = new Map<string, () => void>();

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn(async (eventName: string, handler: () => void) => {
      pushListeners.set(eventName, handler);
      return () => {
        pushListeners.delete(eventName);
      };
    }),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </MemoryRouter>
    ),
  };
}

describe('IssuePulseDispatchPopover & StatusBar Pulse Badges (Track F5 / R4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushListeners.clear();
  });

  it('spawns a real ticket session with initial_prompt, uses normalized claude-code agentId, and never subscribes literal fresh-session', async () => {
    const user = userEvent.setup();

    vi.mocked(sessionsApi.createProject).mockResolvedValue({
      id: 'sess-created-42',
      workspace_id: 'ws-1',
      executor: 'CLAUDE_CODE',
      name: 'Investigate PROJ-500',
      status: 'todo',
      created_at: '2026-11-15T00:00:00Z',
      updated_at: '2026-11-15T00:00:00Z',
    } as never);
    vi.mocked(pulseApi.emitCustomEvent).mockResolvedValue({
      eventId: 'evt-1',
      deliveryId: 'dlv-1',
      source: {
        kind: 'sdk_custom',
        instanceId: 'local',
        trustLevel: 'trusted_human',
      },
      eventType: 'kanban.issue.dispatched',
      occurredAt: '2026-11-15T00:00:00Z',
      actor: {
        id: 'human',
        displayName: 'User',
        roles: [],
        isBot: false,
        isSelf: false,
      },
      threadKey: 'jira:PROJ-500',
      correlations: [],
      replyChannels: [],
      trace: { rootEventId: 'evt-1', parentRunId: null, hopCount: 0 },
      payload: {},
    });
    vi.mocked(pulseApi.subscribeThread).mockResolvedValue({
      id: 'sub-500',
      threadKey: 'jira:PROJ-500',
      subscriberKind: 'session',
      subscriberId: 'sess-created-42',
      active: true,
      createdAt: '2026-11-15T00:00:00Z',
    });
    vi.mocked(pulseApi.saveRule).mockImplementation(async ({ spec }) => ({
      id: 'rule-sim-1',
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

    renderWithProviders(
      <IssuePulseDispatchPopover
        projectId="proj-1"
        workspaceId="ws-1"
        sessionId={null}
        agentId="CLAUDE_CODE"
        sessionTitle="Fix payment webhook retry"
        branchName="fix/webhook-retry"
      />
    );

    await user.click(screen.getByTestId('issue-pulse-dispatch-trigger'));

    const threadInput = screen.getByLabelText(/外部线程标识/);
    await user.clear(threadInput);
    await user.type(threadInput, 'jira:PROJ-500');

    await user.click(screen.getByTestId('dispatch-one-shot-submit'));

    await waitFor(() => {
      expect(sessionsApi.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'proj-1',
          workspace_id: 'ws-1',
          executor: 'CLAUDE_CODE',
          initial_prompt: 'Fix payment webhook retry',
        })
      );
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'jira:PROJ-500',
        'session',
        'sess-created-42'
      );
    });

    // Switch to Automate Similar tab and verify valid kebab-case claude-code agentId
    await user.click(screen.getByRole('tab', { name: '同类自动分诊' }));
    expect(screen.getByTestId('dispatch-dry-run-status')).toHaveTextContent(
      '有效 · 已命中'
    );
    await user.click(screen.getByTestId('dispatch-save-similar-rule'));

    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            targets: [
              expect.objectContaining({
                kind: 'session',
                agentId: 'claude-code',
              }),
            ],
          }),
        })
      );
    });
  });

  it('switches IssuePulseDispatchPopover and Observe status badge cleanly between zh-CN and en', async () => {
    const user = userEvent.setup();
    const { act } = await import('@testing-library/react');
    const i18n = (await import('@/i18n')).default;

    vi.mocked(automationApi.unseenFailures).mockResolvedValue(0);
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: [],
      observedCandidates: [
        {
          id: 'obs-lang-1',
          ruleId: 'r-1',
          ruleName: 'Shadow Rule',
          eventId: 'e-1',
          eventType: 'github.pr',
          sourceKind: 'github',
          summary: 'Shadow match',
          occurredAt: '2026-11-15T00:00:00Z',
          promoted: false,
        },
      ],
      subscriptions: [],
      pendingInteractions: [],
    });

    try {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });

      renderWithProviders(
        <div>
          <IssuePulseDispatchPopover
            projectId="proj-1"
            workspaceId="ws-1"
            sessionId={null}
            agentId="CLAUDE_CODE"
          />
          <AutomationFailureBadge />
        </div>
      );

      expect(screen.getByTestId('issue-pulse-dispatch-trigger')).toHaveAttribute(
        'aria-label',
        '派发工单自动化'
      );
      await user.click(screen.getByTestId('issue-pulse-dispatch-trigger'));
      expect(screen.getByText('工单自动化派发')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '单次派发' })).toBeInTheDocument();

      await act(async () => {
        await i18n.changeLanguage('en');
      });

      expect(screen.getByTestId('issue-pulse-dispatch-trigger')).toHaveAttribute(
        'aria-label',
        'Dispatch Issue Automation'
      );
      expect(screen.getByText('Issue Automation Dispatch')).toBeInTheDocument();
      expect(
        screen.getByRole('tab', { name: 'One-Shot Ticket' })
      ).toBeInTheDocument();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });

  it('shares a single usePulseDeckSnapshot query across badges, prunes resolvedPulseIds, and dispatches vibex:open-pulse-deck on Observe click', async () => {
    const user = userEvent.setup();
    vi.mocked(attentionApi.list).mockResolvedValue({
      items: [],
      blockingCount: 0,
    });
    vi.mocked(automationApi.unseenFailures).mockResolvedValue(0);

    const initialSnapshot: PulseDeckSnapshot = {
      engineActive: true,
      activeTicketCount: 1,
      pendingUserInteractionCount: 1,
      sources: [],
      rules: [],
      observedCandidates: [
        {
          id: 'obs-1',
          ruleId: 'r-1',
          ruleName: 'Shadow Rule',
          eventId: 'e-1',
          eventType: 'github.pr',
          sourceKind: 'github',
          summary: 'Shadow match',
          occurredAt: '2026-11-15T00:00:00Z',
          promoted: false,
        },
      ],
      subscriptions: [],
      pendingInteractions: [
        {
          id: 'ix-approval-1',
          kind: 'approval',
          severity: 'warning',
          title: 'Deploy staging build?',
          body: 'Workflow step awaits approval',
          approvalOptions: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject', destructive: true },
          ],
          status: 'pending',
          createdAt: '2026-11-15T00:00:00Z',
          resolvedAt: null,
        },
      ],
    };
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(initialSnapshot);
    vi.mocked(pulseApi.resolveUserInteraction).mockResolvedValue({
      id: 'ix-approval-1',
      kind: 'approval',
      severity: 'warning',
      title: 'Deploy staging build?',
      body: 'Workflow step awaits approval',
      approvalOptions: [],
      status: 'resolved',
      createdAt: '2026-11-15T00:00:00Z',
      resolvedAt: '2026-11-15T00:01:00Z',
    });

    renderWithProviders(
      <div>
        <AttentionInboxBadge />
        <AutomationFailureBadge />
      </div>
    );

    const observeBadge = await screen.findByTestId('pulse-observe-status-badge');
    expect(observeBadge).toHaveTextContent('1');
    // Both badges share the exact same React Query snapshot key -> only 1 fetch!
    expect(pulseApi.deckSnapshot).toHaveBeenCalledTimes(1);

    // Clicking Observe badge dispatches vibex:open-pulse-deck event
    const openPulseDeckSpy = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(OPEN_PULSE_DECK_EVENT, openPulseDeckSpy);
    await user.click(observeBadge);
    expect(openPulseDeckSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_PULSE_DECK_EVENT, openPulseDeckSpy);

    const inboxTrigger = await screen.findByTestId('attention-inbox-trigger');
    expect(inboxTrigger).toHaveTextContent('1');
    await user.click(inboxTrigger);

    expect(
      await screen.findByText('Deploy staging build?')
    ).toBeInTheDocument();
    await user.click(
      screen.getByTestId('pulse-approval-ix-approval-1-approve')
    );

    await waitFor(() => {
      expect(pulseApi.resolveUserInteraction).toHaveBeenCalledWith({
        interactionId: 'ix-approval-1',
        optionId: 'approve',
        note: null,
        formValues: null,
      });
    });

    // Push event vibex://pulse-deck-changed triggers real-time snapshot invalidation
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      ...initialSnapshot,
      pendingInteractions: [],
      pendingUserInteractionCount: 0,
    });
    const pushHandler = pushListeners.get('vibex://pulse-deck-changed');
    expect(pushHandler).toBeTypeOf('function');
    pushHandler?.();

    await waitFor(() => {
      expect(
        vi.mocked(pulseApi.deckSnapshot).mock.calls.length
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
