import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationAvailableCommands } from './useConversationAvailableCommands';

const detail = vi.fn();
const listen = vi.fn();

vi.mock('./conversationApi', () => ({
  conversationApi: {
    detail: (...args: unknown[]) => detail(...args),
  },
}));

vi.mock('./events', () => ({
  listenToConversationEvents: (onBatch: (batch: unknown) => void) =>
    listen(onBatch),
}));

describe('useConversationAvailableCommands', () => {
  beforeEach(() => {
    detail.mockReset();
    listen.mockReset();
    listen.mockResolvedValue(() => undefined);
  });

  it('stays loading until the agent advertises a catalog', async () => {
    detail.mockResolvedValue({ available_commands: null });
    const { result } = renderHook(() =>
      useConversationAvailableCommands('conversation-1')
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.commands).toBeNull();
    await waitFor(() => expect(detail).toHaveBeenCalled());
    expect(result.current.loading).toBe(true);
  });

  it('replaces the live catalog when a conversation batch arrives', async () => {
    let onBatch: ((batch: unknown) => void) | undefined;
    detail.mockResolvedValue({ available_commands: null });
    listen.mockImplementation((handler: (batch: unknown) => void) => {
      onBatch = handler;
      return Promise.resolve(() => undefined);
    });

    const { result } = renderHook(() =>
      useConversationAvailableCommands('conversation-1')
    );
    await waitFor(() => expect(listen).toHaveBeenCalled());

    act(() => {
      onBatch?.({
        conversation_id: 'conversation-1',
        available_commands: [{ name: 'compact', description: 'Compact' }],
      });
    });

    expect(result.current.commands).toEqual([
      { name: 'compact', description: 'Compact' },
    ]);
    expect(result.current.loading).toBe(false);
  });
});
