import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DebugEntry, WorkspaceInfo } from "../../../types";
import { getWorkspaceFiles } from "../../../services/tauri";

const WORKSPACE_FILES_DEBUG_KEY = "mossx.debug.workspace-files";
const WORKSPACE_FILES_SLOW_REQUEST_MS = 800;

function isWorkspaceFilesDebugEnabled() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(WORKSPACE_FILES_DEBUG_KEY) === "1";
}

type UseWorkspaceFilesOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onDebug?: (entry: DebugEntry) => void;
  pollingEnabled?: boolean;
};

export function useWorkspaceFiles({
  activeWorkspace,
  onDebug,
  pollingEnabled = true,
}: UseWorkspaceFilesOptions) {
  const [files, setFiles] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [gitignoredFiles, setGitignoredFiles] = useState<Set<string>>(new Set());
  const [gitignoredDirectories, setGitignoredDirectories] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedWorkspaceId = useRef<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const consecutiveFailures = useRef(0);

  const BASE_REFRESH_INTERVAL_MS = 30_000;
  const MAX_REFRESH_INTERVAL_MS = 180_000;
  const workspaceId = activeWorkspace?.id ?? null;
  const isConnected = Boolean(activeWorkspace?.connected);

  const refreshFiles = useCallback(async (reason: "initial" | "poll" | "manual" = "manual") => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (inFlight.current === workspaceId) {
      return;
    }
    inFlight.current = workspaceId;
    const requestWorkspaceId = workspaceId;
    const isFirstLoadForWorkspace = hasLoadedWorkspaceId.current !== workspaceId;
    if (reason !== "poll" || isFirstLoadForWorkspace) {
      setIsLoading(true);
    }
    const startedAt = Date.now();
    onDebug?.({
      id: `${startedAt}-client-files-list`,
      timestamp: startedAt,
      source: "client",
      label: "files/list",
      payload: { workspaceId: requestWorkspaceId, reason },
    });
    try {
      const response = await getWorkspaceFiles(requestWorkspaceId);
      const elapsedMs = Date.now() - startedAt;
      const nextFiles = Array.isArray(response.files) ? response.files : [];
      const nextDirectories = Array.isArray(response.directories) ? response.directories : [];
      const ignored = Array.isArray(response.gitignored_files) ? response.gitignored_files : [];
      const ignoredDirectories = Array.isArray(response.gitignored_directories)
        ? response.gitignored_directories
        : [];
      if (
        import.meta.env.DEV &&
        (elapsedMs >= WORKSPACE_FILES_SLOW_REQUEST_MS ||
        isWorkspaceFilesDebugEnabled())
      ) {
        console.info("[workspace-files]", {
          workspaceId: requestWorkspaceId,
          reason,
          ms: elapsedMs,
          files: nextFiles.length,
          directories: nextDirectories.length,
          gitignoredFiles: ignored.length,
          gitignoredDirectories: ignoredDirectories.length,
        });
      }
      onDebug?.({
        id: `${Date.now()}-server-files-list`,
        timestamp: Date.now(),
        source: "server",
        label: "files/list response",
        payload: {
          workspaceId: requestWorkspaceId,
          reason,
          ms: elapsedMs,
          files: nextFiles.length,
          directories: nextDirectories.length,
          gitignoredFiles: ignored.length,
          gitignoredDirectories: ignoredDirectories.length,
        },
      });
      if (requestWorkspaceId === workspaceId) {
        setFiles(nextFiles);
        setDirectories(nextDirectories);
        setGitignoredFiles(new Set(ignored));
        setGitignoredDirectories(new Set(ignoredDirectories));
        hasLoadedWorkspaceId.current = requestWorkspaceId;
        consecutiveFailures.current = 0;
      }
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      consecutiveFailures.current += 1;
      if (requestWorkspaceId === workspaceId) {
        hasLoadedWorkspaceId.current = requestWorkspaceId;
      }
      if (import.meta.env.DEV && isWorkspaceFilesDebugEnabled()) {
        console.warn("[workspace-files] refresh failed", {
          workspaceId: requestWorkspaceId,
          reason,
          ms: elapsedMs,
          failureCount: consecutiveFailures.current,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      onDebug?.({
        id: `${Date.now()}-client-files-list-error`,
        timestamp: Date.now(),
        source: "error",
        label: "files/list error",
        payload: {
          workspaceId: requestWorkspaceId,
          reason,
          ms: elapsedMs,
          failureCount: consecutiveFailures.current,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      if (inFlight.current === requestWorkspaceId) {
        inFlight.current = null;
        setIsLoading(false);
      }
    }
  }, [isConnected, onDebug, workspaceId]);

  useEffect(() => {
    setFiles([]);
    setDirectories([]);
    setGitignoredFiles(new Set());
    setGitignoredDirectories(new Set());
    hasLoadedWorkspaceId.current = null;
    inFlight.current = null;
    consecutiveFailures.current = 0;
    setIsLoading(Boolean(workspaceId && isConnected));
  }, [isConnected, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !isConnected) {
      return;
    }
    const needsRefresh = hasLoadedWorkspaceId.current !== workspaceId;
    if (!needsRefresh) {
      return;
    }
    void refreshFiles("initial");
  }, [isConnected, refreshFiles, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !isConnected || !pollingEnabled) {
      return;
    }

    let cancelled = false;
    let timeoutId = 0;
    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      const backoffMultiplier = Math.max(1, 2 ** consecutiveFailures.current);
      const intervalMs = Math.min(
        MAX_REFRESH_INTERVAL_MS,
        BASE_REFRESH_INTERVAL_MS * backoffMultiplier,
      );
      timeoutId = window.setTimeout(() => {
        void refreshFiles("poll").finally(() => {
          scheduleNext();
        });
      }, intervalMs);
    };
    scheduleNext();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isConnected, pollingEnabled, refreshFiles, workspaceId]);

  const fileOptions = useMemo(() => files.filter(Boolean), [files]);
  const directoryOptions = useMemo(() => directories.filter(Boolean), [directories]);

  return {
    files: fileOptions,
    directories: directoryOptions,
    gitignoredFiles,
    gitignoredDirectories,
    isLoading,
    refreshFiles,
  };
}
