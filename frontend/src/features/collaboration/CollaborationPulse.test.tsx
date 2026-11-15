import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pulseApi, type PulseRuleView } from '@/lib/api/pulse';
import {
  buildBotPulseProposalSpec,
  buildGroupPulseProposalSpec,
} from './collaborationPulseEvents';
import { PulseRuleProposalCard } from './PulseRuleProposalCard';
import { BotAutomationsPanel } from './BotAutomationsPanel';
import { GroupPulsePanel } from './GroupPulsePanel';

vi.mock('@/lib/api/pulse', () => ({
  pulseApi: {
    deckSnapshot: vi.fn(),
    listRules: vi.fn(),
    saveRule: vi.fn(),
    setRuleMode: vi.fn(),
    setRuleEnabled: vi.fn(),
    deleteRule: vi.fn(),
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
  },
}));

function makeSavedRule(overrides: Partial<PulseRuleView> = {}): PulseRuleView {
  return {
    id: 'rule-1',
    revision: 2,
    enabled: true,
    draftOnly: false,
    mandateOrigin: 'explicit_human',
    spec: buildBotPulseProposalSpec({
      memberId: 'bot-1',
      botName: 'Triage Bot',
      sourceKind: 'jira',
      evalMode: 'observe',
      description: 'Triage P0 bugs',
    }),
    webhookRouteId: null,
    nextFireAt: null,
    matchedCount: 4,
    observedCount: 2,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

describe('Collaboration Pulse UI (Track F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('evaluates PulseRuleProposalCard live dry-run locally and saves via pulseApi.saveRule', async () => {
    const user = userEvent.setup();
    const saved = makeSavedRule();
    vi.mocked(pulseApi.saveRule).mockResolvedValue(saved);
    const onSaved = vi.fn();

    render(
      <PulseRuleProposalCard
        initialSpec={saved.spec}
        contextLabel="Bot · Triage Bot"
        onSaved={onSaved}
      />
    );

    expect(screen.getByTestId('pulse-dry-run-status')).toHaveTextContent(
      'Matched'
    );

    await user.click(screen.getByTestId('pulse-save-rule-btn'));

    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledTimes(1);
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(screen.getByTestId('pulse-rule-saved-banner')).toBeInTheDocument();
  });

  it('renders BotAutomationsPanel bound rules and updates eval mode', async () => {
    const user = userEvent.setup();
    const rule = makeSavedRule();
    vi.mocked(pulseApi.listRules).mockResolvedValue([rule]);
    vi.mocked(pulseApi.setRuleMode).mockResolvedValue({
      ...rule,
      spec: { ...rule.spec, evalMode: 'auto' },
    });

    render(<BotAutomationsPanel memberId="bot-1" botName="Triage Bot" />);

    expect(await screen.findByText(rule.spec.name)).toBeInTheDocument();

    const autoBtn = screen.getByRole('button', { name: 'Auto' });
    await user.click(autoBtn);

    await waitFor(() => {
      expect(pulseApi.setRuleMode).toHaveBeenCalledWith('rule-1', 'auto');
    });
  });

  it('renders GroupPulsePanel seat-bound rules and subscribes external threads', async () => {
    const user = userEvent.setup();
    const groupSpec = buildGroupPulseProposalSpec({
      spaceId: 'space-core',
      spaceName: 'Core Team',
      dispatchMode: { type: 'specific_seat', memberId: 'seat-qa' },
      sourceKind: 'github',
      evalMode: 'observe',
      description: 'Notify QA on PR failure',
    });
    const groupRule = makeSavedRule({
      id: 'rule-group-1',
      spec: groupSpec,
    });

    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: [groupRule],
      observedCandidates: [],
      subscriptions: [
        {
          id: 'sub-1',
          threadKey: 'github:org/repo#99',
          subscriberKind: 'group',
          subscriberId: 'space-core',
          active: true,
          createdAt: '2026-11-15T00:00:00Z',
        },
      ],
      pendingInteractions: [],
    });
    vi.mocked(pulseApi.listRules).mockResolvedValue([groupRule]);
    vi.mocked(pulseApi.subscribeThread).mockResolvedValue({
      id: 'sub-2',
      threadKey: 'jira:CORE-77',
      subscriberKind: 'group',
      subscriberId: 'space-core',
      active: true,
      createdAt: '2026-11-15T00:00:00Z',
    });

    render(
      <GroupPulsePanel
        spaceId="space-core"
        spaceName="Core Team"
        roster={[{ memberId: 'seat-qa', nickname: 'QA' }]}
      />
    );

    expect(await screen.findByText(groupSpec.name)).toBeInTheDocument();
    expect(screen.getByText('github:org/repo#99')).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/jira:PROJ-123/i);
    await user.type(input, 'jira:CORE-77');
    await user.click(screen.getByTestId('group-pulse-subscribe-btn'));

    await waitFor(() => {
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'jira:CORE-77',
        'group',
        'space-core'
      );
    });
  });
});
