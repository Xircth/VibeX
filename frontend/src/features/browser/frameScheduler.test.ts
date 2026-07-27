import { describe, expect, it, vi } from 'vitest';
import { createFrameScheduler } from './frameScheduler';

describe('createFrameScheduler', () => {
  it('stabilizes position-only layout changes across two frames', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let nextFrameId = 7;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return nextFrameId++;
    });
    const cancelFrame = vi.fn();
    let surfaceY = 48;
    const synchronizedPositions: number[] = [];
    const synchronize = vi.fn(() => synchronizedPositions.push(surfaceY));
    const scheduler = createFrameScheduler(
      synchronize,
      requestFrame,
      cancelFrame
    );

    scheduler.request();
    scheduler.request();
    expect(requestFrame).toHaveBeenCalledOnce();

    frameCallbacks[0]?.(0);
    expect(synchronizedPositions).toEqual([48]);
    expect(requestFrame).toHaveBeenCalledTimes(2);

    surfaceY = 84;
    frameCallbacks[1]?.(16);
    expect(synchronizedPositions).toEqual([48, 84]);

    scheduler.request();
    expect(requestFrame).toHaveBeenCalledTimes(3);

    scheduler.cancel();
    expect(cancelFrame).toHaveBeenCalledWith(9);
  });
});
