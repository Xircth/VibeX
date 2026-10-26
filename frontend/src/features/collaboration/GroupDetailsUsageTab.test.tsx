import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnUsage } from 'shared/types';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';

import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { GroupDetailsUsageTab } from './GroupDetailsUsageTab';

const collaborationCall = vi.hoisted(() => vi.fn());
const useConversationTimeline = vi.hoisted(() => vi.fn());
const useConversationSessionFacts = vi.hoisted(() => vi.fn());

vi.mock('./collaborationApi', () => ({
  collaborationCall,
}));

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline,
  useConversationSessionFacts,
}));

vi.mock('@/components/panels/session-details/SessionQuota', () => ({
  SessionQuota: ({
    agentId,
    onActive,
  }: {
    agentId: string | null;
    onActive?: (active: boolean) => void;
  }) => {
    useEffect(() => {
      onActive?.(Boolean(agentId));
    }, [agentId, onActive]);
    if (!agentId) return null;
    return <div data-testid={`group-details-quota-${agentId}`}>{agentId}</div>;
  },
}));

function usage(
  input: number,
  output: number,
  extra: Partial<TurnUsage> = {}
): TurnUsage {
  return {
    input_tokens: BigInt(input),
    output_tokens: BigInt(output),
    cache_creation_input_tokens: 0n,
    cache_read_input_tokens: 0n,
    context_window_max: null,
    ...extra,
  };
}

function assistantTurn(
  id: string,
  model: string,
  turnUsage: TurnUsage
): ConversationTimelineTurn {
  return {
    key: id,
    phase: 'settled',
    revision: 1n,
    turn: {
      id,
      role: 'assistant',
      blocks: [],
      timestamp: '2026-01-01T00:00:00.000Z',
      model,
      usage: turnUsage,
    },
  };
}

function timelineFor(turns: ConversationTimelineTurn[]) {
  return {
    timeline: turns,
    items: [],
    sideRows: [],
    agentId: 'GROK',
    currentTurnId: null,
    steeringSupported: false,
    deliveryChannel: 'workspace',
    forkSessionSupported: false,
    loading: false,
    error: null,
    lastSequence: 0n,
    sessionModes: { current: null, modes: [] },
    sessionConfigOptions: [],
    sendOptimisticTurn: vi.fn(),
    removeOptimisticTurn: vi.fn(),
    refresh: vi.fn(),
    resetAndReload: vi.fn(),
    reconnectAndReload: vi.fn(),
    cancel: vi.fn(),
    respondPermission: vi.fn(),
    respondQuestion: vi.fn(),
    hasEarlier: false,
    loadOlder: vi.fn(),
    olderTurnsPrependEpoch: 0,
    userTurnsBeforeOffset: 0,
    sessionBindReady: true,
    connecting: false,
  };
}

function factsFor(sessionId: string, agentId: string) {
  return {
    sessionId,
    hasDetail: true,
    error: null,
    title: null,
    status: 'inprogress' as const,
    agentId,
    model: 'grok-4.6',
    acpSessionId: null,
    externalSessionId: null,
    turnInFlight: false,
    sessionStats: null,
    truncated: false,
    loading: false,
  };
}

describe('GroupDetailsUsageTab', () => {
  beforeEach(() => {
    collaborationCall.mockReset();
    collaborationCall.mockImplementation(async () => {
      return {
        members: [
          {
            member_id: 'm1',
            nickname: '小A',
            kind: 'agent',
            visible_to_agents: 1,
            conversation_id: 'conv-1',
          },
          {
            member_id: 'm2',
            nickname: '小B',
            kind: 'agent',
            visible_to_agents: 1,
            conversation_id: 'conv-2',
          },
        ],
      };
    });
    useConversationTimeline.mockImplementation((id: string | null) => {
      if (id === 'conv-1') {
        return timelineFor([
          assistantTurn(
            'a1',
            'grok-4.6',
            usage(10, 5, { cache_read_input_tokens: 5n })
          ),
        ]);
      }
      if (id === 'conv-2') {
        return timelineFor([assistantTurn('a2', 'grok-4.6', usage(20, 10))]);
      }
      return timelineFor([]);
    });
    useConversationSessionFacts.mockImplementation((id: string | null) =>
      factsFor(id || 'missing', 'GROK')
    );
  });

  it('shows one quota card for a shared Agent, a token overview without cache rate, and collapsible member rows', async () => {
    const user = userEvent.setup();
    render(
      <GroupDetailsUsageTab
        spaceId="s1"
        getAvatar={(conversationId, nickname) =>
          deriveMemberBotAvatar(conversationId || nickname || 'bot')
        }
      />
    );

    const cardA = await screen.findByTestId('group-details-usage-conv-1');
    const cardB = await screen.findByTestId('group-details-usage-conv-2');
    expect(cardA).toHaveTextContent('小A');
    expect(cardB).toHaveTextContent('小B');
    expect(within(cardA).queryByText('Agent')).toBeNull();
    expect(cardA).toHaveTextContent('Grok');
    expect(cardA).toHaveTextContent('grok-4.6');
    expect(cardA).toHaveTextContent('20');
    expect(cardA).toHaveTextContent('33%');

    await waitFor(() => {
      expect(screen.getAllByTestId('group-details-quota-GROK')).toHaveLength(1);
    });
    expect(
      screen
        .queryByTestId('group-details-quota-GROK')
        ?.closest('[data-testid="group-details-usage-conv-1"]')
    ).toBeNull();

    const overview = screen.getByTestId('group-details-token-overview');
    expect(overview).toHaveTextContent('Token 概览');
    expect(overview).toHaveTextContent('50');
    expect(overview).toHaveTextContent('grok-4.6');
    expect(overview).not.toHaveTextContent('缓存率');
    expect(overview).not.toHaveTextContent('%');

    await user.click(within(cardA).getByRole('button', { name: '小A' }));
    expect(within(cardA).queryByText('grok-4.6')).toBeNull();
    expect(cardA).toHaveTextContent('小A');
    expect(cardA).toHaveTextContent('Grok');
    expect(screen.queryByLabelText('负责人')).toBeNull();
  });
});
