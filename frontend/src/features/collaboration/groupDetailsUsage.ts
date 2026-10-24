export type MemberUsageModelGroup = {
  key: string;
  label: string | null;
  tokens: number;
};

export type MemberUsageSnapshot = {
  memberKey: string;
  agentId: string | null;
  totalTokens: number | null;
  byModel: MemberUsageModelGroup[];
};

export function uniqueAgentIds(
  snapshots: readonly MemberUsageSnapshot[]
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const id = snapshot.agentId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function aggregateTokenOverview(
  snapshots: readonly MemberUsageSnapshot[]
): {
  totalTokens: number | null;
  byModel: MemberUsageModelGroup[];
} {
  let totalTokens: number | null = null;
  const groups = new Map<string, MemberUsageModelGroup>();
  for (const snapshot of snapshots) {
    if (snapshot.totalTokens != null) {
      totalTokens = (totalTokens ?? 0) + snapshot.totalTokens;
    }
    for (const group of snapshot.byModel) {
      const current = groups.get(group.key) ?? {
        key: group.key,
        label: group.label,
        tokens: 0,
      };
      current.tokens += group.tokens;
      if (!current.label && group.label) current.label = group.label;
      groups.set(group.key, current);
    }
  }
  return {
    totalTokens,
    byModel: [...groups.values()].sort(
      (left, right) => right.tokens - left.tokens
    ),
  };
}
