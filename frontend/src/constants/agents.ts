import type { AgentKind } from 'shared/types';

/**
 * Canonical display name for every coding agent the type system knows about.
 * Single source of truth — `getAgentName` (AgentIcon) and every selector read
 * from here so a name like "OpenCode" never drifts between surfaces.
 *
 * NOTE: having a name here does NOT mean the agent is runnable. What a user can
 * actually select is gated by `getSupportedAgents`, which reads the backend's
 * real executor profiles. Names beyond the runnable set are forward-compat only.
 */
export const AGENT_DISPLAY_NAMES: Record<AgentKind, string> = {
  ['claude_code']: 'Claude Code',
  ['codex']: 'Codex',
  ['opencode']: 'OpenCode',
  ['gemini']: 'Gemini',
  ['openclaw']: 'OpenClaw',
  ['cline']: 'Cline',
  ['hermes']: 'Hermes',
  ['qa_mock']: 'QA Mock',
};

/** Alias kept for call sites that type an agent value. */
export type SupportedAgent = AgentKind;

const KNOWN_AGENTS: ReadonlySet<string> = new Set(
  Object.keys(AGENT_DISPLAY_NAMES)
);

/** Validity guard: is this string a known `AgentKind`? */
export function isKnownAgent(agent: string): agent is AgentKind {
  return KNOWN_AGENTS.has(agent);
}

/** Friendly display name for an agent, falling back to the raw id. */
export function getAgentDisplayName(agent: string): string {
  return AGENT_DISPLAY_NAMES[agent as AgentKind] ?? agent;
}

/**
 * The agents a user can actually select, derived from the backend's executor
 * profiles (`UserSystemInfo.executors`). This is the single source of truth for
 * "what can run" — the frontend never hardcodes the list, so when the backend
 * gains an executor it appears here automatically with no UI change.
 */
export function getSupportedAgents(
  profiles: Record<string, unknown> | null | undefined
): AgentKind[] {
  if (!profiles) return [];
  return (Object.keys(profiles).filter(isKnownAgent) as AgentKind[]).sort(
    (a, b) => a.localeCompare(b)
  );
}
