import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { sendAgentRuntimeTurn } from './sendAgentRuntimeTurn';

const { sendWorkspacePromptMock } = vi.hoisted(() => ({
  sendWorkspacePromptMock: vi.fn(),
}));

vi.mock('./api', () => ({
  agentsApi: {
    sendWorkspacePrompt: sendWorkspacePromptMock,
  },
}));

describe('sendAgentRuntimeTurn', () => {
  it('sends text and image paths through the ACP workspace prompt API', async () => {
    sendWorkspacePromptMock.mockResolvedValue({
      id: 'prompt-1',
      session_id: 'session-1',
      status: { kind: 'running' },
      text_preview: 'hello',
      created_at: '2026-06-11T00:00:00.000Z',
      updated_at: '2026-06-11T00:00:00.000Z',
    });

    await sendAgentRuntimeTurn({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      executorProfileId: { executor: BaseCodingAgent.CODEX, variant: null },
      text: 'backend text',
      displayText: 'visible text',
      images: ['.vibe-images/screen.png'],
    });

    expect(sendWorkspacePromptMock).toHaveBeenCalledWith({
      agentType: 'codex',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      text: 'visible text',
      images: ['.vibe-images/screen.png'],
    });
  });
});
