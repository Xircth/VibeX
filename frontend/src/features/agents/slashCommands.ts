import type { SlashCommandDescription } from 'shared/types';

export type AgentSlashCommandIconKey =
  | 'compact'
  | 'goal'
  | 'review'
  | 'init'
  | 'mcp'
  | 'command';

type AgentCommandDefinition = SlashCommandDescription & {
  label?: string;
  iconKey?: AgentSlashCommandIconKey;
};

const CLAUDE_COMMANDS: AgentCommandDefinition[] = [
  ['compact', 'Compact conversation with an optional focus', 'Compact', 'compact'],
  ['goal', 'Set, inspect, pause, resume, or clear a long-running goal', 'Goal', 'goal'],
  ['init', 'Initialize a CLAUDE.md file', 'Init', 'init'],
  ['resume', 'Resume a Claude Code conversation', 'Resume', 'command'],
  ['review', 'Review a pull request', 'Review', 'review'],
  ['context', 'Show Claude Code context usage', 'Context', 'command'],
].map(([name, description, label, iconKey]) => ({
  name,
  description,
  label,
  iconKey: iconKey as AgentSlashCommandIconKey,
  kind: 'COMMAND' as const,
}));

const CODEX_COMMANDS: AgentCommandDefinition[] = [
  ['compact', 'Compact conversation with an optional focus', 'Compact', 'compact'],
  ['goal', 'Set, inspect, pause, resume, or clear a long-running goal', 'Goal', 'goal'],
  ['init', 'Create an AGENTS.md file with repository instructions', 'Init', 'init'],
  ['plan', 'Switch to planning-oriented Codex behavior', 'Plan', 'command'],
  ['review', 'Review code with optional instructions', 'Review', 'review'],
].map(([name, description, label, iconKey]) => ({
  name,
  description,
  label,
  iconKey: iconKey as AgentSlashCommandIconKey,
  kind: 'COMMAND' as const,
}));

const OPENCODE_COMMANDS: AgentCommandDefinition[] = [
  ['compact', 'Compact the current session', 'Compact', 'compact'],
].map(([name, description, label, iconKey]) => ({
  name,
  description,
  label,
  iconKey: iconKey as AgentSlashCommandIconKey,
  kind: 'COMMAND' as const,
}));

export function agentSlashCommandCatalog(
  executor: string | null | undefined
): AgentCommandDefinition[] {
  switch (executor) {
    case 'claude_code':
      return CLAUDE_COMMANDS;
    case 'codex':
      return CODEX_COMMANDS;
    case 'opencode':
      return OPENCODE_COMMANDS;
    default:
      return [];
  }
}

export function isAgentSlashCommandVisible(
  command: SlashCommandDescription,
  executor: string | null | undefined
): boolean {
  if (command.kind === 'SKILL') return true;
  return agentSlashCommandCatalog(executor).some(
    (item) => item.name === command.name
  );
}
