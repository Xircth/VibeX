import type { KanbanColumnDef } from "./types";

export const KANBAN_COLUMNS: KanbanColumnDef[] = [
  { id: "todo", labelKey: "kanban.columns.todo", color: "#1a1a1a" },
  { id: "inprogress", labelKey: "kanban.columns.inprogress", color: "#3b82f6" },
  { id: "testing", labelKey: "kanban.columns.testing", color: "#f59e0b" },
  { id: "done", labelKey: "kanban.columns.done", color: "#22c55e" },
];

export const KANBAN_STORAGE_KEY = "mossx.kanban";
