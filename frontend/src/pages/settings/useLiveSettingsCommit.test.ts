import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useLiveSettingsCommit } from './useLiveSettingsCommit';

describe('useLiveSettingsCommit', () => {
  it('writes a discrete change without a later confirm', async () => {
    const save = vi.fn(async () => undefined);
    const { result } = renderHook(() => useLiveSettingsCommit(save));

    act(() => {
      result.current.writeNow({ theme: 'dark' });
    });

    await act(async () => {
      await result.current.flush();
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('keeps only the newest value when edits overlap', async () => {
    let release: (() => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const { result } = renderHook(() => useLiveSettingsCommit(save));

    let flushed: Promise<void> = Promise.resolve();
    act(() => {
      result.current.writeNow('first');
      result.current.writeNow('second');
      flushed = result.current.flush();
    });

    await act(async () => {
      release?.();
      await flushed;
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('second');
  });
});
