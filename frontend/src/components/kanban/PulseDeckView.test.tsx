import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
import { PulseDeckView } from './PulseDeckView';

vi.mock('@/lib/api/pulse', () => ({
  pulseApi: {
    deckSnapshot: vi.fn(),
    upsertSource: vi.fn(),
    promoteObservedCandidate: vi.fn(),
    dryRunRule: vi.fn(),
    setRuleMode: vi.fn(),
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
  },
}));

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
              agentId: 'CLAUDE_CODE',
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

describe('PulseDeckView (Track F5 Kanban Stage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue(makeSnapshot());
  });

  it('renders source health watermarks, inspects dry-run, promotes Observe candidates, toggles modes, and binds threads', async () => {
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
    vi.mocked(pulseApi.subscribeThread).mockResolvedValue({
      id: 'sub-2',
      threadKey: 'github:vibex/core#12',
      subscriberKind: 'bot',
      subscriberId: 'bot-triage',
      active: true,
      createdAt: '2026-11-15T00:10:00Z',
    });
    vi.mocked(pulseApi.unsubscribeThread).mockResolvedValue(undefined);

    render(<PulseDeckView projectId="proj-1" />);

    expect(
      await screen.findByText('GitHub Main Webhook')
    ).toBeInTheDocument();
    expect(screen.getByTestId('pulse-source-watermark-src-gh')).toHaveTextContent(
      'wm:ev_1092'
    );

    // Inspect Dry-Run on observed candidate
    await user.click(screen.getByTestId('pulse-candidate-inspect-cand-1'));
    expect(
      await screen.findByTestId('pulse-candidate-dryrun-cand-1')
    ).toHaveTextContent('Investigate Checkout null pointer exception');

    // Promote candidate to Auto
    await user.click(screen.getByTestId('pulse-candidate-promote-cand-1'));
    await waitFor(() => {
      expect(pulseApi.promoteObservedCandidate).toHaveBeenCalledWith('cand-1');
    });

    // Switch rule mode to Auto
    await user.click(screen.getByTestId('pulse-deck-rule-mode-rule-1-auto'));
    await waitFor(() => {
      expect(pulseApi.setRuleMode).toHaveBeenCalledWith('rule-1', 'auto');
    });

    // Bind external thread subscription
    await user.type(
      screen.getByLabelText('Subscription Thread Key'),
      'github:vibex/core#12'
    );
    await user.click(screen.getByTestId('deck-sub-kind-bot'));
    await user.type(screen.getByLabelText('Subscriber ID'), 'bot-triage');
    await user.click(screen.getByTestId('pulse-deck-subscribe-btn'));

    await waitFor(() => {
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'github:vibex/core#12',
        'bot',
        'bot-triage'
      );
    });

    // Unsubscribe existing thread
    await user.click(screen.getByTestId('pulse-deck-unsubscribe-sub-1'));
    await waitFor(() => {
      expect(pulseApi.unsubscribeThread).toHaveBeenCalledWith('sub-1');
    });
  });
});
