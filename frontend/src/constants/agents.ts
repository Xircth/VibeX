import type { BaseCodingAgent } from 'shared/types';

/** The three supported agent types in the settings UI. */
export const SUPPORTED_AGENTS: readonly BaseCodingAgent[] = [
  'CLAUDE_CODE' as BaseCodingAgent,
  'CODEX' as BaseCodingAgent,
  'OPENCODE' as BaseCodingAgent,
] as const;

export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

/** Type guard to check if an agent string is one of the supported agents. */
export function isSupportedAgent(
  agent: string
): agent is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(agent);
}

/** Friendly display names for each supported agent. */
export const AGENT_DISPLAY_NAMES: Record<SupportedAgent, string> = {
  CLAUDE_CODE: 'Claude Code',
  CODEX: 'Codex',
  OPENCODE: 'Open Code',
} as Record<SupportedAgent, string>;

/** Description text for each supported agent. */
export const AGENT_DESCRIPTIONS: Record<SupportedAgent, string> = {
  CLAUDE_CODE: 'Anthropic Claude Code - AI 编码助手',
  CODEX: 'OpenAI Codex - AI 编码助手',
  OPENCODE: 'OpenCode - 开源 AI 编码助手',
} as Record<SupportedAgent, string>;
