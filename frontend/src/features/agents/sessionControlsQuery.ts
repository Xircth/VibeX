import type { QueryClient } from '@tanstack/react-query';
import type {
  AgentSessionConfigOption,
  AgentSessionControlsSnapshot,
} from 'shared/types';

import { agentsApi } from './api';

function normalizeAgentType(agentType: string | null | undefined): string {
  return typeof agentType === 'string' ? agentType.trim().toLowerCase() : '';
}

export function sessionControlsQueryKey(
  agentType: string | null | undefined,
  workspaceId: string | null
) {
  return [
    'agent-session-controls-catalog',
    normalizeAgentType(agentType),
    workspaceId,
  ] as const;
}

export function sessionControlsSchemaQueryKey(
  agentType: string | null | undefined
) {
  return [
    'agent-session-controls-schema',
    normalizeAgentType(agentType),
  ] as const;
}

export async function loadAgentSessionControlsCatalog(
  agentType: string | null | undefined
): Promise<AgentSessionControlsSnapshot> {
  const normalized = normalizeAgentType(agentType);
  if (!normalized) {
    throw new Error('Agent session controls catalog is unavailable');
  }
  const cached = await agentsApi.capabilityCatalog(normalized);
  if (cached) return cached;

  const refreshed = await agentsApi.refreshCapabilityCatalog(normalized);
  if (!refreshed) {
    throw new Error('Agent session controls discovery failed');
  }
  const discovered = await agentsApi.capabilityCatalog(normalized);
  if (!discovered) {
    throw new Error('Agent session controls catalog is unavailable');
  }
  return discovered;
}

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

function isThoughtLevelOption(option: AgentSessionConfigOption): boolean {
  return option.category === 'thought_level';
}

/**
 * One snapshot from controls ordered by authority. The first snapshot that
 * defines an option key owns its choices and value, and the first snapshot
 * with modes owns the mode list; later snapshots only add option keys the
 * earlier ones lack (for example effort or fast mode a catalog never saw).
 * A later snapshot never widens an earlier choice list, so a provider removed
 * from the Agent's config stops being offered once the authority drops it.
 */
export function mergeCreateSessionControls(
  snapshots: Array<AgentSessionControlsSnapshot | null | undefined>
): AgentSessionControlsSnapshot | null {
  const present = snapshots.filter(
    (snapshot): snapshot is AgentSessionControlsSnapshot => snapshot != null
  );
  if (present.length === 0) {
    return null;
  }

  const modesOwner =
    present.find((snapshot) => snapshot.modes.length > 0) ?? present[0];
  const optionsByKey = new Map<string, AgentSessionConfigOption>();
  for (const snapshot of present) {
    for (const option of snapshot.config_options) {
      if (optionsByKey.has(option.key)) continue;
      if (
        isThoughtLevelOption(option) &&
        [...optionsByKey.values()].some(isThoughtLevelOption)
      ) {
        continue;
      }
      optionsByKey.set(option.key, option);
    }
  }

  return {
    ...present[0],
    modes: modesOwner.modes,
    current_mode: modesOwner.current_mode ?? present[0].current_mode,
    config_options: Array.from(optionsByKey.values()),
  };
}

/**
 * Keep `preferred`'s current mode and option values wherever `controls` still
 * offers them, so a workspace's live picks survive without reviving choices
 * the authoritative controls no longer advertise.
 */
export function preferSessionControlValues(
  controls: AgentSessionControlsSnapshot | null,
  preferred: AgentSessionControlsSnapshot | null | undefined
): AgentSessionControlsSnapshot | null {
  if (!controls || !preferred) return controls;
  const preferredValues = new Map(
    preferred.config_options.map((option) => [option.key, option.value])
  );
  return {
    ...controls,
    current_mode: controls.modes.some(
      (mode) => mode.id === preferred.current_mode
    )
      ? preferred.current_mode
      : controls.current_mode,
    config_options: controls.config_options.map((option) => {
      const value = preferredValues.get(option.key);
      const offered =
 value !== undefined &&
        value !== null &&
        (option.choices ?? []).some((choice) => choice.value === value);
      return offered ? { ...option, value } : option;
    }),
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
      controls,
      queryClient.getQueryData<AgentSessionControlsSnapshot>(schemaKey),
    ])
  );
}
