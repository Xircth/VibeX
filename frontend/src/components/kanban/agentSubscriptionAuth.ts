import type { AgentAuthModeView, AgentManagementView } from 'shared/types';

export const PLAN_CAPABLE_AGENT_IDS = [
  'claude_code',
  'codex',
  'grok',
  'cursor',
  'opencode',
  'kimi_code',
  'antigravity',
] as const;

export type PlanCapableAgentId = (typeof PLAN_CAPABLE_AGENT_IDS)[number];

const SUBSCRIPTION_MODES: Record<PlanCapableAgentId, readonly string[]> = {
  claude_code: ['official_subscription'],
  codex: ['chatgpt_subscription'],
  grok: ['subscription'],
  cursor: ['subscription'],
  opencode: ['official_subscription'],
  kimi_code: ['official_subscription'],
  antigravity: ['oauth-personal', 'oauth-business'],
};

export function isPlanCapableAgentId(
  agentId: string
): agentId is PlanCapableAgentId {
  return (PLAN_CAPABLE_AGENT_IDS as readonly string[]).includes(agentId);
}

type SubscriptionAgent = Pick<
  AgentManagementView,
  'enabled' | 'authentication' | 'agent_id'
>;

/** Quota is an account fact. API-key and logged-out modes stay hidden. */
export function isSignedInSubscription(
  agent: SubscriptionAgent,
  authMode: Pick<AgentAuthModeView, 'mode'> | undefined
) {
  return (
    agent.enabled &&
    agent.authentication === 'account' &&
    isPlanCapableAgentId(agent.agent_id) &&
    !!authMode?.mode &&
    SUBSCRIPTION_MODES[agent.agent_id].includes(authMode.mode)
  );
}
