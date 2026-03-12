import type { EngineType } from "../../types";

export type KanbanTaskStatus =
  | "todo"
  | "inprogress"
  | "testing"
  | "done";

export type KanbanColumnDef = {
  id: KanbanTaskStatus;
  labelKey: string;
  color: string;
};

export type KanbanPanel = {
  id: string;
  workspaceId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type KanbanTask = {
  id: string;
  workspaceId: string;
  panelId: string;
  title: string;
  description: string;
  status: KanbanTaskStatus;
  engineType: EngineType;
  modelId: string | null;
  branchName: string;
  images: string[];
  autoStart: boolean;
  sortOrder: number;
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type KanbanViewState =
  | { view: "projects" }
  | { view: "panels"; workspaceId: string }
  | { view: "board"; workspaceId: string; panelId: string };

export type KanbanStoreData = {
  panels: KanbanPanel[];
  tasks: KanbanTask[];
};
