import type { SlashCommandDescription } from 'shared/types';
import {
  agentSlashCommandCatalog,
  type AgentSlashCommandIconKey,
} from '@/features/agents/slashCommands';
import type { ComposerSlashCommand } from '@/lib/conversation-rendering/commandSources';

export type SlashCommandIconKey = AgentSlashCommandIconKey;

export type SlashCommandPresentation = {
  label: string;
  description: string | null;
  iconKey: SlashCommandIconKey | null;
  isSkill: boolean;
};

export function isSlashCommandSkill(command: SlashCommandDescription): boolean {
  return command.kind === 'SKILL';
}

export function getSlashCommandPresentation(
  command: SlashCommandDescription,
  executor: string | null | undefined
): SlashCommandPresentation {
  const composerCommand = command as Partial<ComposerSlashCommand>;
  const providerCommand =
    composerCommand.sourceKind === 'plugin' || command.kind === 'SKILL'
      ? undefined
      : agentSlashCommandCatalog(executor).find(
          (item) => item.name === command.name
        );
  const providerPresentation = providerCommand
    ? {
        label: providerCommand.label ?? providerCommand.name,
        description: providerCommand.description ?? null,
        iconKey: providerCommand.iconKey ?? 'command',
        isSkill: false,
      }
    : null;

  if (providerPresentation) {
    return providerPresentation;
  }

  return {
    label: composerCommand.displayLabel ?? command.name,
    description: command.description ?? null,
    iconKey: null,
    isSkill: isSlashCommandSkill(command),
  };
}
