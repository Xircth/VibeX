import type {
  AgentId,
  AgentLifecycleState,
  AgentManagementView,
  AgentRegistryViewRow,
  AgentPreflightView,
} from 'shared/types';
import {
  isAuthPreflightItem,
  presentPreflightItems,
} from '@/pages/settings/agentPreflightSnapshot';

export type OnboardingAgentCheck = {
  report?: AgentPreflightView;
  checking?: boolean;
  error?: string;
  installationFailed?: boolean;
};
export type OnboardingAgentStatus =
  | 'uninstalled'
  | 'ready'
  | 'needs_auth'
  | 'install_failed'
  | 'installing'
  | 'checking'
  | 'check_failed'
  | 'unsupported';

export function onboardingAgentStatus(
  agent: OnboardingAgentOption,
  check?: OnboardingAgentCheck
): OnboardingAgentStatus {
  if (!agent.platformSupported) return 'unsupported';
  if (
    ['queued', 'installing', 'updating', 'repairing'].includes(agent.lifecycle)
  )
    return 'installing';
  if (check?.installationFailed) return 'install_failed';
  if (check?.checking) return 'checking';
  if (agent.needsInstallation) return 'uninstalled';
  if (!check) return 'checking';
  if (check.error || !check.report) return 'check_failed';
  const items = presentPreflightItems(check.report.items);
  if (items.length === 0) return 'check_failed';
  const environment = items.filter((item) => !isAuthPreflightItem(item));
  if (environment.some((item) => item.status !== 'pass')) return 'uninstalled';
  if (
    agent.lifecycle === 'needs_auth' ||
    items.some((item) => isAuthPreflightItem(item) && item.status !== 'pass')
  )
    return 'needs_auth';
  return items.every((item) => item.status === 'pass')
    ? 'ready'
    : 'uninstalled';
}

export function canJoinOnboardingRoster(
  status: OnboardingAgentStatus
): boolean {
  return status === 'ready' || status === 'needs_auth';
}

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
  localDetected?: boolean;
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
      // A detected vendor CLI affects display order; readiness still requires
      // its ACP adapter (ADR-0010) and a passing preflight.
      const acpReady = Boolean(managed?.acp_version || sessionInstalled);
      const cliDetected = Boolean(managed?.local_runtime?.path);
      const desktopDetected = Boolean(managed?.desktop_client?.path);
      const localDetected = cliDetected || desktopDetected;
      const runtimeInstalled = acpReady || localDetected;

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
        platformSupported:
          lifecycle !== 'platform_unsupported' &&
          (registry?.platform_supported ?? true),
        runtimeInstalled,
        localDetected,
        lifecycle,
        needsInstallation: !acpReady,
      };
    })
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
