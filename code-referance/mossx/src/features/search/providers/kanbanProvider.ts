import type { KanbanTask } from "../../kanban/types";
import type { SearchResult } from "../types";

export function searchKanbanTasks(query: string, tasks: KanbanTask[]): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const task of tasks) {
    const title = task.title.trim();
    const description = task.description.trim();
    const titleIndex = title.toLowerCase().indexOf(normalizedQuery);
    const descriptionIndex = description.toLowerCase().indexOf(normalizedQuery);
    if (titleIndex < 0 && descriptionIndex < 0) {
      continue;
    }
    const score = titleIndex >= 0
      ? (titleIndex === 0 ? 10 : 100 + titleIndex)
      : 300 + descriptionIndex;
    results.push({
      id: `kanban:${task.id}`,
      kind: "kanban",
      title: title || "(untitled task)",
      subtitle: description || "Kanban Task",
      score,
      workspaceId: task.workspaceId,
      panelId: task.panelId,
      taskId: task.id,
      sourceKind: "kanban",
      locationLabel: task.panelId || task.id,
    });
  }
  return results;
}
