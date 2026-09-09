import type { QueryClient } from '@tanstack/react-query';
import type {
  AgentSessionConfigOption,
  AgentSessionControlsSnapshot,
} from 'shared/types';

import { agentsApi } from './api';

export function sessionControlsQueryKey(
  agentType: string,
  workspaceId: string | null
) {
  return ['agent-session-controls-catalog', agentType, workspaceId] as const;
}

export function sessionControlsSchemaQueryKey(agentType: string) {
  return ['agent-session-controls-schema', agentType] as const;
}

export async function loadAgentSessionControlsCatalog(
  agentType: string
): Promise<AgentSessionControlsSnapshot> {
  const cached = await agentsApi.capabilityCatalog(agentType);
  if (cached) return cached;

  const refreshed = await agentsApi.refreshCapabilityCatalog(agentType);
  if (!refreshed) {
    throw new Error('Agent session controls discovery failed');
  }
  const discovered = await agentsApi.capabilityCatalog(agentType);
  if (!discovered) {
    throw new Error('Agent session controls catalog is unavailable');
  }
  return discovered;
}

/**
 * One create-form snapshot from catalog + live composer controls.
 * Earlier snapshots win on current values; later snapshots only add missing
 * option keys or richer choice lists so Kanban and Workspace show the same
 * fields (model, effort, fast mode) even when only one surface has a live
 * session.
 */
/**
 * Conversation-projected ACP controls, or null when this conversation has not
 * advertised any yet (a newly created session before the first turn).
 */
export function liveSessionControlsSnapshot(
  modes: {
    current: string | null;
    modes: AgentSessionControlsSnapshot['modes'];
  },
  configOptions: AgentSessionConfigOption[]
): AgentSessionControlsSnapshot | null {
  if (modes.modes.length === 0 && configOptions.length === 0) {
    return null;
  }
  return {
    modes: modes.modes,
    current_mode: modes.current,
    config_options: configOptions,
  };
}

/**
 * Composer display: live conversation controls first, then the same catalog
 * the create form already loaded so a new session still has a settings summary.
 */
export function composerSessionControlDisplay(
  snapshots: Array<AgentSessionControlsSnapshot | null | undefined>
): {
  sessionModes: {
    current: string | null;
    modes: AgentSessionControlsSnapshot['modes'];
  };
  sessionConfigOptions: AgentSessionConfigOption[];
} {
  const merged = mergeCreateSessionControls(snapshots);
  return {
    sessionModes: {
      current: merged?.current_mode ?? null,
      modes: merged?.modes ?? [],
    },
    sessionConfigOptions: merged?.config_options ?? [],
  };
}

export function mergeCreateSessionControls(
  snapshots: Array<AgentSessionControlsSnapshot | null | undefined>
): AgentSessionControlsSnapshot | null {
  const present = snapshots.filter(
    (snapshot): snapshot is AgentSessionControlsSnapshot => snapshot != null
  );
  if (present.length === 0) {
    return null;
  }

  const richestModes = present.reduce((best, next) =>
    next.modes.length > best.modes.length ? next : best
  );
  const optionsByKey = new Map<string, AgentSessionConfigOption>();
  for (const snapshot of present) {
    for (const option of snapshot.config_options) {
      const existing = optionsByKey.get(option.key);
      if (!existing) {
        optionsByKey.set(option.key, option);
        continue;
      }
      if ((option.choices ?? []).length <= (existing.choices ?? []).length) {
        continue;
      }
      optionsByKey.set(option.key, {
        ...option,
        value: existing.value ?? option.value,
      });
    }
  }

  return {
    ...present[0],
    modes: richestModes.modes,
    current_mode: present[0].current_mode ?? richestModes.current_mode,
    config_options: Array.from(optionsByKey.values()),
  };
}

/**
 * Share composer-advertised controls with every create surface for this Agent.
 * The workspace key keeps same-workspace values; the schema key is the
 * agent-wide option list so Kanban create can offer effort/fast mode after
 * any live session has advertised them.
 */
export function publishLiveSessionControls(
  queryClient: QueryClient,
  {
    agentType,
    workspaceId,
    controls,
  }: {
    agentType: string;
    workspaceId: string;
    controls: AgentSessionControlsSnapshot;
  }
): void {
  queryClient.setQueryData(
    sessionControlsQueryKey(agentType, workspaceId),
    controls
  );
  const schemaKey = sessionControlsSchemaQueryKey(agentType);
  queryClient.setQueryData(
    schemaKey,
    mergeCreateSessionControls([
      queryClient.getQueryData<AgentSessionControlsSnapshot>(schemaKey),
      controls,
    ])
  );
}
