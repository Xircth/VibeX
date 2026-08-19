export function scheduleIdleWork(
  work: () => void,
  timeoutMs = 2000
): () => void {
  if (typeof window === 'undefined') {
    work();
    return () => undefined;
  }

  const requestIdle = window.requestIdleCallback;
  if (typeof requestIdle === 'function') {
    const id = requestIdle(() => work(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }

  const timer = window.setTimeout(work, 1);
  return () => window.clearTimeout(timer);
}
