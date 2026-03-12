import type { CustomCommandOption } from "../../../types";
import type { SearchResult } from "../types";

export function searchCommands(query: string, commands: CustomCommandOption[]): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const results: SearchResult[] = [];
  for (const command of commands) {
    const name = command.name.trim();
    if (!name) {
      continue;
    }
    const description = command.description?.trim() ?? "";
    const argumentHint = command.argumentHint?.trim() ?? "";
    const searchText = `${name} ${description} ${argumentHint}`.toLowerCase();
    const index = searchText.indexOf(normalizedQuery);
    if (index < 0) {
      continue;
    }
    const subtitle = description || argumentHint || "Command";
    results.push({
      id: `command:${name}`,
      kind: "command",
      title: `/${name}`,
      subtitle,
      score: index === 0 ? 45 : 230 + index,
      commandName: name,
      sourceKind: "commands",
      locationLabel: command.path || name,
    });
  }
  return results;
}
