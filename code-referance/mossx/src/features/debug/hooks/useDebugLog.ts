import { useCallback, useRef, useState } from "react";
import type { DebugEntry } from "../../../types";
import {
  getClientStoreSync,
  writeClientStoreValue,
} from "../../../services/clientStorage";

const MAX_DEBUG_ENTRIES = 200;
const THREAD_SESSION_LOG_KEY = "diagnostics.threadSessionLog";
const MAX_THREAD_SESSION_LOG_ENTRIES = 400;

type ThreadSessionLogEntry = {
  timestamp: number;
  source: string;
  label: string;
  payload: unknown;
};

function normalizePayload(payload: unknown): unknown {
  if (payload == null) {
    return payload;
  }
  if (typeof payload === "string") {
    return payload.length > 2000 ? `${payload.slice(0, 2000)}...(truncated)` : payload;
  }
  if (typeof payload !== "object") {
    return payload;
  }
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return String(payload);
  }
}

function shouldMirrorThreadSessionLog(entry: DebugEntry): boolean {
  const label = entry.label.toLowerCase();
  return (
    label.startsWith("thread/session:") ||
    label.startsWith("reasoning/raw:") ||
    label === "item/started" ||
    label === "item/updated" ||
    label === "item/completed"
  );
}

export function useDebugLog() {
  const [debugOpen, setDebugOpenState] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [hasDebugAlerts, setHasDebugAlerts] = useState(false);
  const [debugPinned, setDebugPinned] = useState(false);
  const debugEntryIdCounterRef = useRef(0);
  const threadSessionLogCacheRef = useRef<ThreadSessionLogEntry[] | null>(null);

  const shouldLogEntry = useCallback((entry: DebugEntry) => {
    if (entry.source === "error" || entry.source === "stderr") {
      return true;
    }
    const label = entry.label.toLowerCase();
    if (label.startsWith("thread/title")) {
      return true;
    }
    if (label.startsWith("thread/session:")) {
      return true;
    }
    if (label.startsWith("reasoning/raw:")) {
      return true;
    }
    if (label.includes("turn/start")) {
      return true;
    }
    if (label.includes("warn") || label.includes("warning")) {
      return true;
    }
    if (typeof entry.payload === "string") {
      const payload = entry.payload.toLowerCase();
      return payload.includes("warn") || payload.includes("warning");
    }
    return false;
  }, []);

  const addDebugEntry = useCallback(
    (entry: DebugEntry) => {
      if (shouldMirrorThreadSessionLog(entry)) {
        const cachedLogs =
          threadSessionLogCacheRef.current ??
          (getClientStoreSync<ThreadSessionLogEntry[]>("app", THREAD_SESSION_LOG_KEY) ?? []);
        const nextEntry: ThreadSessionLogEntry = {
          timestamp: entry.timestamp,
          source: entry.source,
          label: entry.label,
          payload: normalizePayload(entry.payload),
        };
        const nextLogs = [...cachedLogs, nextEntry].slice(
          -MAX_THREAD_SESSION_LOG_ENTRIES,
        );
        threadSessionLogCacheRef.current = nextLogs;
        writeClientStoreValue("app", THREAD_SESSION_LOG_KEY, nextLogs);
      }

      if (!shouldLogEntry(entry)) {
        return;
      }
      setHasDebugAlerts(true);
      setDebugEntries((prev) => {
        const trimmedId = entry.id.trim();
        const baseId =
          trimmedId.length > 0
            ? trimmedId
            : `debug-${entry.timestamp}-${debugEntryIdCounterRef.current++}`;

        let resolvedId = baseId;
        while (prev.some((existing) => existing.id === resolvedId)) {
          resolvedId = `${baseId}-${debugEntryIdCounterRef.current++}`;
        }

        const nextEntry =
          resolvedId === entry.id ? entry : { ...entry, id: resolvedId };

        return [...prev, nextEntry].slice(-MAX_DEBUG_ENTRIES);
      });
    },
    [shouldLogEntry],
  );

  const handleCopyDebug = useCallback(async () => {
    const text = debugEntries
      .map((entry) => {
        const timestamp = new Date(entry.timestamp).toLocaleTimeString();
        const payload =
          entry.payload !== undefined
            ? typeof entry.payload === "string"
              ? entry.payload
              : JSON.stringify(entry.payload, null, 2)
            : "";
        return [entry.source.toUpperCase(), timestamp, entry.label, payload]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  }, [debugEntries]);

  const clearDebugEntries = useCallback(() => {
    setDebugEntries([]);
    setHasDebugAlerts(false);
  }, []);

  const setDebugOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setDebugOpenState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (resolved) {
          setDebugPinned(true);
        }
        return resolved;
      });
    },
    [],
  );

  const showDebugButton = debugOpen || debugPinned;

  return {
    debugOpen,
    setDebugOpen,
    debugEntries,
    hasDebugAlerts,
    showDebugButton,
    addDebugEntry,
    handleCopyDebug,
    clearDebugEntries,
  };
}
