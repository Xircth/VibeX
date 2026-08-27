import type { AgentId, AgentPreflightView } from 'shared/types';

export const AGENT_PREFLIGHT_IDLE_DELAY_MS = 5000;

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
