import { describe, expect, it, vi } from 'vitest';
import {
  chromeHidesNativeSurface,
  nativeSurfaceDestinationProgress,
  parkNativeSurfaceThen,
} from './nativeSurfaceHandoff';

describe('chromeHidesNativeSurface', () => {
  it('parks the native page on kanban and plugin tabs', () => {
    expect(chromeHidesNativeSurface('kanban')).toBe(true);
    expect(chromeHidesNativeSurface('plugin:browser')).toBe(true);
    expect(chromeHidesNativeSurface('workspace')).toBe(false);
  });

  it('parks the native page while a tab context menu is open', () => {
    expect(chromeHidesNativeSurface('workspace', true)).toBe(true);
  });
});

describe('parkNativeSurfaceThen', () => {
  it('waits until the HWND is parked before committing the next chrome view', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const done = parkNativeSurfaceThen({
      park: true,
      occlude: () => order.push('occlude'),
      waitUntilParked: () => {
        order.push('wait');
        return parked;
      },
      commit: () => order.push('commit'),
    });

    await Promise.resolve();
    expect(order).toEqual(['occlude', 'wait']);
    release?.();
    await done;
    expect(order).toEqual(['occlude', 'wait', 'commit']);
  });

  it('commits immediately when the HWND may stay live', async () => {
    const occlude = vi.fn();
    const waitUntilParked = vi.fn(async () => undefined);
    const commit = vi.fn();
    await parkNativeSurfaceThen({
      park: false,
      occlude,
      waitUntilParked,
      commit,
    });
    expect(occlude).not.toHaveBeenCalled();
    expect(waitUntilParked).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('nativeSurfaceDestinationProgress', () => {
  it('ignores empty host rects until the destination slot is laid out', () => {
    expect(
      nativeSurfaceDestinationProgress({
        signature: '0:0:1:1',
        laidOut: false,
        previousSignature: '',
        matches: 2,
      })
    ).toEqual({
      previousSignature: '0:0:1:1',
      matches: 0,
      ready: false,
    });
  });

  it('does not reveal across a layout jump from a full-width slot to the split slot', () => {
    const first = nativeSurfaceDestinationProgress({
      signature: '40:80:1200:700',
      laidOut: true,
      previousSignature: '',
      matches: 0,
    });
    const second = nativeSurfaceDestinationProgress({
      signature: '40:80:1200:700',
      laidOut: true,
      previousSignature: first.previousSignature,
      matches: first.matches,
    });
    const split = nativeSurfaceDestinationProgress({
      signature: '40:80:800:700',
      laidOut: true,
      previousSignature: second.previousSignature,
      matches: second.matches,
    });
    expect(first.ready).toBe(false);
    expect(second.ready).toBe(false);
    expect(split).toEqual({
      previousSignature: '40:80:800:700',
      matches: 1,
      ready: false,
    });
  });

  it('reveals after three identical laid-out destination samples', () => {
    let state = { previousSignature: '', matches: 0, ready: false };
    for (let i = 0; i < 3; i += 1) {
      state = nativeSurfaceDestinationProgress({
        signature: '40:80:800:700',
        laidOut: true,
        previousSignature: state.previousSignature,
        matches: state.matches,
      });
    }
    expect(state.ready).toBe(true);
    expect(state.matches).toBe(3);
  });
});
