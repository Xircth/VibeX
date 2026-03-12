import type { ThreadSummary } from "../../../types";
import type { SearchResult } from "../types";

export function searchThreads(
  query: string,
  threads: ThreadSummary[],
  workspaceId: string,
): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const thread of threads) {
    const index = thread.name.toLowerCase().indexOf(normalizedQuery);
    if (index < 0) {
      continue;
    }
    results.push({
      id: `thread:${workspaceId}:${thread.id}`,
      kind: "thread",
      title: thread.name,
      subtitle: "Thread",
      score: index === 0 ? 15 : 160 + index,
      workspaceId,
      threadId: thread.id,
      sourceKind: "threads",
      locationLabel: thread.id,
      updatedAt: thread.updatedAt,
    });
  }
  return results;
}
