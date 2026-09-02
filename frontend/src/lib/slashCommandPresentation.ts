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

export function isDollarInvokedCommand(name: string): boolean {
  return name.trim().replace(/^\/+/, '').startsWith('$');
}

export function isSlashCommandSkill(command: SlashCommandDescription): boolean {
  return command.kind === 'SKILL' || isDollarInvokedCommand(command.name);
}

export function commandInvocationName(name: string): string {
  return name.trim().replace(/^\/+/, '').replace(/^\$/, '');
}

export function getSlashCommandPresentation(
  command: SlashCommandDescription,
  executor: string | null | undefined
): SlashCommandPresentation {
  const composerCommand = command as Partial<ComposerSlashCommand>;
  const providerCommand =
    composerCommand.sourceKind === 'plugin' || isSlashCommandSkill(command)
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
    label: composerCommand.displayLabel ?? commandInvocationName(command.name),
    description: command.description ?? null,
    iconKey: null,
    isSkill: isSlashCommandSkill(command),
  };
}
