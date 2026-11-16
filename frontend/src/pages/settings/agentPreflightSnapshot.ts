import type {
  AgentId,
  AgentPreflightItemView,
  AgentPreflightView,
} from 'shared/types';

import {
  isNativeEngineAgent,
  type NativeEngineAgentHint,
} from './agentProvisioning';

const BOOTSTRAP_DEPENDENCY_IDS = new Set([
  'dependency.node',
  'dependency.npm',
  'dependency.uv',
]);

function storageKey(agentId: AgentId): string {
  return `dimo:agent-preflight:${agentId}`;
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
  items: AgentPreflightItemView[],
  agentOrId?: NativeEngineAgentHint
): AgentPreflightItemView[] {
  const nativeEngine = isNativeEngineAgent(agentOrId);
  const hasPrimaryItem = items.some(
    (item) => item.id === 'acp' || item.id === 'native_runtime'
  );
  return items
    .filter(
      (item) =>
        item.id !== 'membership' &&
        (item.id !== 'runtime' || (nativeEngine && !hasPrimaryItem))
    )
    .map((item) => {
      let next =
        BOOTSTRAP_DEPENDENCY_IDS.has(item.id) && item.status === 'fail'
          ? { ...item, status: 'warning' as const }
          : item;
      const isPrimaryItem =
        next.id === 'acp' ||
        next.id === 'native_runtime' ||
        (nativeEngine && next.id === 'runtime');
      if (
        isPrimaryItem &&
        (next.label === 'ACP 适配器' || next.label === '原生引擎运行时')
      ) {
        next = { ...next, label: '运行入口' };
      }
      return next;
    });
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
