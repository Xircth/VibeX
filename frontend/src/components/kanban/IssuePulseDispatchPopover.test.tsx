import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pulseApi } from '@/lib/api/pulse';
import { attentionApi } from '@/lib/api/attention';
import { automationApi } from '@/lib/api/automations';
import { IssuePulseDispatchPopover } from './IssuePulseDispatchPopover';
import { PulseGuardMenu } from '@/components/layout/BranchInfoHeader';
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
    resolveUserInteraction: vi.fn(),
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

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn().mockResolvedValue(() => undefined),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe('IssuePulseDispatchPopover, PulseGuardMenu & StatusBar Pulse Badges (Track F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches a one-shot ticket with external thread subscription and saves an Automate Similar rule', async () => {
    const user = userEvent.setup();
    const onCreateFreshSession = vi.fn();

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
      subscriberId: 'sess-1',
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
        sessionId="sess-1"
        sessionTitle="Fix payment webhook retry"
        branchName="fix/webhook-retry"
        onCreateFreshSession={onCreateFreshSession}
      />
    );

    await user.click(screen.getByTestId('issue-pulse-dispatch-trigger'));

    const threadInput = screen.getByLabelText(/External Thread Key/i);
    await user.clear(threadInput);
    await user.type(threadInput, 'jira:PROJ-500');

    await user.click(screen.getByTestId('dispatch-one-shot-submit'));

    await waitFor(() => {
      expect(pulseApi.emitCustomEvent).toHaveBeenCalledTimes(1);
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'jira:PROJ-500',
        'session',
        'sess-1'
      );
    });
    expect(onCreateFreshSession).toHaveBeenCalledTimes(1);

    // Switch to Automate Similar tab and save rule
    await user.click(screen.getByRole('tab', { name: 'Automate Similar' }));
    expect(screen.getByTestId('dispatch-dry-run-status')).toHaveTextContent(
      'Valid · Matched'
    );
    await user.click(screen.getByTestId('dispatch-save-similar-rule'));

    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledTimes(1);
    });
  });

  it('toggles branch-scoped PR/CI Pulse guards in 1 click inside PulseGuardMenu', async () => {
    const user = userEvent.setup();
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: [],
      observedCandidates: [],
      subscriptions: [],
      pendingInteractions: [],
    });
    vi.mocked(pulseApi.saveRule).mockImplementation(async ({ spec }) => ({
      id: `saved-${spec.name}`,
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
    vi.mocked(pulseApi.subscribeThread).mockResolvedValue({
      id: 'sub-pr',
      threadKey: 'github:VibeX#feature/pulse',
      subscriberKind: 'session',
      subscriberId: 'ws-1',
      active: true,
      createdAt: '2026-11-15T00:00:00Z',
    });

    renderWithProviders(
      <PulseGuardMenu
        repoName="VibeX"
        branchName="feature/pulse"
        worktreeId="ws-1"
      />
    );

    await user.click(screen.getByTestId('branch-pulse-guard-trigger'));
    await user.click(screen.getByTestId('pulse-guard-ci-failure'));

    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByTestId('pulse-guard-subscribe-pr'));
    await waitFor(() => {
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'github:VibeX#feature/pulse',
        'session',
        'ws-1'
      );
    });
  });

  it('resolves pending Pulse approval and ask_form interactions inline in AttentionInboxBadge and surfaces Observe count in AutomationFailureBadge', async () => {
    const user = userEvent.setup();
    vi.mocked(attentionApi.list).mockResolvedValue({
      items: [],
      blockingCount: 0,
    });
    vi.mocked(automationApi.unseenFailures).mockResolvedValue(0);
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 1,
      pendingUserInteractionCount: 2,
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
    });
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

    expect(
      await screen.findByTestId('pulse-observe-status-badge')
    ).toHaveTextContent('1');

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
  });
});
