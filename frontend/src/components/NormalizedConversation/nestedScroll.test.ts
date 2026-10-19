import { describe, expect, it, vi } from 'vitest';
import {
  bindNestedWheel,
  nestedWheelResult,
  wheelDeltaPixels,
  type ScrollMetrics,
} from './nestedScroll';

function layer(
  partial: Partial<ScrollMetrics> &
    Pick<ScrollMetrics, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
): ScrollMetrics {
  return partial;
}

describe('nestedWheelResult', () => {
  it('leaves a locked or non-overflowing inner pane to native bubbling', () => {
    expect(
      nestedWheelResult(
        [
          layer({
            locked: true,
            scrollTop: 40,
            clientHeight: 80,
            scrollHeight: 400,
          }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        24
      )
    ).toEqual({ kind: 'native' });
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 0, clientHeight: 120, scrollHeight: 80 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        32
      )
    ).toEqual({ kind: 'native' });
  });

  it('keeps an overflowing inner pane until the wheel hits an edge', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 40, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        24
      )
    ).toEqual({ kind: 'inner' });
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        24
      )
    ).toEqual({ kind: 'inner' });
  });

  it('forwards an overflowing inner edge to the next layer that can move', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        24
      )
    ).toEqual({ kind: 'forward', index: 1 });
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        24
      )
    ).toEqual({ kind: 'forward', index: 2 });
  });

  it('does not intercept when no ancestor can consume the wheel', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
        ],
        24
      )
    ).toEqual({ kind: 'native' });
  });
});

describe('wheelDeltaPixels', () => {
  it('keeps pixel deltas and converts line/page modes', () => {
    expect(wheelDeltaPixels({ deltaY: 48, deltaMode: 0 })).toBe(48);
    expect(wheelDeltaPixels({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelDeltaPixels({ deltaY: 1, deltaMode: 2 })).toBe(800);
  });
});

describe('bindNestedWheel', () => {
  it('registers a passive listener so short panes keep compositor scrolling', () => {
    const node = document.createElement('div');
    node.setAttribute('data-nested-scroll', '');
    const add = vi.spyOn(node, 'addEventListener');
    const unbind = bindNestedWheel(node);
    expect(add).toHaveBeenCalledWith('wheel', expect.any(Function), {
      passive: true,
    });
    unbind();
    add.mockRestore();
  });
});
