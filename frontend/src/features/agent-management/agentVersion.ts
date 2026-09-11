import type { AgentLifecycleState, AgentUpdateCheckView } from 'shared/types';

const CHECKABLE_LIFECYCLES = new Set<AgentLifecycleState>([
  'ready',
  'needs_auth',
  'needs_config',
  'needs_repair',
]);

export function versionIsNewer(
  available: string | null | undefined,
  current: string | null | undefined
): boolean {
  if (!available || !current) return false;
  const parse = (raw: string) =>
    (raw.match(/\d+(?:\.\d+)*/)?.[0] ?? '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const availableParts = parse(available);
  const currentParts = parse(current);
  const length = Math.max(availableParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const next = availableParts[index] ?? 0;
    const seen = currentParts[index] ?? 0;
    if (next !== seen) return next > seen;
  }
  return false;
}

export function agentHasAcpUpdate(
  check: Pick<
    AgentUpdateCheckView,
    'update_available' | 'acp_available' | 'acp_current'
  >,
  probedVersion?: string | null
): boolean {
  if (!check.acp_available) return false;
  return (
    versionIsNewer(check.acp_available, probedVersion) ||
    versionIsNewer(check.acp_available, check.acp_current) ||
    check.update_available
  );
}

export function isAgentAcpUpdateCheckable(agent: {
  enabled: boolean;
  retired: boolean;
  lifecycle: AgentLifecycleState;
}): boolean {
  return (
    agent.enabled && !agent.retired && CHECKABLE_LIFECYCLES.has(agent.lifecycle)
  );
}
