import { useCallback, useState } from "react";
import type {
  CreateParallelWorkspaceInput,
  ParallelPanelState,
  ParallelPanelStatus,
  ParallelWorkspaceState,
} from "../types";

type UpdatePanelPatch = Partial<
  Pick<ParallelPanelState, "extraInput" | "status" | "threadId" | "resultSummary" | "errorMessage">
>;

function now() {
  return Date.now();
}

function buildPanelId(skillName: string) {
  return `${skillName}-${crypto.randomUUID()}`;
}

function createWorkspaceState(
  input: CreateParallelWorkspaceInput,
): ParallelWorkspaceState {
  const timestamp = now();
  return {
    workspaceRunId: crypto.randomUUID(),
    question: input.question,
    inheritedCommonsNames: input.inheritedCommonsNames,
    panels: input.skillNames.map((skillName) => ({
      panelId: buildPanelId(skillName),
      skillName,
      extraInput: "",
      status: "idle",
      threadId: null,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function patchPanel(
  workspace: ParallelWorkspaceState,
  panelId: string,
  patch: UpdatePanelPatch,
): ParallelWorkspaceState {
  return {
    ...workspace,
    updatedAt: now(),
    panels: workspace.panels.map((panel) => {
      if (panel.panelId !== panelId) {
        return panel;
      }
      return {
        ...panel,
        ...patch,
      };
    }),
  };
}

export function useParallelWorkspace() {
  const [workspace, setWorkspace] = useState<ParallelWorkspaceState | null>(null);

  const createWorkspace = useCallback((input: CreateParallelWorkspaceInput) => {
    const nextWorkspace = createWorkspaceState(input);
    setWorkspace(nextWorkspace);
    return nextWorkspace;
  }, []);

  const resetWorkspace = useCallback(() => {
    setWorkspace(null);
  }, []);

  const updatePanel = useCallback((panelId: string, patch: UpdatePanelPatch) => {
    setWorkspace((prev) => {
      if (!prev) {
        return prev;
      }
      return patchPanel(prev, panelId, patch);
    });
  }, []);

  const updatePanelStatus = useCallback(
    (panelId: string, status: ParallelPanelStatus, errorMessage?: string) => {
      updatePanel(panelId, {
        status,
        errorMessage,
      });
    },
    [updatePanel],
  );

  return {
    workspace,
    createWorkspace,
    resetWorkspace,
    updatePanel,
    updatePanelStatus,
  };
}
