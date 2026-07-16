import type { AgentKind, ExecutorProfileId } from 'shared/types';

const DEFAULT_ONBOARDING_AGENT: AgentKind = 'claude_code';

/**
 * Onboarding chooses only the default Agent. ACP session controls (model,
 * permission, reasoning, Fast, and so on) are intentionally selected later
 * from the agent's persisted capability catalog when a session is created.
 *
 * Keep this normalization at the persistence boundary as well as the UI
 * boundary: a legacy saved profile can contain profile variants or old
 * model/effort overrides, neither of which is a valid onboarding choice.
 */
export function getOnboardingDefaultProfile(
  configuredProfile: ExecutorProfileId | null | undefined
): ExecutorProfileId {
  return {
    executor: configuredProfile?.executor ?? DEFAULT_ONBOARDING_AGENT,
    variant: null,
  };
}
