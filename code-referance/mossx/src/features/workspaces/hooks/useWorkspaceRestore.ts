import { useEffect, useRef } from "react";
import type { WorkspaceInfo } from "../../../types";

type WorkspaceRestoreOptions = {
  workspaces: WorkspaceInfo[];
  hasLoaded: boolean;
  activeWorkspaceId: string | null;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  listThreadsForWorkspace: (
    workspace: WorkspaceInfo,
    options?: { preserveState?: boolean },
  ) => Promise<void>;
};

export function useWorkspaceRestore({
  workspaces,
  hasLoaded,
  activeWorkspaceId,
  connectWorkspace,
  listThreadsForWorkspace,
}: WorkspaceRestoreOptions) {
  const restoredWorkspaces = useRef(new Set<string>());

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }
    const pending = workspaces.filter((workspace) => {
      if (restoredWorkspaces.current.has(workspace.id)) {
        return false;
      }
      if (workspace.id === activeWorkspaceId) {
        return true;
      }
      return !workspace.settings.sidebarCollapsed;
    });
    if (pending.length === 0) {
      return;
    }
    pending.forEach((workspace) => {
      restoredWorkspaces.current.add(workspace.id);
    });
    const active = pending.find((w) => w.id === activeWorkspaceId);
    const rest = pending.filter((w) => w.id !== activeWorkspaceId);
    let cancelled = false;
    const restoreOne = async (workspace: WorkspaceInfo) => {
      if (cancelled) {
        return;
      }
      if (!workspace.connected) {
        await connectWorkspace(workspace);
      }
      await listThreadsForWorkspace(workspace);
    };
    void (async () => {
      try {
        if (active) {
          await restoreOne(active);
        }
        await Promise.allSettled(rest.map((w) => restoreOne(w).catch(() => {})));
      } catch {
        // Silent: connection errors show in debug panel.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    connectWorkspace,
    hasLoaded,
    listThreadsForWorkspace,
    workspaces,
  ]);
}
