import { useEffect, useState, useRef } from 'react';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/utils/jsonPatch';
import { tauriInvoke, tauriListen } from '@/lib/tauri-api';

// ------------------------------------------------------------------
// Tauri event payload types
//
// Rust `LogMsg` enum is serialised by serde with default (externally tagged)
// representation.  Unit variants become plain strings, newtype variants
// become `{ "VariantName": <inner> }`.
//
//   LogMsg::JsonPatch(ops) → { "JsonPatch": [...] }
//   LogMsg::Ready          → "Ready"
//   LogMsg::Finished       → "Finished"
//   LogMsg::Stdout(s)      → { "Stdout": "..." }
//   LogMsg::Stderr(s)      → { "Stderr": "..." }
// ------------------------------------------------------------------

type TauriLogMsg =
  | { JsonPatch: Operation[] }
  | 'Ready'
  | 'Finished'
  | { Stdout: string }
  | { Stderr: string }
  | { SessionId: string }
  | { MessageId: string };

// ---- public API ---------------------------------------------------

export interface TauriPatchStreamOptions<T> {
  /** Tauri command name to invoke (e.g. 'subscribe_diff_stream') */
  subscribeCommand: string;
  /** Arguments forwarded to the Tauri command */
  subscribeArgs?: Record<string, unknown>;
  /** Tauri event channel to listen on (e.g. 'diff-stream:{id}') */
  eventChannel: string;
  /** Factory that returns the initial (empty) data shape */
  initialData: () => T;
  /** Whether the stream should be active. Defaults to true. */
  enabled?: boolean;
  /** Filter / deduplicate patches before applying them */
  deduplicatePatches?: (patches: Operation[]) => Operation[];
  /** Inject initial data once when stream starts */
  injectInitialEntry?: (data: T) => void;
}

export interface TauriPatchStreamResult<T> {
  data: T | undefined;
  isConnected: boolean;
  isInitialized: boolean;
  error: string | null;
}

/**
 * Core hook that replaces `useJsonPatchWsStream`.
 *
 * Instead of opening a WebSocket it:
 *  1. Calls a Tauri command that spawns a background stream on the Rust side.
 *  2. Listens to a Tauri event channel for `LogMsg` payloads.
 *  3. Applies incoming JSON-Patch operations via immer + `applyUpsertPatch`.
 */
export const useTauriPatchStream = <T extends object>(
  options: TauriPatchStreamOptions<T>
): TauriPatchStreamResult<T> => {
  const {
    subscribeCommand,
    subscribeArgs,
    eventChannel,
    initialData,
    enabled = true,
    deduplicatePatches,
    injectInitialEntry,
  } = options;

  const [data, setData] = useState<T | undefined>(undefined);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<T | undefined>(undefined);
  const finishedRef = useRef<boolean>(false);

  // Serialise subscribeArgs to a stable string so we can safely depend on it
  // without causing infinite re-renders when the caller creates a new object
  // literal each render.
  const argsKey = subscribeArgs ? JSON.stringify(subscribeArgs) : '';

  useEffect(() => {
    if (!enabled) {
      // Reset everything when disabled
      setData(undefined);
      setIsConnected(false);
      setIsInitialized(false);
      setError(null);
      dataRef.current = undefined;
      finishedRef.current = false;
      return;
    }

    // Initialise data
    const init = initialData();
    if (injectInitialEntry) {
      injectInitialEntry(init);
    }
    dataRef.current = init;
    finishedRef.current = false;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        // 1. Start listening BEFORE invoking the command so we don't miss
        //    any events emitted immediately after the subscribe call.
        unlisten = await tauriListen<TauriLogMsg>(eventChannel, (msg) => {
          if (cancelled || finishedRef.current) return;

          try {
            // Handle JsonPatch
            if (typeof msg === 'object' && msg !== null && 'JsonPatch' in msg) {
              const patches: Operation[] = msg.JsonPatch;
              const filtered = deduplicatePatches
                ? deduplicatePatches(patches)
                : patches;

              const current = dataRef.current;
              if (!filtered.length || !current) return;

              const next = structuredClone(current);
              applyUpsertPatch(next, filtered);

              dataRef.current = next;
              setData(next);
              return;
            }

            // Handle Ready
            if (msg === 'Ready') {
              setIsInitialized(true);
              return;
            }

            // Handle Finished
            if (msg === 'Finished') {
              finishedRef.current = true;
              setIsConnected(false);
              return;
            }
          } catch (err) {
            console.error('Failed to process Tauri event message:', err);
            setError('Failed to process stream update');
          }
        });

        if (cancelled) {
          unlisten?.();
          return;
        }

        // 2. Invoke the subscribe command to start the backend stream.
        const args = subscribeArgs
          ? JSON.parse(argsKey) as Record<string, unknown>
          : undefined;

        await tauriInvoke(subscribeCommand, args);

        if (!cancelled) {
          setIsConnected(true);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(
            `Failed to subscribe to ${subscribeCommand}:`,
            err
          );
          setError(
            err instanceof Error ? err.message : 'Failed to connect'
          );
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlisten?.();
      dataRef.current = undefined;
      finishedRef.current = false;
      setData(undefined);
      setIsInitialized(false);
      setIsConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    subscribeCommand,
    argsKey,
    eventChannel,
    enabled,
    initialData,
    injectInitialEntry,
    deduplicatePatches,
  ]);

  return { data, isConnected, isInitialized, error };
};
