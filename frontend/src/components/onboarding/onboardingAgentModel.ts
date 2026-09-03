import type {
  AgentId,
  AgentLifecycleState,
  AgentManagementView,
  AgentOperationStatus,
  AgentRegistryViewRow,
} from 'shared/types';

export type OnboardingAgentOption = {
  agentId: AgentId;
  displayName: string;
  description: string;
  iconLight: string | null;
  iconDark: string | null;
  iconSvg: string | null;
  recommended: boolean;
  builtIn: boolean;
  added: boolean;
  enabled: boolean;
  platformSupported: boolean;
  runtimeInstalled: boolean;
  lifecycle: AgentLifecycleState;
  needsInstallation: boolean;
};

const RECOMMENDED_AGENT_IDS: readonly AgentId[] = [
  'claude_code',
  'codex',
  'opencode',
  'pi',
];

const RECOMMENDED_AGENT_RANK = new Map(
  RECOMMENDED_AGENT_IDS.map((agentId, index) => [agentId, index] as const)
);

const COMPLETE_INSTALLATION_STATES = new Set<AgentLifecycleState>([
  'ready',
  'needs_auth',
  'needs_config',
]);

export function buildOnboardingAgentOptions(
  managedAgents: AgentManagementView[],
  registryAgents: AgentRegistryViewRow[]
): OnboardingAgentOption[] {
  const managedById = new Map(
    managedAgents.map((agent) => [agent.agent_id, agent] as const)
  );
  const registryById = new Map(
    registryAgents.map((agent) => [agent.agent_id, agent] as const)
  );
  const agentIds = new Set<AgentId>([
    ...managedById.keys(),
    ...registryById.keys(),
  ]);

  return [...agentIds]
    .map((agentId): OnboardingAgentOption => {
      const managed = managedById.get(agentId);
      const registry = registryById.get(agentId);
      const lifecycle = managed?.lifecycle ?? 'uninstalled';
      const sessionInstalled =
        Boolean(registry?.installed) ||
        COMPLETE_INSTALLATION_STATES.has(lifecycle);
      // Availability matches CodeG: the ACP launch command is present
      // (`acp_version` or a completed install). A vendor CLI alone is not.
      const runtimeInstalled = Boolean(
        managed?.acp_version || sessionInstalled
      );

      return {
        agentId,
        displayName: managed?.display_name ?? registry?.display_name ?? agentId,
        description: managed?.description ?? registry?.description ?? '',
        iconLight: managed?.icon_light ?? registry?.icon_light ?? null,
        iconDark: managed?.icon_dark ?? registry?.icon_dark ?? null,
        iconSvg: managed?.icon_svg ?? registry?.icon_svg ?? null,
        recommended: RECOMMENDED_AGENT_RANK.has(agentId),
        builtIn: managed?.built_in ?? registry?.built_in ?? false,
        added: Boolean(managed ?? registry?.added),
        enabled: managed?.enabled ?? false,
        platformSupported: registry?.platform_supported ?? true,
        runtimeInstalled,
        lifecycle,
        needsInstallation: !runtimeInstalled,
      };
    })
    .filter((agent) => agent.platformSupported)
    .sort((left, right) => {
      if (left.runtimeInstalled !== right.runtimeInstalled) {
        return left.runtimeInstalled ? -1 : 1;
      }
      const leftRecommendedRank =
        RECOMMENDED_AGENT_RANK.get(left.agentId) ?? Number.MAX_SAFE_INTEGER;
      const rightRecommendedRank =
        RECOMMENDED_AGENT_RANK.get(right.agentId) ?? Number.MAX_SAFE_INTEGER;
      if (leftRecommendedRank !== rightRecommendedRank) {
        return leftRecommendedRank - rightRecommendedRank;
      }
      if (left.builtIn !== right.builtIn) return left.builtIn ? -1 : 1;
      return left.displayName.localeCompare(right.displayName);
    });
}

export function normalizeOnboardingAgentSelection({
  enabledAgentIds,
  defaultAgentId,
  changedAgentId,
  enabled,
}: {
  enabledAgentIds: ReadonlySet<AgentId>;
  defaultAgentId: AgentId | null;
  changedAgentId: AgentId;
  enabled: boolean;
}): {
  enabledAgentIds: Set<AgentId>;
  defaultAgentId: AgentId | null;
} {
  const nextEnabled = new Set(enabledAgentIds);
  if (enabled) nextEnabled.add(changedAgentId);
  else nextEnabled.delete(changedAgentId);

  let nextDefault = defaultAgentId;
  if (enabled && defaultAgentId === changedAgentId) {
    nextDefault = changedAgentId;
  } else if (!enabled && defaultAgentId === changedAgentId) {
    nextDefault = nextEnabled.values().next().value ?? null;
  }

  return {
    enabledAgentIds: nextEnabled,
    defaultAgentId: nextDefault,
  };
}

export function selectDefaultOnboardingAgent(
  enabledAgentIds: ReadonlySet<AgentId>,
  agentId: AgentId
): { enabledAgentIds: Set<AgentId>; defaultAgentId: AgentId } {
  return {
    enabledAgentIds: new Set([...enabledAgentIds, agentId]),
    defaultAgentId: agentId,
  };
}

export type OnboardingInstallResult = 'verified' | 'needs_attention' | 'failed';

export function classifyOnboardingInstallResult(
  status: AgentOperationStatus,
  preflightStatuses: string[]
): OnboardingInstallResult {
  if (status !== 'succeeded') return 'failed';
  return preflightStatuses.some((item) => item === 'fail')
    ? 'needs_attention'
    : 'verified';
}
