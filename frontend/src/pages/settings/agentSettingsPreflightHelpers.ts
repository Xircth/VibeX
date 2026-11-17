import type {
  AgentAuthenticationStatus,
  AgentManagementView,
  AgentPreflightItemView,
  AgentPreflightView,
  AgentUpdateCheckView,
} from 'shared/types';

import { readCachedAgentAcpUpdate } from '@/features/agent-management/agentAcpUpdates';
import { agentHasAcpUpdate } from '@/features/agent-management/agentVersion';

import {
  isNativeEngineAgent,
  isPrimaryRuntimePreflightItem,
} from './agentProvisioning';

export function accountSessionMatchesAction(
  actionId: string,
  authentication: AgentAuthenticationStatus | null | undefined
): boolean {
  const signedIn =
    authentication === 'account' || authentication === 'multiple_unknown';
  if (actionId === 'logout') return !signedIn;
  if (actionId === 'login') return signedIn;
  return true;
}

export function applyCachedUpdateToPreflight(
  current: AgentPreflightView,
  cachedUpdate: ReturnType<typeof readCachedAgentAcpUpdate>,
  comparison: AgentUpdateCheckView | null
): AgentPreflightView {
  if (comparison) {
    return applyUpdateCheckToPreflight(current, comparison);
  }
  if (!cachedUpdate?.available) {
    return current;
  }
  return {
    ...current,
    items: current.items.map((item) => {
      if (
        isPrimaryRuntimePreflightItem(item, current.agent_id) &&
        item.status !== 'fail'
      ) {
        if (
          cachedUpdate.currentVersion &&
          item.version &&
          cachedUpdate.currentVersion !== item.version
        ) {
          return item;
        }
        return {
          ...item,
          update_available: true,
          available_version:
            item.available_version ?? cachedUpdate.availableVersion ?? null,
          update_group: null,
        };
      }
      return item;
    }),
  };
}

export function applyUpdateCheckToPreflight(
  current: AgentPreflightView,
  check: AgentUpdateCheckView
): AgentPreflightView {
  const nativeEngine = isNativeEngineAgent(current.agent_id);
  return {
    ...current,
    items: current.items.map((item) => {
      if (isPrimaryRuntimePreflightItem(item, current.agent_id)) {
        const hasUpdate = agentHasAcpUpdate(check, item.version);
        const latestAvailable =
          check.acp_available ??
          (nativeEngine ? check.runtime_available : null) ??
          check.available_version ??
          null;
        return {
          ...item,
          update_available: hasUpdate,
          available_version: hasUpdate ? latestAvailable : null,
          update_group: null,
        };
      }
      return item;
    }),
  };
}

export function applyInstallationToPreflight(
  current: AgentPreflightView | null,
  agent: AgentManagementView
): AgentPreflightView {
  const nativeEngine = isNativeEngineAgent(agent);
  const items = [...(current?.items ?? [])].filter(
    (item) => item.id !== 'runtime'
  );
  const effectiveVersion = nativeEngine
    ? (agent.runtime_version ??
      agent.acp_version ??
      agent.local_runtime?.version ??
      null)
    : agent.acp_version;
  const defaultLabel = nativeEngine ? '原生引擎运行时' : 'ACP 适配器';
  const index = items.findIndex((item) =>
    isPrimaryRuntimePreflightItem(item, agent)
  );
  const previous = index >= 0 ? items[index] : null;
  const resolvedVersion = effectiveVersion ?? previous?.version ?? null;
  const resolvedPath =
    previous?.path ??
    (nativeEngine ? (agent.local_runtime?.path ?? null) : null);
  const available =
    Boolean(resolvedVersion || resolvedPath) || previous?.status === 'pass';
  const normalizedLabel =
    nativeEngine && (!previous?.label || previous.label === 'ACP 适配器')
      ? defaultLabel
      : (previous?.label ?? defaultLabel);
  const next: AgentPreflightItemView = {
    id: previous?.id ?? 'acp',
    label: normalizedLabel,
    status: available ? 'pass' : (previous?.status ?? 'fail'),
    detail: available ? '' : (previous?.detail ?? ''),
    version: resolvedVersion,
    path: resolvedPath,
    source: previous?.source ?? (resolvedPath ? 'system' : null),
    repairable: !available,
    update_available: false,
    available_version: null,
    update_group: previous?.update_group ?? null,
  };
  if (index >= 0) {
    items[index] = { ...previous, ...next };
  } else {
    items.push(next);
  }
  return {
    agent_id: agent.agent_id,
    checked_at: new Date().toISOString(),
    items,
  };
}

export function isConfigConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'config_conflict'
  );
}
