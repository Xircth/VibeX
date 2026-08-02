import type { SlashCommandDescription } from 'shared/types';
import type { DollarCommandDescription } from '@/lib/dollarCommands';
import { filterDollarCommands } from '@/lib/dollarCommands';
import type { SearchResultItem } from '@/lib/searchTagsAndFiles';
import { getSlashCommandPresentation } from '@/lib/slashCommandPresentation';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import {
  serializeAgentMention,
  type AgentMentionCandidate,
} from './AgentMention';

export type ComposerTypeaheadOption = {
  key: string;
  label: string;
  description?: string;
  insertText: string;
};

export const MAX_TYPEAHEAD_OPTIONS = 50;
export const MAX_REFERENCE_OPTIONS = 10;

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

export function filterSlashCommands(
  all: SlashCommandDescription[],
  query: string,
  executor: string | null | undefined
): SlashCommandDescription[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;

  const searchText = (command: SlashCommandDescription) => {
    const presentation = getSlashCommandPresentation(command, executor);
    return [
      command.name,
      presentation.label,
      command.description ?? '',
      presentation.description ?? '',
    ]
      .join(' ')
      .toLowerCase();
  };

  const startsWith = all.filter((command) => {
    const presentation = getSlashCommandPresentation(command, executor);
    return (
      command.name.toLowerCase().startsWith(q) ||
      presentation.label.toLowerCase().startsWith(q)
    );
  });
  const includes = all.filter(
    (command) =>
      !startsWith.includes(command) && searchText(command).includes(q)
  );
  return [...startsWith, ...includes];
}

export function slashCommandsToTypeaheadOptions(
  all: SlashCommandDescription[],
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
  ].slice(0, MAX_TYPEAHEAD_OPTIONS);

  return ordered.map((command) => {
    const presentation = getSlashCommandPresentation(command, executor);
    return {
      key: `slash-${command.name}`,
      label: `/${presentation.label}`,
      description: presentation.description ?? command.description ?? undefined,
      insertText: formatSessionComposerCommand({
        type: '/',
        key: command.name,
        value: `/${command.name}`,
      }),
    };
  });
}

export function dollarCommandsToTypeaheadOptions(
  all: DollarCommandDescription[],
  query: string
): ComposerTypeaheadOption[] {
  return filterDollarCommands(all, query)
    .slice(0, MAX_TYPEAHEAD_OPTIONS)
    .map((command) => ({
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
        value: `#${item.tag.tag_name}`,
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
