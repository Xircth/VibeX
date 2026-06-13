import { BaseCodingAgent } from 'shared/types';

/**
 * Canonical display name for every coding agent the type system knows about.
 * Single source of truth — `getAgentName` (AgentIcon) and every selector read
 * from here so a name like "OpenCode" never drifts between surfaces.
 *
 * NOTE: having a name here does NOT mean the agent is runnable. What a user can
 * actually select is gated by `getSupportedAgents`, which reads the backend's
 * real executor profiles. Names beyond the runnable set are forward-compat only.
 */
export const AGENT_DISPLAY_NAMES: Record<BaseCodingAgent, string> = {
  [BaseCodingAgent.CLAUDE_CODE]: 'Claude Code',
  [BaseCodingAgent.CODEX]: 'Codex',
  [BaseCodingAgent.OPENCODE]: 'OpenCode',
  [BaseCodingAgent.GEMINI]: 'Gemini',
  [BaseCodingAgent.AMP]: 'Amp',
  [BaseCodingAgent.CURSOR_AGENT]: 'Cursor',
  [BaseCodingAgent.QWEN_CODE]: 'Qwen',
  [BaseCodingAgent.COPILOT]: 'Copilot',
  [BaseCodingAgent.DROID]: 'Droid',
  [BaseCodingAgent.AUGGIE]: 'Auggie',
};

/** Alias kept for call sites that type an agent value. */
export type SupportedAgent = BaseCodingAgent;

const KNOWN_AGENTS: ReadonlySet<string> = new Set(Object.values(BaseCodingAgent));

/** Validity guard: is this string a known `BaseCodingAgent` enum member? */
export function isKnownAgent(agent: string): agent is BaseCodingAgent {
  return KNOWN_AGENTS.has(agent);
}

/** Friendly display name for an agent, falling back to the raw id. */
export function getAgentDisplayName(agent: string): string {
  return AGENT_DISPLAY_NAMES[agent as BaseCodingAgent] ?? agent;
}

/**
 * The agents a user can actually select, derived from the backend's executor
 * profiles (`UserSystemInfo.executors`). This is the single source of truth for
 * "what can run" — the frontend never hardcodes the list, so when the backend
 * gains an executor it appears here automatically with no UI change.
 */
export function getSupportedAgents(
  profiles: Record<string, unknown> | null | undefined
): BaseCodingAgent[] {
  if (!profiles) return [];
  return (Object.keys(profiles).filter(isKnownAgent) as BaseCodingAgent[]).sort(
    (a, b) => a.localeCompare(b)
  );
}
