import { Bot } from 'lucide-react';
import { ThemeMode } from 'shared/types';
import { useTheme } from '@/components/ThemeProvider';
import { cn } from '@/lib/utils';

type AgentIconProps = {
  agent: string | null | undefined;
  className?: string;
};

/**
 * Agents that ship a themed SVG under `public/agents`. Agents missing here fall
 * back to a generic glyph so the picker never renders a broken image.
 */
const BUILT_IN_ICON_PATHS: Partial<
  Record<string, { light: string; dark: string }>
> = {
  claude_code: {
    light: '/agents/claude-light.svg',
    dark: '/agents/claude-dark.svg',
  },
  codex: {
    light: '/agents/codex-light.svg',
    dark: '/agents/codex-dark.svg',
  },
  opencode: {
    light: '/agents/opencode-light.svg',
    dark: '/agents/opencode-dark.svg',
  },
  pi: { light: '/agents/pi.svg', dark: '/agents/pi.svg' },
};

const BUILT_IN_DISPLAY_NAMES: Partial<Record<string, string>> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

function getResolvedTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === ThemeMode.SYSTEM) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return theme === ThemeMode.DARK ? 'dark' : 'light';
}

export function getAgentName(agent: string | null | undefined): string {
  if (!agent) return 'Agent';
  return BUILT_IN_DISPLAY_NAMES[agent] ?? agent;
}

export function AgentIcon({ agent, className = 'h-4 w-4' }: AgentIconProps) {
  const { theme } = useTheme();
  const suffix = getResolvedTheme(theme) === 'dark' ? '-dark' : '-light';

  if (!agent) {
    return null;
  }

  const paths = BUILT_IN_ICON_PATHS[agent];
  if (!paths) {
    return <Bot className={cn('shrink-0', className)} />;
  }

  return (
    <img
      src={suffix === '-dark' ? paths.dark : paths.light}
      alt={getAgentName(agent)}
      className={cn('block shrink-0 object-contain', className)}
    />
  );
}
