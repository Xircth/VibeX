import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_EVENTS_CHANNEL,
  conversationEventsChannel,
  listenToConversationEvents,
} from './events';

const { backendListenMock } = vi.hoisted(() => ({
  backendListenMock: vi.fn(),
}));

vi.mock('@/lib/backendTransport', () => ({
  backendListen: backendListenMock,
}));

describe('listenToConversationEvents', () => {
  it('subscribes to the canonical conversation event channel', async () => {
    const unsubscribe = vi.fn();
    backendListenMock.mockResolvedValue(unsubscribe);
    const handler = vi.fn();

    await expect(listenToConversationEvents(handler)).resolves.toBe(
      unsubscribe
    );

    expect(backendListenMock).toHaveBeenCalledWith(
      CONVERSATION_EVENTS_CHANNEL,
      handler
    );
  });

  it('subscribes to a per-conversation channel when an id is given', async () => {
    const unsubscribe = vi.fn();
    backendListenMock.mockResolvedValue(unsubscribe);
    const handler = vi.fn();
    const conversationId = '11111111-1111-1111-1111-111111111111';

    await expect(
      listenToConversationEvents(handler, conversationId)
    ).resolves.toBe(unsubscribe);

    expect(backendListenMock).toHaveBeenCalledWith(
      conversationEventsChannel(conversationId),
      handler
    );
  });
});
