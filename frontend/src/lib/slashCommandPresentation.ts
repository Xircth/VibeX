import { BaseCodingAgent, type SlashCommandDescription } from 'shared/types';
import { getProviderFrontendAdapterByExecutor } from '@/features/provider-runtime/providerFrontendAdapters';

export type SlashCommandIconKey =
  | 'compact'
  | 'goal'
  | 'review'
  | 'init'
  | 'mcp'
  | 'command';

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
  return (
    getProviderFrontendAdapterByExecutor(executor)?.isSlashCommandVisible(
      command
    ) ?? false
  );
}

export function isSlashCommandSkill(command: SlashCommandDescription): boolean {
  return command.kind === 'SKILL';
}

export function getSlashCommandPresentation(
  command: SlashCommandDescription,
  executor: BaseCodingAgent | null | undefined
): SlashCommandPresentation {
  const providerPresentation =
    getProviderFrontendAdapterByExecutor(executor)?.getSlashCommandPresentation(
      command
    );

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
