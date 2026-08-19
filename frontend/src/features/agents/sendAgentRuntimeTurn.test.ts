import { describe, expect, it, vi } from 'vitest';
import { sendAgentRuntimeTurn } from './sendAgentRuntimeTurn';

const { submitInputMock } = vi.hoisted(() => ({
  submitInputMock: vi.fn(),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    submitInput: submitInputMock,
  },
}));

describe('sendAgentRuntimeTurn', () => {
  it('submits canonical durable input with text and image paths', async () => {
    submitInputMock.mockResolvedValue({
      input: { id: 'input-1', status: 'dispatched' },
      turn: { turnId: 'turn-1' },
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
      workflowRefs: [
        {
          pluginId: 'vibex.office',
          workflowId: 'create-presentation',
        },
      ],
      operationId: 'op-stable-1',
    });

    expect(submitInputMock).toHaveBeenCalledWith(
      'session-1',
      {
        agentId: 'codex',
        workspaceId: 'workspace-1',
        executorProfileId: {
          executor: 'codex' as const,
          variant: null,
          model: 'gpt-5.4',
        },
        text: 'backend text',
        displayText: 'visible text',
        images: ['.vibe-images/screen.png'],
        modeOverride: 'plan',
        configOverrides: [],
        workflowRefs: [
          {
            pluginId: 'vibex.office',
            workflowId: 'create-presentation',
          },
        ],
        fileRefs: [],
      },
      'op-stable-1'
    );
  });

  it('defaults mode/config overrides to null/empty when unset', async () => {
    submitInputMock.mockClear();
    submitInputMock.mockResolvedValue({
      input: { id: 'input-2', status: 'dispatched' },
      turn: { turnId: 'turn-2' },
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

    expect(submitInputMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        text: 'hello',
        displayText: 'hello',
        modeOverride: null,
        configOverrides: [],
        workflowRefs: [],
        fileRefs: [],
      }),
      undefined
    );
  });
});
