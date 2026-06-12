import type { SlashCommandDescription } from 'shared/types';
import type { AgentAvailableCommand } from '@/features/agents/types';
import type { AgentLocalSkill } from '@/lib/api';
import type { DollarCommandDescription } from '@/lib/dollarCommands';

export type ComposerCommandSourceId = 'slash' | 'dollar' | 'file' | 'tag';

export type ComposerCommandSource<TOption> = {
  id: ComposerCommandSourceId;
  trigger: '/' | '$' | '@' | '#';
  label: string;
  options: TOption[];
};

function normalizeCommandName(name: string): string | null {
  const normalized = name.trim().replace(/^\/+/, '');
  return normalized ? normalized : null;
}

export function agentAvailableCommandsToSlashCommands(
  commands: AgentAvailableCommand[]
): SlashCommandDescription[] {
  return commands.flatMap((command) => {
    const name = normalizeCommandName(command.name);
    if (!name) return [];

    return [
      {
        name,
        description: command.description ?? undefined,
        kind: 'COMMAND' as const,
      },
    ];
  });
}

export function localSkillsToSlashCommands(
  skills: AgentLocalSkill[]
): SlashCommandDescription[] {
  return skills.flatMap((skill) => {
    const name = normalizeCommandName(skill.name);
    if (!name) return [];

    return [
      {
        name,
        description: skill.description ?? `Local Codex skill: ${skill.path}`,
        kind: 'SKILL' as const,
      },
    ];
  });
}

export function localSkillsToDollarCommands(
  skills: AgentLocalSkill[]
): DollarCommandDescription[] {
  return skills.flatMap((skill) => {
    const name = normalizeCommandName(skill.name);
    if (!name) return [];

    return [
      {
        name,
        description: skill.description ?? `Local Codex skill: ${skill.path}`,
      },
    ];
  });
}

export function mergeComposerSlashCommands({
  catalogCommands,
  runtimeCommands,
  skillCommands,
}: {
  catalogCommands: SlashCommandDescription[];
  runtimeCommands: SlashCommandDescription[];
  skillCommands: SlashCommandDescription[];
}): SlashCommandDescription[] {
  const byName = new Map<string, SlashCommandDescription>();
  const orderedNames: string[] = [];

  for (const command of [
    ...catalogCommands,
    ...runtimeCommands,
    ...skillCommands,
  ]) {
    const name = normalizeCommandName(command.name);
    if (!name) continue;
    if (!byName.has(name)) {
      orderedNames.push(name);
    }
    byName.set(name, { ...command, name });
  }

  return orderedNames.flatMap((name) => {
    const command = byName.get(name);
    return command ? [command] : [];
  });
}

export function createComposerCommandSource<TOption>(
  source: ComposerCommandSource<TOption>
): ComposerCommandSource<TOption> {
  return source;
}

