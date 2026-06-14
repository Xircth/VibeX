import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_EVENTS_CHANNEL, listenToConversationEvents } from './events';

const { tauriListenMock } = vi.hoisted(() => ({
  tauriListenMock: vi.fn(),
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriListen: tauriListenMock,
}));

describe('listenToConversationEvents', () => {
  it('subscribes to the canonical conversation event channel', async () => {
    const unsubscribe = vi.fn();
    tauriListenMock.mockResolvedValue(unsubscribe);
    const handler = vi.fn();

    await expect(listenToConversationEvents(handler)).resolves.toBe(unsubscribe);

    expect(tauriListenMock).toHaveBeenCalledWith(
      CONVERSATION_EVENTS_CHANNEL,
      handler
    );
  });
});
