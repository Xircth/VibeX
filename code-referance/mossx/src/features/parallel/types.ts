export type ParallelPanelStatus = "idle" | "queued" | "running" | "success" | "error";

export type ParallelPanelState = {
  panelId: string;
  skillName: string;
  extraInput: string;
  status: ParallelPanelStatus;
  threadId: string | null;
  resultSummary?: string;
  errorMessage?: string;
};

export type ParallelWorkspaceState = {
  workspaceRunId: string;
  question: string;
  inheritedCommonsNames: string[];
  panels: ParallelPanelState[];
  createdAt: number;
  updatedAt: number;
};

export type CreateParallelWorkspaceInput = {
  question: string;
  skillNames: string[];
  inheritedCommonsNames: string[];
};
