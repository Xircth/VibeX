import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleIdleWork } from './scheduleIdleWork';

describe('scheduleIdleWork', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses requestIdleCallback when available', () => {
    const cancel = vi.fn();
    const request = vi.fn(() => 7);
    vi.stubGlobal('requestIdleCallback', request);
    vi.stubGlobal('cancelIdleCallback', cancel);

    const stop = scheduleIdleWork(() => undefined, 1500);
    expect(request).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 1500,
    });
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('falls back to setTimeout when idle callbacks are missing', () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const work = vi.fn();
    const stop = scheduleIdleWork(work);
    expect(work).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(work).toHaveBeenCalledTimes(1);
    stop();
  });
});
