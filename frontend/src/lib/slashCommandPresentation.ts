import { BaseCodingAgent, type SlashCommandDescription } from 'shared/types';
import {
  agentSlashCommandCatalog,
  isAgentSlashCommandVisible,
  type AgentSlashCommandIconKey,
} from '@/features/agents/slashCommands';

export type SlashCommandIconKey = AgentSlashCommandIconKey;

export type SlashCommandPresentation = {
  label: string;
  description: string | null;
  iconKey: SlashCommandIconKey | null;
  isSkill: boolean;
};

export function isCoreSlashCommand(
  command: SlashCommandDescription,
  executor: BaseCodingAgent | null | undefined
): boolean {
  return isAgentSlashCommandVisible(command, executor);
}

export function isSlashCommandSkill(command: SlashCommandDescription): boolean {
  return command.kind === 'SKILL';
}

export function getSlashCommandPresentation(
  command: SlashCommandDescription,
  executor: BaseCodingAgent | null | undefined
): SlashCommandPresentation {
  const providerCommand = agentSlashCommandCatalog(executor).find(
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
    label: command.name,
    description: command.description ?? null,
    iconKey: null,
    isSkill: isSlashCommandSkill(command),
  };
}
