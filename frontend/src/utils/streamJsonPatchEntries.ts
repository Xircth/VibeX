// streamJsonPatchEntries.ts - Tauri Events JSON patch streaming utility
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/utils/jsonPatch';
import { tauriInvoke, tauriListen } from '@/lib/tauri-api';

type PatchContainer<E = unknown> = { entries: E[] };

export interface StreamOptions<E = unknown> {
  initial?: PatchContainer<E>;
  /** called after each successful patch application */
  onEntries?: (entries: E[]) => void;
  onConnect?: () => void;
  onError?: (err: unknown) => void;
  /** called once when a "finished" event is received */
  onFinished?: (entries: E[]) => void;
}

interface StreamController<E = unknown> {
  /** Current entries array (immutable snapshot) */
  getEntries(): E[];
  /** Full { entries } snapshot */
  getSnapshot(): PatchContainer<E>;
  /** Best-effort connection state */
  isConnected(): boolean;
  /** Subscribe to updates; returns an unsubscribe function */
  onChange(cb: (entries: E[]) => void): () => void;
  /** Close the stream */
  close(): void;
}

export interface TauriStreamParams {
  /** The execution process ID to subscribe to */
  executionProcessId: string;
  /** Whether to use normalized logs (true) or raw logs (false). Defaults to true. */
  normalized?: boolean;
}

/**
 * Subscribe to a Tauri event stream for an execution process.
 * The Rust backend emits events to "conversation-stream:{execution_process_id}" containing:
 *   {"JsonPatch": [{"op": "add", "path": "/entries/0", "value": {...}}, ...]}
 *   {"finished": true}
 *
 * Maintains an in-memory { entries: [] } snapshot and returns a controller.
 */
export function streamJsonPatchEntries<E = unknown>(
  params: TauriStreamParams,
  opts: StreamOptions<E> = {}
): StreamController<E> {
  let connected = false;
  let closed = false;
  let snapshot: PatchContainer<E> = structuredClone(
    opts.initial ?? ({ entries: [] } as PatchContainer<E>)
  );

  const subscribers = new Set<(entries: E[]) => void>();
  if (opts.onEntries) subscribers.add(opts.onEntries);

  // Will hold the unlisten function once the listener is set up
  let unlistenFn: (() => void) | null = null;

  const notify = () => {
    for (const cb of subscribers) {
      try {
        cb(snapshot.entries);
      } catch {
        /* swallow subscriber errors */
      }
    }
  };

  const handleMessage = (msg: unknown) => {
    if (closed) return;
    try {
      const data =
        typeof msg === 'object' && msg !== null
          ? (msg as Record<string, unknown>)
          : null;

      // Handle JsonPatch messages (from LogMsg::to_ws_message)
      if (data?.JsonPatch) {
        const raw = data.JsonPatch as Operation[];
        const ops = dedupeOps(raw);

        // Apply to a working copy (applyPatch mutates)
        const next = structuredClone(snapshot);
        applyUpsertPatch(next, ops);

        snapshot = next;
        notify();
      }

      // Handle Finished messages
      if (msg === 'Finished' || data?.finished !== undefined) {
        opts.onFinished?.(snapshot.entries);
      }
    } catch (err) {
      opts.onError?.(err);
    }
  };

  // Set up listener and invoke subscription
  const channel = `conversation-stream:${params.executionProcessId}`;

  // 1. First listen for events, then invoke the subscription command
  tauriListen<unknown>(channel, handleMessage)
    .then((unlisten) => {
      if (closed) {
        // If close() was called before listener was set up, immediately unlisten
        unlisten();
        return;
      }
      unlistenFn = unlisten;
      connected = true;
      opts.onConnect?.();

      // 2. Trigger Rust backend to start pushing events
      return tauriInvoke('subscribe_conversation_stream', {
        executionProcessId: params.executionProcessId,
        normalized:
          params.normalized !== undefined ? params.normalized : true,
      });
    })
    .catch((err) => {
      connected = false;
      opts.onError?.(err);
    });

  return {
    getEntries(): E[] {
      return snapshot.entries;
    },
    getSnapshot(): PatchContainer<E> {
      return snapshot;
    },
    isConnected(): boolean {
      return connected;
    },
    onChange(cb: (entries: E[]) => void): () => void {
      subscribers.add(cb);
      // push current state immediately
      cb(snapshot.entries);
      return () => subscribers.delete(cb);
    },
    close(): void {
      closed = true;
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
      }
      subscribers.clear();
      connected = false;
    },
  };
}

/**
 * Dedupe multiple ops that touch the same path within a single event.
 * Last write for a path wins, while preserving the overall left-to-right
 * order of the *kept* final operations.
 *
 * Example:
 *   add /entries/4, replace /entries/4  -> keep only the final replace
 */
function dedupeOps(ops: Operation[]): Operation[] {
  const lastIndexByPath = new Map<string, number>();
  ops.forEach((op, i) => lastIndexByPath.set(op.path, i));

  // Keep only the last op for each path, in ascending order of their final index
  const keptIndices = [...lastIndexByPath.values()].sort((a, b) => a - b);
  return keptIndices.map((i) => ops[i]!);
}
