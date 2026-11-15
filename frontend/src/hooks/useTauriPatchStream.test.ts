import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport, RemoteEvent } from '@/lib/transport';
import { mountBackendTransport } from '@/lib/transport/transportRegistry';
import { usePatchStream } from './useTauriPatchStream';

describe('usePatchStream', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resets isConnected and sets error when stream terminates unexpectedly, then retries cleanly', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let resolveSecondEvent:
      | ((value: IteratorResult<RemoteEvent>) => void)
      | undefined;

    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        attempt += 1;
        const currentAttempt = attempt;
        let step = 0;
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (currentAttempt === 1) {
              step += 1;
              if (step === 1) {
                return {
                  done: false,
                  value: {
                    sequence: 1n,
                    kind: 'patch',
                    payload: 'Ready',
                  },
                };
              }
              return { done: true, value: undefined };
            }
            step += 1;
            if (step === 1) {
              return {
                done: false,
                value: {
                  sequence: 1n,
                  kind: 'patch',
                  payload: 'Ready',
                },
              };
            }
            return new Promise<IteratorResult<RemoteEvent>>((resolve) => {
              resolveSecondEvent = resolve;
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const initialData = () => ({ items: {} as Record<string, unknown> });
      const { result, unmount } = renderHook(() =>
        usePatchStream({
          subscribeCommand: 'subscribe_diff_stream',
          eventChannel: 'diff-stream',
          initialData,
          enabled: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe('Stream disconnected unexpectedly');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
      });

      expect(attempt).toBe(2);
      expect(result.current.isConnected).toBe(true);
      expect(result.current.error).toBeNull();

      resolveSecondEvent?.({ done: true, value: undefined });
      unmount();
    } finally {
      unmountTransport();
    }
  });

  it('resets isConnected to false when subscription rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            throw Object.assign(new Error('Subscription crashed'), {
              retryable: false,
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const initialData = () => ({ items: {} as Record<string, unknown> });
      const { result, unmount } = renderHook(() =>
        usePatchStream({
          subscribeCommand: 'subscribe_diff_stream',
          eventChannel: 'diff-stream',
          initialData,
          enabled: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe('Subscription crashed');
      expect(errorSpy).toHaveBeenCalled();

      unmount();
    } finally {
      unmountTransport();
    }
  });
});
