import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_EVENTS_CHANNEL,
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
});
