import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { sendAgentRuntimeTurn } from './sendAgentRuntimeTurn';

const { startTurnMock } = vi.hoisted(() => ({
  startTurnMock: vi.fn(),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    startTurn: startTurnMock,
  },
}));

describe('sendAgentRuntimeTurn', () => {
  it('starts a canonical conversation turn with text and image paths', async () => {
    startTurnMock.mockResolvedValue({
      conversationId: 'session-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
      status: 'running',
      lastSequence: 2n,
    });

    await sendAgentRuntimeTurn({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      executorProfileId: {
        executor: BaseCodingAgent.CODEX,
        variant: null,
        model: 'gpt-5.4',
      },
      text: 'backend text',
      displayText: 'visible text',
      images: ['.vibe-images/screen.png'],
    });

    expect(startTurnMock).toHaveBeenCalledWith({
      agentType: 'codex',
      workspaceId: 'workspace-1',
      conversationId: 'session-1',
      executorProfileId: {
        executor: BaseCodingAgent.CODEX,
        variant: null,
        model: 'gpt-5.4',
      },
      text: 'visible text',
      images: ['.vibe-images/screen.png'],
    });
  });
});
