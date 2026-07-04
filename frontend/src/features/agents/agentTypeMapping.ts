import type { AgentKind } from 'shared/types';
import type { AgentType } from './types';

/**
 * Maps an ACP runtime `AgentType` to the executor-profile identity.
 *
 * After batch D2 the two agent-identity enums were unified into a single
 * `AgentKind`, so this is now an identity mapping retained for call-site
 * clarity (and to keep the `enabled/installed` join in `useSelectableAgents`
 * readable).
 */
export function baseCodingAgentFromAgentType(agentType: AgentType): AgentKind {
  return agentType;
}
