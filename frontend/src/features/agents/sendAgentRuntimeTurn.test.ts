import { describe, expect, it, vi } from 'vitest';
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
        executor: 'codex' as const,
        variant: null,
        model: 'gpt-5.4',
      },
      text: 'backend text',
      displayText: 'visible text',
      images: ['.vibe-images/screen.png'],
      modeOverride: 'plan',
    });

    expect(startTurnMock).toHaveBeenCalledWith({
      agentType: 'codex' as const,
      workspaceId: 'workspace-1',
      conversationId: 'session-1',
      executorProfileId: {
        executor: 'codex' as const,
        variant: null,
        model: 'gpt-5.4',
      },
      text: 'visible text',
      images: ['.vibe-images/screen.png'],
      modeOverride: 'plan',
      configOverrides: [],
    });
  });

  it('defaults mode/config overrides to null/empty when unset', async () => {
    startTurnMock.mockClear();
    startTurnMock.mockResolvedValue({
      conversationId: 'session-1',
      turnId: 'turn-2',
      promptId: 'prompt-2',
      status: 'running',
      lastSequence: 3n,
    });

    await sendAgentRuntimeTurn({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      executorProfileId: {
        executor: 'codex' as const,
        variant: null,
        model: 'gpt-5.4',
      },
      text: 'hello',
    });

    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ modeOverride: null, configOverrides: [] })
    );
  });
});
