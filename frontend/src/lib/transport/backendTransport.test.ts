import { describe, expect, it, vi } from 'vitest';

import { createConversationApi } from '@/features/conversation/conversationApi';
import type { BackendTransport } from './backendTransport';

vi.mock('@tauri-apps/api/core', () => {
  throw new Error('feature tests must not import @tauri-apps/api');
});

describe('BackendTransport conversation tracer', () => {
  it('lists conversations through an injected transport without importing Tauri', async () => {
    const call = vi.fn().mockResolvedValue([
      {
        id: 'conversation-1',
        workspace_id: 'workspace-1',
        title: 'Transport-neutral',
      },
    ]);
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    const conversations =
      await createConversationApi(transport).list('workspace-1');

    expect(conversations[0]?.title).toBe('Transport-neutral');
    expect(call).toHaveBeenCalledWith('conversation_list', {
      workspaceId: 'workspace-1',
    });
  });
});
