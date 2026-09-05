/**
 * Module-level channel for requesting that a session card be revealed on the
 * Kanban infinite canvas. `PendingProjectFocusBridge` publishes a request; the
 * mounted canvas flow subscribes and applies it once its session data is ready.
 *
 * The pending target is not cleared on subscribe — it is only cleared by the
 * consumer that actually applies the reveal — so a request that arrives before
 * the canvas (or its session list) is ready is still honored when it mounts.
 */
export interface CanvasRevealTarget {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

type CanvasRevealListener = (target: CanvasRevealTarget) => void;

let pending: CanvasRevealTarget | null = null;
const listeners = new Set<CanvasRevealListener>();

export function requestCanvasReveal(target: CanvasRevealTarget): void {
  pending = target;
  for (const listener of [...listeners]) {
    listener(target);
  }
}

export function peekCanvasReveal(): CanvasRevealTarget | null {
  return pending;
}

/**
 * Forget a pending reveal for the given project. Only the matching project's
 * consumer may clear it, so requests for other projects stay queued.
 */
export function clearCanvasReveal(target: {
  projectId: string;
}): void {
  if (pending && pending.projectId === target.projectId) {
    pending = null;
  }
}

export function subscribeCanvasReveal(
  listener: CanvasRevealListener
): () => void {
  listeners.add(listener);
  if (pending) {
    listener(pending);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so module state does not leak between tests. */
export function resetCanvasRevealForTest(): void {
  pending = null;
  listeners.clear();
}
