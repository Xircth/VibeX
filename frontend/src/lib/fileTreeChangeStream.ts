import { backendCall, backendListen } from '@/lib/backendTransport';

/** One `file-tree-stream` message, as the host emits it. */
export interface FileTreeChange {
  root_path: string;
  /** Root-relative, forward-slashed paths of files created in this batch. */
  added_paths?: string[] | null;
  /** Whether the host capped `added_paths` and dropped entries. */
  added_paths_truncated?: boolean | null;
}

export type FileTreeChangeHandler = (change: FileTreeChange) => void;

/** The root the host reports is the same directory, spelled differently. */
export function normalizeWatchedPath(path: string) {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

interface RootSubscription {
  handlers: Set<FileTreeChangeHandler>;
  dispose: () => void;
}

const subscriptions = new Map<string, RootSubscription>();

/**
 * Watch one workspace root for file tree changes, shared by every caller.
 *
 * The host streams one channel per root, so a second listener would duplicate
 * the transport work — and on a remote host, where each listener opens its own
 * pump, could deliver the same change twice. Callers subscribe here instead and
 * the underlying listener lives until the last of them unsubscribes.
 */
export function subscribeFileTreeChanges(
  rootPath: string,
  handler: FileTreeChangeHandler
): () => void {
  const key = normalizeWatchedPath(rootPath);
  const existing = subscriptions.get(key);

  if (existing) {
    existing.handlers.add(handler);
    return () => removeHandler(key, handler);
  }

  const handlers = new Set<FileTreeChangeHandler>([handler]);
  const subscription: RootSubscription = {
    handlers,
    dispose: () => undefined,
  };
  subscriptions.set(key, subscription);

  let cancelled = false;
  let unlisten: (() => void) | null = null;

  void backendCall('subscribe_file_tree_stream', { rootPath }).catch(
    (error) => {
      console.error('Failed to subscribe file tree stream:', error);
    }
  );

  void backendListen<FileTreeChange>('file-tree-stream', (payload) => {
    if (cancelled) {
      return;
    }

    if (normalizeWatchedPath(payload.root_path) !== key) {
      return;
    }

    for (const current of subscription.handlers) {
      current(payload);
    }
  })
    .then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    })
    .catch((error) => {
      console.error('Failed to listen for file tree updates:', error);
    });

  subscription.dispose = () => {
    cancelled = true;
    unlisten?.();
  };

  return () => removeHandler(key, handler);
}

function removeHandler(key: string, handler: FileTreeChangeHandler) {
  const subscription = subscriptions.get(key);
  if (!subscription || !subscription.handlers.delete(handler)) {
    return;
  }

  if (subscription.handlers.size === 0) {
    subscriptions.delete(key);
    subscription.dispose();
  }
}
