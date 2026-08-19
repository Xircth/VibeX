import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { WorkflowStepConversation } from './WorkflowStepConversation';

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline: () => ({
    timeline: [
      {
        key: 'user-1',
        phase: 'persisted',
        revision: 1n,
        turn: {
          id: 'turn-1:user',
          role: 'user',
          blocks: [{ type: 'text', text: 'Run this node' }],
          timestamp: '2026-08-18T00:00:00.000Z',
        },
      },
      {
        key: 'assistant-1',
        phase: 'persisted',
        revision: 2n,
        turn: {
          id: 'turn-1:assistant',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Finished the node work.' }],
          timestamp: '2026-08-18T00:00:01.000Z',
        },
      },
    ],
    items: [],
    sideRows: [],
    loading: false,
    error: null,
    lastSequence: 2n,
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
  }),
}));

describe('WorkflowStepConversation', () => {
  it('reuses the session message-turn renderer for user and Agent turns', () => {
    render(
      <WorkflowStepConversation
        saved
        stepRun={{
          id: 'sr-1',
          runId: 'run-1',
          stepId: 'start',
          attempt: 1n,
          status: 'running',
          conversationId: 'conv-1',
          turnId: 'turn-1',
          outputJson: null,
          outputSchemaDigest: null,
          candidateOutputJson: null,
          candidateSchemaDigest: null,
          awaitingAcceptance: false,
          awaitingInput: false,
          executionMode: 'debug',
          resolvedInputJson: null,
          resolvedInputDigest: null,
          executionEvidenceJson: null,
          workspaceId: 'ws-1',
          waitingInteraction: false,
          repairCount: 0n,
          claimToken: null,
          claimDeadline: null,
          startedAt: '2026-08-18T00:00:00.000Z',
          completedAt: null,
          updatedAt: '2026-08-18T00:00:01.000Z',
        }}
      />
    );

    expect(
      screen.getByRole('article', { name: 'Message from user' })
    ).toHaveTextContent('Run this node');
    expect(screen.getByText('Finished the node work.')).toBeInTheDocument();
    expect(screen.queryByText('user')).toBeNull();
    expect(
      screen.queryByPlaceholderText(/为此节点补充指导|additional guidance/i)
    ).toBeNull();
  });
});
