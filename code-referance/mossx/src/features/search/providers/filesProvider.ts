import type { SearchResult } from "../types";

export function searchFiles(query: string, files: string[], workspaceId: string): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const index = lower.indexOf(normalizedQuery);
    if (index < 0) {
      continue;
    }
    results.push({
      id: `file:${workspaceId}:${path}`,
      kind: "file",
      title: path,
      subtitle: "File",
      score: index === 0 ? 20 : 200 + index,
      workspaceId,
      filePath: path,
      sourceKind: "files",
      locationLabel: path,
    });
  }
  return results;
}
