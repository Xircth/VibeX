import type { AgentLifecycleState } from 'shared/types';

/**
 * Session pickers and the status bar show enabled Agents that already have a
 * local installation. Built-in Agents default to enabled, so uninstalled
 * members stay in Settings rather than cluttering operational lists.
 */
export function isEnabledInstalledAgent(agent: {
  enabled: boolean;
  lifecycle: AgentLifecycleState;
}): boolean {
  return agent.enabled && agent.lifecycle !== 'uninstalled';
}
