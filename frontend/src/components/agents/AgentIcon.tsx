import { Bot } from 'lucide-react';
import { ThemeMode } from 'shared/types';
import { useTheme } from '@/components/ThemeProvider';
import { cn } from '@/lib/utils';

type AgentIconProps = {
  agent: string | null | undefined;
  className?: string;
  /**
   * Runtime artwork from the agent management projection. Used only when the
   * agent is not in `BUILT_IN_ICON_PATHS`, so a registry svg cannot hide a
   * known brand mark. Registry-only agents like Workbuddy still render here.
   */
  iconLight?: string | null;
  iconDark?: string | null;
  iconSvg?: string | null;
};

/**
 * Agents that ship a themed SVG under `public/agents`. Built-in artwork wins
 * over registry icons; unknown agents fall through to caller-provided runtime
 * artwork, then the generic glyph.
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
  gemini: {
    light: '/agents/gemini-light.svg',
    dark: '/agents/gemini-dark.svg',
  },
  openclaw: {
    light: '/agents/openclaw.svg',
    dark: '/agents/openclaw.svg',
  },
  opencode: {
    light: '/agents/opencode-light.svg',
    dark: '/agents/opencode-dark.svg',
  },
  cline: { light: '/agents/cline.svg', dark: '/agents/cline.svg' },
  hermes: { light: '/agents/hermes.png', dark: '/agents/hermes.png' },
  codebuddy: {
    light: '/agents/codebuddy.svg',
    dark: '/agents/codebuddy.svg',
  },
  kimi_code: { light: '/agents/kimi.svg', dark: '/agents/kimi.svg' },
  kimi: { light: '/agents/kimi.svg', dark: '/agents/kimi.svg' },
  pi: { light: '/agents/pi.svg', dark: '/agents/pi.svg' },
  grok: { light: '/agents/grok.svg', dark: '/agents/grok.svg' },
  cursor: {
    light: '/agents/cursor-light.svg',
    dark: '/agents/cursor-dark.svg',
  },
  deepseek_harness: {
    light: '/agents/deepseek-harness-light.svg',
    dark: '/agents/deepseek-harness-dark.svg',
  },
};

const BUILT_IN_DISPLAY_NAMES: Partial<Record<string, string>> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  cline: 'Cline',
  hermes: 'Hermes Agent',
  codebuddy: 'CodeBuddy',
  kimi_code: 'Kimi Code',
  kimi: 'Kimi Code',
  pi: 'Pi',
  grok: 'Grok',
  cursor: 'Cursor',
  deepseek_harness: 'DeepSeek Harness',
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

export function AgentIcon({
  agent,
  className = 'h-4 w-4',
  iconLight,
  iconDark,
  iconSvg,
}: AgentIconProps) {
  const { theme } = useTheme();
  const suffix = getResolvedTheme(theme) === 'dark' ? '-dark' : '-light';

  if (!agent) {
    return null;
  }

  const paths = BUILT_IN_ICON_PATHS[agent];
  if (paths) {
    return (
      <img
        src={suffix === '-dark' ? paths.dark : paths.light}
        alt={getAgentName(agent)}
        className={cn('block shrink-0 object-contain', className)}
      />
    );
  }

  const runtimeLight = iconLight ?? iconDark ?? '';
  const runtimeDark = iconDark ?? iconLight ?? '';

  if (iconSvg) {
    return (
      <span
        aria-hidden="true"
        className={cn('agent-icon-svg block shrink-0', className)}
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
    );
  }

  if (runtimeLight || runtimeDark) {
    return (
      <picture className={cn('block shrink-0', className)}>
        <source media="(prefers-color-scheme: dark)" srcSet={runtimeDark} />
        <img
          alt={getAgentName(agent)}
          className="block h-full w-full object-contain"
          src={runtimeLight}
        />
      </picture>
    );
  }

  return <Bot className={cn('shrink-0', className)} />;
}
