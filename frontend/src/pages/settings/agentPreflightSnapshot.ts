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
