import type {
  AgentId,
  AgentPreflightItemView,
  AgentPreflightView,
} from 'shared/types';

const BOOTSTRAP_DEPENDENCY_IDS = new Set([
  'dependency.node',
  'dependency.npm',
  'dependency.uv',
]);

function storageKey(agentId: AgentId): string {
  return `vibex:agent-preflight:${agentId}`;
}

export function readPreflightSnapshot(
  agentId: AgentId
): AgentPreflightView | null {
  try {
    const raw = localStorage.getItem(storageKey(agentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentPreflightView;
    if (parsed.agent_id !== agentId || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePreflightSnapshot(view: AgentPreflightView): void {
  localStorage.setItem(storageKey(view.agent_id), JSON.stringify(view));
}

export function presentPreflightItems(
  items: AgentPreflightItemView[]
): AgentPreflightItemView[] {
  return items
    .filter((item) => item.id !== 'runtime')
    .map((item) =>
      BOOTSTRAP_DEPENDENCY_IDS.has(item.id) && item.status === 'fail'
        ? { ...item, status: 'warning' }
        : item
    );
}

export function isAuthPreflightItem(item: AgentPreflightItemView): boolean {
  return item.id === 'authentication' || item.id.startsWith('auth.');
}

export function mergePreflightItems(
  current: AgentPreflightView,
  next: AgentPreflightView
): AgentPreflightView {
  const replacements = new Map(next.items.map((item) => [item.id, item]));
  const items = current.items.map((item) => replacements.get(item.id) ?? item);
  for (const item of next.items) {
    if (items.some((existing) => existing.id === item.id)) continue;
    items.push(item);
  }
  return {
    ...current,
    checked_at: next.checked_at,
    items,
  };
}

export function overlayAuthPreflightItems(
  base: AgentPreflightView,
  overlay: AgentPreflightView
): AgentPreflightView {
  const authItems = overlay.items.filter(isAuthPreflightItem);
  if (authItems.length === 0) return base;
  return mergePreflightItems(base, { ...overlay, items: authItems });
}
