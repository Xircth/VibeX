/**
 * Ordered, single-flight write pump for terminal input.
 *
 * Terminal input must reach the PTY in exactly the order it was typed. The
 * transport underneath `write_terminal` gives no cross-call ordering
 * guarantee: concurrent invokes can complete out of order, and remote HTTP
 * posts are unordered. One fire-and-forget call per keystroke scrambles
 * fast input.
 *
 * At most one send is in flight; bytes typed meanwhile coalesce into the
 * next batch. A failed send is dropped, never retried — re-sending an
 * ambiguous batch can duplicate already-delivered control bytes (Enter,
 * Ctrl-C), which is worse in a shell than losing a burst.
 */

export interface WriteQueue {
  enqueue: (data: string) => void;
  dispose: () => void;
}

export function createWriteQueue(
  send: (data: string) => Promise<void>
): WriteQueue {
  let pending = '';
  let flushing = false;
  let stopped = false;

  async function flush(): Promise<void> {
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      while (!stopped && pending.length > 0) {
        const batch = pending;
        pending = '';
        try {
          await send(batch);
        } catch {
          if (stopped) {
            return;
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    enqueue(data: string): void {
      if (stopped || data.length === 0) {
        return;
      }
      pending += data;
      void flush();
    },
    dispose(): void {
      stopped = true;
      pending = '';
    },
  };
}
