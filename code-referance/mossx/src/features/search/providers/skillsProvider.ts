import type { SkillOption } from "../../../types";
import type { SearchResult } from "../types";

export function searchSkills(
  query: string,
  skills: SkillOption[],
  workspaceId?: string | null,
): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const results: SearchResult[] = [];
  for (const skill of skills) {
    const name = skill.name.trim();
    if (!name) {
      continue;
    }
    const description = skill.description?.trim() ?? "";
    const searchText = `${name} ${description}`.toLowerCase();
    const index = searchText.indexOf(normalizedQuery);
    if (index < 0) {
      continue;
    }
    results.push({
      id: `skill:${workspaceId ?? "active"}:${name}`,
      kind: "skill",
      title: `/${name}`,
      subtitle: description || "Skill",
      score: index === 0 ? 35 : 210 + index,
      workspaceId: workspaceId ?? undefined,
      skillName: name,
      sourceKind: "skills",
      locationLabel: skill.path || name,
    });
  }
  return results;
}
