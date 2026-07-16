import type { AgentKind } from 'shared/types';

/**
 * Canonical display name for every coding agent the type system knows about.
 * Single source of truth — `getAgentName` (AgentIcon) and every selector read
 * from here so a name like "OpenCode" never drifts between surfaces.
 *
 * NOTE: having a name here does NOT mean the agent is runnable — availability
 * is the backend's verdict (`useSelectableAgents` / `list_agents.installed`).
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

/**
 * Agents offered in product UI, in registry order (excludes the test-only
 * qa_mock). Settings pages and pickers derive their option lists from this
 * instead of keeping per-page copies.
 */
export const SELECTABLE_AGENTS = [
  'claude_code',
  'codex',
  'opencode',
  'gemini',
  'openclaw',
  'cline',
  'hermes',
] as const satisfies readonly AgentKind[];

export type SelectableAgentKind = (typeof SELECTABLE_AGENTS)[number];

/** Shared `{value, label}` options for agent dropdowns/toggles. */
export const AGENT_OPTIONS: ReadonlyArray<{
  value: SelectableAgentKind;
  label: string;
}> = SELECTABLE_AGENTS.map((value) => ({
  value,
  label: AGENT_DISPLAY_NAMES[value],
}));

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
