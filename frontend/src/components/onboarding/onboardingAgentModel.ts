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
      // Session launch still requires an ACP command (ADR-0010). First-run
      // selection treats a discovered vendor CLI as present so Windows users
      // who already installed `claude` / `codex` / `pi` are auto-enabled;
      // continuing setup still writes the ACP adapter when it is missing.
      const acpReady = Boolean(managed?.acp_version || sessionInstalled);
      const cliDetected = Boolean(managed?.local_runtime?.path);
      const desktopDetected = Boolean(managed?.desktop_client?.path);
      const runtimeInstalled = acpReady || cliDetected || desktopDetected;

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
        needsInstallation: !acpReady,
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

const RUNTIME_PREFLIGHT_IDS = new Set([
  'acp',
  'runtime',
  'node',
  'npm',
  'uv',
  'python',
  'archive',
  'membership',
]);

const LOGIN_FAILURE = /登录失败|login failed/i;

export type OnboardingPreflightItem = {
  id: string;
  status: string;
  label?: string;
  detail?: string;
  repairable?: boolean;
};

export type OnboardingPreflightGuidance =
  | { kind: 'pending' }
  | { kind: 'pass' }
  | { kind: 'runtime'; target: string; repairable: boolean }
  | { kind: 'login' }
  | { kind: 'auth' }
  | { kind: 'other'; repairable: boolean };

export function describeOnboardingPreflight(
  items: readonly OnboardingPreflightItem[],
  loginFailed: boolean
): OnboardingPreflightGuidance {
  if (items.length === 0) return { kind: 'pending' };
  const failed = items.filter((item) => item.status === 'fail');
  if (failed.length === 0 && !loginFailed) return { kind: 'pass' };

  const runtime = failed.find(
    (item) =>
      RUNTIME_PREFLIGHT_IDS.has(item.id) || item.id.startsWith('dependency.')
  );
  if (runtime) {
    return {
      kind: 'runtime',
      target: runtime.label?.trim() || runtime.id,
      repairable: runtime.repairable !== false,
    };
  }

  if (
    loginFailed ||
    failed.some((item) => LOGIN_FAILURE.test(item.detail ?? ''))
  ) {
    return { kind: 'login' };
  }

  if (failed.some((item) => item.id === 'authentication')) {
    return { kind: 'auth' };
  }

  return {
    kind: 'other',
    repairable: failed.some(
      (item) => item.id !== 'authentication' && item.repairable === true
    ),
  };
}

export type OnboardingAgentCheckStatus = 'pass' | 'blocked';

export type OnboardingContinueDecision = 'direct' | 'partial' | 'none';

export function onboardingContinueGate(
  statuses: readonly OnboardingAgentCheckStatus[]
): OnboardingContinueDecision {
  const passed = statuses.filter((status) => status === 'pass').length;
  if (statuses.length > 0 && passed === statuses.length) return 'direct';
  if (passed > 0) return 'partial';
  return 'none';
}
