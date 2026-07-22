import { describe, expect, it, vi } from 'vitest';
import { createFrameScheduler } from './frameScheduler';

describe('createFrameScheduler', () => {
  it('coalesces repeated layout notifications into one frame', () => {
    let frameCallback: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 7;
    });
    const cancelFrame = vi.fn();
    const synchronize = vi.fn();
    const scheduler = createFrameScheduler(
      synchronize,
      requestFrame,
      cancelFrame
    );

    scheduler.request();
    scheduler.request();
    expect(requestFrame).toHaveBeenCalledOnce();

    frameCallback?.(0);
    expect(synchronize).toHaveBeenCalledOnce();
    scheduler.request();
    expect(requestFrame).toHaveBeenCalledTimes(2);

    scheduler.cancel();
    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
