import { Bot } from 'lucide-react';
import { BaseCodingAgent, ThemeMode } from 'shared/types';
import { useTheme } from '@/components/ThemeProvider';
import { cn } from '@/lib/utils';

type AgentIconProps = {
  agent: BaseCodingAgent | null | undefined;
  className?: string;
};

/** Display name for every agent. Exhaustive over `BaseCodingAgent`. */
const AGENT_NAMES: Record<BaseCodingAgent, string> = {
  [BaseCodingAgent.CLAUDE_CODE]: 'Claude Code',
  [BaseCodingAgent.CODEX]: 'Codex',
  [BaseCodingAgent.OPENCODE]: 'OpenCode',
  [BaseCodingAgent.GEMINI]: 'Gemini',
  [BaseCodingAgent.OPENCLAW]: 'OpenClaw',
  [BaseCodingAgent.CLINE]: 'Cline',
  [BaseCodingAgent.HERMES]: 'Hermes',
};

/**
 * Agents that ship a themed SVG under `public/agents`. Agents missing here fall
 * back to a generic glyph so the picker never renders a broken image.
 */
const AGENT_ICON_BASENAMES: Partial<Record<BaseCodingAgent, string>> = {
  [BaseCodingAgent.CLAUDE_CODE]: 'claude',
  [BaseCodingAgent.CODEX]: 'codex',
  [BaseCodingAgent.OPENCODE]: 'opencode',
  [BaseCodingAgent.GEMINI]: 'gemini',
};

function getResolvedTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === ThemeMode.SYSTEM) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return theme === ThemeMode.DARK ? 'dark' : 'light';
}

export function getAgentName(
  agent: BaseCodingAgent | null | undefined
): string {
  if (!agent) return 'Agent';
  return AGENT_NAMES[agent] ?? agent;
}

export function AgentIcon({ agent, className = 'h-4 w-4' }: AgentIconProps) {
  const { theme } = useTheme();
  const suffix = getResolvedTheme(theme) === 'dark' ? '-dark' : '-light';

  if (!agent) {
    return null;
  }

  const basename = AGENT_ICON_BASENAMES[agent];
  if (!basename) {
    return <Bot className={cn('shrink-0', className)} />;
  }

  return (
    <img
      src={`/agents/${basename}${suffix}.svg`}
      alt={getAgentName(agent)}
      className={cn('block shrink-0 object-contain', className)}
    />
  );
}
