import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCanvasReveal,
  peekCanvasReveal,
  requestCanvasReveal,
  resetCanvasRevealForTest,
  subscribeCanvasReveal,
} from '@/lib/canvasSessionReveal';

const TARGET = {
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
};

describe('canvasSessionReveal', () => {
  beforeEach(() => {
    resetCanvasRevealForTest();
  });

  afterEach(() => {
    resetCanvasRevealForTest();
    vi.restoreAllMocks();
  });

  it('delivers a pending reveal to a late subscriber', () => {
    requestCanvasReveal(TARGET);

    const listener = vi.fn();
    const unsubscribe = subscribeCanvasReveal(listener);

    expect(listener).toHaveBeenCalledWith(TARGET);

    unsubscribe();
  });

  it('notifies existing subscribers immediately on request', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCanvasReveal(listener);

    requestCanvasReveal(TARGET);

    expect(listener).toHaveBeenCalledWith(TARGET);

    unsubscribe();
  });

  it('clears the request once it has been applied', () => {
    const listener = vi.fn();
    subscribeCanvasReveal(listener);

    requestCanvasReveal(TARGET);
    clearCanvasReveal({ projectId: TARGET.projectId });

    expect(peekCanvasReveal()).toBeNull();

    // A late subscriber must not receive the already-applied request again.
    const lateListener = vi.fn();
    subscribeCanvasReveal(lateListener);
    expect(lateListener).not.toHaveBeenCalled();
  });

  it('keeps a request for another project queued', () => {
    const listener = vi.fn();
    subscribeCanvasReveal(listener);

    requestCanvasReveal(TARGET);
    clearCanvasReveal({ projectId: 'some-other-project' });

    expect(peekCanvasReveal()).toEqual(TARGET);
  });
});
