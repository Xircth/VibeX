import type {
  OfficePluginCatalog,
  SlashCommandDescription,
} from 'shared/types';
import type { PluginActionCatalog } from '@/lib/api/plugins';
import type { DollarCommandDescription } from '@/lib/dollarCommands';
import { filterDollarCommands } from '@/lib/dollarCommands';
import type { SearchResultItem } from '@/lib/searchTagsAndFiles';
import { rankByTextMatch } from '@/lib/textMatch';
import {
  commandInvocationName,
  getSlashCommandPresentation,
  isDollarInvokedCommand,
} from '@/lib/slashCommandPresentation';
import { serializeTagReferenceMarker } from '@/lib/tagReferenceMarkers';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import type {
  ComposerSlashCommand,
  ComposerSlashCommandSourceKind,
} from '@/lib/conversation-rendering/commandSources';
import {
  serializeAgentMention,
  type AgentMentionCandidate,
} from './AgentMention';

export type ComposerTypeaheadOption = {
  key: string;
  label: string;
  description?: string;
  insertText: string;
  sourceKind?: ComposerSlashCommandSourceKind;
};

export const MAX_TYPEAHEAD_OPTIONS = 50;
export const MAX_REFERENCE_OPTIONS = 10;

export function pluginActionsToTypeaheadOptions(
  catalog:
    | {
        actions: PluginActionCatalog['actions'];
        readiness?: OfficePluginCatalog['readiness'];
      }
    | null
    | undefined,
  query: string,
  hostedSkillIds: ReadonlySet<string>
): ComposerTypeaheadOption[] {
  if (!catalog) return [];
  const readiness = catalog.readiness;
  if (
    readiness &&
    (!readiness.enabled ||
      readiness.overall !== 'ready' ||
      readiness.dependency.status !== 'ready')
  ) {
    return [];
  }

  const readySkills = new Set(
    (readiness?.skills ?? [])
      .filter((skill) => skill.status === 'ready')
      .map((skill) => skill.id)
  );
  const normalized = query.trim().toLocaleLowerCase();

  return catalog.actions
    .filter(
      (action) =>
        (!readiness ||
          action.requiredSkills.every((skill) => readySkills.has(skill))) &&
        action.requiredSkills.every((skill) => hostedSkillIds.has(skill)) &&
        (!readiness ||
          action.requiredTools.every(
            (tool) =>
              tool === readiness.dependency.id &&
              readiness.dependency.status === 'ready'
          ))
    )
    .filter((action) => {
      if (!normalized) return true;
      return [
        action.actionId,
        action.label,
        ...action.requiredSkills,
        ...action.requiredTools,
        ...action.promptBlocks.map((block) => block.text),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized);
    })
    .slice(0, MAX_TYPEAHEAD_OPTIONS)
    .map((action) => {
      const prompt = action.promptBlocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n');
      return {
        key: `plugin-${action.pluginId}-${action.actionId}`,
        label: `!${action.label}`,
        description: prompt || undefined,
        insertText: `${formatSessionComposerCommand({
          type: '!',
          key: `${action.pluginId}/${action.actionId}|${action.label}`,
          value: '',
        })}${prompt}`,
      };
    });
}

export function agentMentionsToTypeaheadOptions(
  candidates: AgentMentionCandidate[],
  query: string
): ComposerTypeaheadOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  return candidates
    .filter((candidate) => {
      if (!normalized) return true;
      return (
        candidate.display_name.toLocaleLowerCase().includes(normalized) ||
        candidate.agent_kind.toLocaleLowerCase().includes(normalized)
      );
    })
    .slice(0, MAX_REFERENCE_OPTIONS)
    .map((candidate) => ({
      key: `agent-${candidate.agent_kind}`,
      label: `&${candidate.display_name}`,
      description: candidate.description ?? candidate.agent_kind,
      insertText: serializeAgentMention(candidate),
    }));
}

function slashInvocation(
  command: SlashCommandDescription | ComposerSlashCommand,
  executor: string | null | undefined
): { type: '/' | '$'; name: string } {
  const composerCommand = command as Partial<ComposerSlashCommand>;
  const sourceKind =
    composerCommand.sourceKind ??
    (command.kind === 'SKILL' ? 'skill' : 'native');
  const name = commandInvocationName(command.name);
  const isCodexSkill =
    isDollarInvokedCommand(command.name) ||
    ((sourceKind === 'skill' || command.kind === 'SKILL') &&
      executor === 'codex');
  return { type: isCodexSkill && name ? '$' : '/', name };
}

