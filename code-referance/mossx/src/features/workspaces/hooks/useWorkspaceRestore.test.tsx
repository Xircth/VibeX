// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../../types";
import { useWorkspaceRestore } from "./useWorkspaceRestore";

function createWorkspace(
  overrides: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "id">,
): WorkspaceInfo {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    path: overrides.path ?? `/tmp/${overrides.id}`,
    connected: overrides.connected ?? true,
    kind: overrides.kind ?? "main",
    parentId: overrides.parentId ?? null,
    worktree: overrides.worktree ?? null,
    settings: {
      sidebarCollapsed: false,
      ...(overrides.settings ?? {}),
    },
  };
}

describe("useWorkspaceRestore", () => {
  it("优先恢复当前工作区，并跳过非当前的折叠工作区", async () => {
    const activeWorkspace = createWorkspace({
      id: "ws-active",
      connected: false,
      settings: { sidebarCollapsed: true },
    });
    const visibleWorkspace = createWorkspace({ id: "ws-visible" });
    const collapsedWorkspace = createWorkspace({
      id: "ws-collapsed",
      settings: { sidebarCollapsed: true },
    });
    const connectWorkspace = vi.fn().mockResolvedValue(undefined);
    const listThreadsForWorkspace = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useWorkspaceRestore({
        workspaces: [visibleWorkspace, collapsedWorkspace, activeWorkspace],
        hasLoaded: true,
        activeWorkspaceId: activeWorkspace.id,
        connectWorkspace,
        listThreadsForWorkspace,
      }),
    );

    await waitFor(() => {
      expect(listThreadsForWorkspace).toHaveBeenCalledTimes(2);
    });

    expect(connectWorkspace).toHaveBeenCalledTimes(1);
    expect(connectWorkspace).toHaveBeenCalledWith(activeWorkspace);
    expect(
      listThreadsForWorkspace.mock.calls.map((call) => call[0].id),
    ).toEqual(["ws-active", "ws-visible"]);
  });
});
