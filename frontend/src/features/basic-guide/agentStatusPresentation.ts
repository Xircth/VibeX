import type {
  AgentAuthenticationStatus,
  AgentLifecycleState,
  AgentManagementView,
  AgentPreflightView,
} from 'shared/types';

import type { AgentOperationState } from '@/features/agent-management';

export const ACP_STEPPER_STEPS = ['download', 'install', 'check'] as const;
export type AcpStepperStep = (typeof ACP_STEPPER_STEPS)[number];

export function isAgentLoggedIn(
  authentication: AgentAuthenticationStatus
): boolean {
  return authentication !== 'not_logged_in';
}

export function isAcpConnectorAvailable(agent: {
  acp_version: string | null;
  lifecycle: AgentLifecycleState;
}): boolean {
  if (agent.acp_version) return true;
  return (
    agent.lifecycle === 'ready' ||
    agent.lifecycle === 'needs_auth' ||
    agent.lifecycle === 'needs_config'
  );
}

export function preflightAllPassed(view: AgentPreflightView | null): boolean {
  if (!view || view.items.length === 0) return false;
  return view.items.every((item) => item.status === 'pass');
}

export function isAgentOperationallyAvailable(agent: {
  enabled: boolean;
  lifecycle: AgentLifecycleState;
}): boolean {
  return agent.enabled && agent.lifecycle === 'ready';
}

export function acpStepperIndex(progressPercent: number | null): 0 | 1 | 2 {
  const progress = Math.min(100, Math.max(0, progressPercent ?? 0));
  if (progress >= 66) return 2;
  if (progress >= 33) return 1;
  return 0;
}

export function isAcpLifecycleInProgress(
  lifecycle: AgentLifecycleState
): boolean {
  return (
    lifecycle === 'queued' ||
    lifecycle === 'installing' ||
    lifecycle === 'updating' ||
    lifecycle === 'repairing'
  );
}

export function acpStepperIndexFromLifecycle(
  lifecycle: AgentLifecycleState
): 0 | 1 | 2 {
  switch (lifecycle) {
    case 'queued':
      return 0;
    case 'installing':
    case 'updating':
      return 1;
    case 'repairing':
      return 2;
    default:
      return 0;
  }
}

export function isAcpInstallOperation(
  operation: AgentOperationState | null | undefined
): boolean {
  if (!operation) return false;
  if (
    operation.status === 'succeeded' ||
    operation.status === 'failed' ||
    operation.status === 'canceled'
  ) {
    return false;
  }
  return (
    operation.kind === 'install' ||
    operation.kind === 'update' ||
    operation.kind === 'repair' ||
    operation.kind === 'check'
  );
}

export type AgentStatusRowModel = {
  showStepper: boolean;
  stepperIndex: 0 | 1 | 2;
  connectorAvailable: boolean;
  loggedIn: boolean;
};

export function presentAgentStatusRow(
  agent: Pick<
    AgentManagementView,
    'acp_version' | 'lifecycle' | 'authentication'
  >,
  operation: AgentOperationState | null | undefined
): AgentStatusRowModel {
  const operationInFlight = isAcpInstallOperation(operation);
  const showStepper =
    operationInFlight || isAcpLifecycleInProgress(agent.lifecycle);
  return {
    showStepper,
    stepperIndex: operationInFlight
      ? acpStepperIndex(operation?.progressPercent ?? 0)
      : acpStepperIndexFromLifecycle(agent.lifecycle),
    connectorAvailable: !showStepper && isAcpConnectorAvailable(agent),
    loggedIn: isAgentLoggedIn(agent.authentication),
  };
}