export function filterSlashCommands(
  all: SlashCommandDescription[],
  query: string,
  executor: string | null | undefined
): SlashCommandDescription[] {
  return rankByTextMatch(
    query,
    all,
    (command) => {
      const presentation = getSlashCommandPresentation(command, executor);
      return `${slashInvocation(command, executor).name} ${presentation.label}`;
    },
    (command) => {
      const presentation = getSlashCommandPresentation(command, executor);
      return [command.description ?? '', presentation.description ?? '']
        .filter(Boolean)
        .join(' ');
    }
  );
}

export function slashCommandsToTypeaheadOptions(
  all: Array<SlashCommandDescription | ComposerSlashCommand>,
  query: string,
  executor: string | null | undefined
): ComposerTypeaheadOption[] {
  if (!executor) return [];

  const filtered = filterSlashCommands(all, query, executor);
  const ordered = [
    ...filtered.filter(
      (command) => !getSlashCommandPresentation(command, executor).isSkill
    ),
    ...filtered.filter(
      (command) => getSlashCommandPresentation(command, executor).isSkill
    ),
  ];

  return ordered.map((command) => {
    const composerCommand = command as Partial<ComposerSlashCommand>;
    const sourceKind =
      composerCommand.sourceKind ??
      (command.kind === 'SKILL' ? 'skill' : 'native');
    const sourceId = composerCommand.sourceId ?? command.name;
    const presentation = getSlashCommandPresentation(command, executor);
    const invocation = slashInvocation(command, executor);
    const isPlugin = sourceKind === 'plugin';
    const type = isPlugin ? '/' : invocation.type;
    const name = invocation.name || command.name;
    return {
      key: `slash-${sourceKind}-${sourceId}-${command.name}`,
      label: `${type}${presentation.label}`,
      description: presentation.description ?? command.description ?? undefined,
      sourceKind,
      insertText: formatSessionComposerCommand({
        type,
        key: type === '$' ? name : `${sourceKind}:${sourceId}:${name}`,
        value: isPlugin
          ? (composerCommand.prompt ?? `/${name}`)
          : `${type}${name}`,
      }),
    };
  });
}

export function dollarCommandsToTypeaheadOptions(
  all: DollarCommandDescription[],
  query: string
): ComposerTypeaheadOption[] {
  return filterDollarCommands(all, query).map((command) => ({
    key: `dollar-${command.name}`,
    label: `$${command.name}`,
    description: command.description,
    insertText: formatSessionComposerCommand({
      type: '$',
      key: command.name,
      value: `$${command.name}`,
    }),
  }));
}

function createFileSearchResult(
  path: string,
  isFile: boolean
): SearchResultItem {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return {
    type: 'file',
    file: {
      path,
      name,
      is_file: isFile,
      match_type: 'FullPath',
      score: BigInt(0),
    },
  };
}

export function searchResultToTypeaheadOption(
  item: SearchResultItem
): ComposerTypeaheadOption | null {
  if (item.type === 'tag' && item.tag) {
    return {
      key: `tag-${item.tag.id}`,
      label: `#${item.tag.tag_name}`,
      description: item.tag.content ?? undefined,
      insertText: formatSessionComposerCommand({
        type: '#',
        key: item.tag.tag_name,
        value: serializeTagReferenceMarker({
          tagId: item.tag.id,
          tagName: item.tag.tag_name,
          content: item.tag.content ?? '',
        }),
      }),
    };
  }

  if (item.type === 'file' && item.file) {
    return {
      key: `file-${item.file.path}`,
      label: item.file.name,
      description: item.file.path,
      insertText: formatSessionComposerCommand({
        type: '@',
        key: item.file.name,
        value: item.file.path,
      }),
    };
  }

  return null;
}

export function rootEntriesToFileReferenceOptions(entries: {
  directories: string[];
  files: string[];
}): ComposerTypeaheadOption[] {
  const directoryResults = entries.directories.map((path) =>
    createFileSearchResult(path, false)
  );
  const fileResults = entries.files.map((path) =>
    createFileSearchResult(path, true)
  );

  return [...directoryResults, ...fileResults]
    .slice(0, MAX_REFERENCE_OPTIONS)
    .flatMap((item) => {
      const option = searchResultToTypeaheadOption(item);
      return option ? [option] : [];
    });
}

export function referenceResultsToTypeaheadOptions(
  trigger: '@' | '#',
  results: SearchResultItem[]
): ComposerTypeaheadOption[] {
  return results
    .filter((item) => item.type === (trigger === '@' ? 'file' : 'tag'))
    .slice(0, MAX_REFERENCE_OPTIONS)
    .flatMap((item) => {
      const option = searchResultToTypeaheadOption(item);
      return option ? [option] : [];
    });
}
