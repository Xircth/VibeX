function trimToLength(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) {
    return text;
  }
  return `${chars.slice(0, maxLength).join("")}…`;
}

export function deriveKanbanTaskTitle(
  description: string,
  fallbackTitle: string,
): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallbackTitle;
  }

  const firstLine = normalized.split("\n").find((line) => line.trim().length > 0) ?? normalized;
  let candidate = firstLine.trim();

  // Drop common request prefixes for tighter titles.
  candidate = candidate.replace(/^(请|帮我|麻烦|帮忙|请你|能否|可以)\s*/u, "");

  // Prefer first clause when a sentence is long.
  const firstClause = candidate.split(/[，。！？!?.;；]/u)[0]?.trim() ?? "";
  if (firstClause.length >= 6) {
    candidate = firstClause;
  }

  candidate = trimToLength(candidate, 26);
  if (!candidate) {
    return fallbackTitle;
  }
  return candidate;
}
