import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode } from 'lexical';
import {
  Archive,
  Boxes,
  Command as CommandIcon,
  FilePlus2,
  SearchCheck,
  Target,
  type LucideIcon,
} from 'lucide-react';
import type { ExecutorProfileId, SlashCommandDescription } from 'shared/types';

import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { getSlashCommandPresentation } from '@/lib/slashCommandPresentation';
import { useTaskAttemptId } from '@/components/ui/wysiwyg/context/task-attempt-context';
import { useTypeaheadOpen } from '@/components/ui/wysiwyg/context/typeahead-open-context';

import { $createSlashCommandNode } from '../nodes/slash-command-node';
import { TypeaheadMenu } from './typeahead-menu-components';
import { matchSlashCommandTrigger } from './typeahead-triggers';

const SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  compact: Archive,
  goal: Target,
  review: SearchCheck,
  init: FilePlus2,
  mcp: Boxes,
  command: CommandIcon,
};

class SlashCommandOption extends MenuOption {
  command: SlashCommandDescription | null;
  meta: 'loading' | 'empty' | null;

  constructor(
    command: SlashCommandDescription | null,
    meta: 'loading' | 'empty' | null = null
  ) {
    super(
      command ? `slash-command-${command.name}` : `slash-command-meta-${meta}`
    );
    this.command = command;
    this.meta = meta;
  }
}

function filterSlashCommands(
  all: SlashCommandDescription[],
  query: string,
  executor: ExecutorProfileId['executor'] | null | undefined
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

export function SlashCommandTypeaheadPlugin({
  executorProfile,
  repoId,
}: {
  executorProfile: ExecutorProfileId | null;
  repoId?: string;
}) {
  const [editor] = useLexicalComposerContext();
  const portalContainer = usePortalContainer();
  const taskAttemptId = useTaskAttemptId();
  const { setIsOpen } = useTypeaheadOpen();
  const [options, setOptions] = useState<SlashCommandOption[]>([]);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const executor = executorProfile?.executor ?? null;

  const slashCommandsQuery = useSlashCommands(executorProfile, {
    workspaceId: taskAttemptId,
    repoId,
  });
  const allCommands = useMemo(
    () => slashCommandsQuery.commands ?? [],
    [slashCommandsQuery.commands]
  );
  const isLoading =
    !slashCommandsQuery.isInitialized && !!executorProfile?.executor;
  const isDiscovering =
    slashCommandsQuery.discovering && allCommands.length === 0;

  const menuOptions = useMemo(() => {
    if (!executor || activeQuery === null) {
      return [] as SlashCommandOption[];
    }

    if (isLoading || isDiscovering) {
      return [new SlashCommandOption(null, 'loading')];
    }

    if (options.length === 0) {
      return [new SlashCommandOption(null, 'empty')];
    }

    return options;
  }, [activeQuery, executor, isDiscovering, isLoading, options]);

  const updateOptions = useCallback(
    (query: string | null) => {
      setActiveQuery(query);

      if (!executor || query === null) {
        setOptions([]);
        return;
      }

      const filtered = filterSlashCommands(allCommands, query, executor);
      const ordered = [
        ...filtered.filter(
          (command) => !getSlashCommandPresentation(command, executor).isSkill
        ),
        ...filtered.filter(
          (command) => getSlashCommandPresentation(command, executor).isSkill
        ),
      ].slice(0, 50);
      setOptions(ordered.map((command) => new SlashCommandOption(command)));
    },
    [executor, allCommands]
  );

  const hasVisibleResults = useMemo(() => {
    if (!executor || activeQuery === null) return false;
    if (isLoading || isDiscovering) return true;
    if (!activeQuery.trim()) return true;
    return options.length > 0;
  }, [executor, activeQuery, isDiscovering, isLoading, options.length]);

  useEffect(() => {
    if (activeQuery === null) return;
    updateOptions(activeQuery);
  }, [activeQuery, updateOptions]);

  return (
    <LexicalTypeaheadMenuPlugin<SlashCommandOption>
      triggerFn={matchSlashCommandTrigger}
      options={menuOptions}
      onQueryChange={updateOptions}
      onOpen={() => {
        setIsOpen(true);
        updateOptions('');
      }}
      onClose={() => {
        setIsOpen(false);
        setActiveQuery(null);
        setOptions([]);
      }}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        const selectedCommand = option.command;
        if (!selectedCommand) {
          return;
        }

        editor.update(() => {
          if (!nodeToReplace) return;

          const commandNode = $createSlashCommandNode({
            commandName: selectedCommand.name,
            description: selectedCommand.description ?? undefined,
            displayName: getSlashCommandPresentation(selectedCommand, executor)
              .label,
          });
          nodeToReplace.replace(commandNode);

          const spaceNode = $createTextNode(' ');
          commandNode.insertAfter(spaceNode);
          spaceNode.select(1, 1);
        });

        closeMenu();
      }}
      menuRenderFn={(
        anchorRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }
      ) => {
        if (!anchorRef.current) return null;
        if (!executor) return null;
        if (!hasVisibleResults) return null;

        const commandOptions = menuOptions.flatMap((option) =>
          option.command ? [{ option, command: option.command }] : []
        );
        const primaryCommandOptions = commandOptions.filter(
          ({ command }) =>
            !getSlashCommandPresentation(command, executor).isSkill
        );
        const skillCommandOptions = commandOptions.filter(
          ({ command }) =>
            getSlashCommandPresentation(command, executor).isSkill
        );
        const metaState =
          menuOptions.find((option) => option.meta)?.meta ?? null;
        const isEmpty =
          metaState === 'empty' ||
          (!isLoading && !isDiscovering && allCommands.length === 0);
        const showLoadingRow = isLoading || isDiscovering;
        const loadingText = isLoading ? '正在加载命令...' : '正在发现命令...';

        return createPortal(
          <TypeaheadMenu anchorEl={anchorRef.current}>
            {isEmpty ? (
              <TypeaheadMenu.Empty>
                {'当前配置没有可用命令。'}
              </TypeaheadMenu.Empty>
            ) : commandOptions.length === 0 && !showLoadingRow ? null : (
              <TypeaheadMenu.ScrollArea>
                {showLoadingRow && (
                  <div className="px-3 py-2 text-sm text-muted-foreground select-none">
                    {loadingText}
                  </div>
                )}
                {primaryCommandOptions.map(({ option, command }, index) => (
                  <SlashCommandMenuItem
                    key={option.key}
                    command={command}
                    executor={executor}
                    isSelected={index === selectedIndex}
                    index={index}
                    setHighlightedIndex={setHighlightedIndex}
                    setRefElement={option.setRefElement}
                    onClick={() => selectOptionAndCleanUp(option)}
                  />
                ))}
                {primaryCommandOptions.length > 0 &&
                  skillCommandOptions.length > 0 && <div className="h-2" />}
                {skillCommandOptions.map(({ option, command }, index) => {
                  const optionIndex = primaryCommandOptions.length + index;
                  return (
                    <SlashCommandMenuItem
                      key={option.key}
                      command={command}
                      executor={executor}
                      isSelected={optionIndex === selectedIndex}
                      index={optionIndex}
                      setHighlightedIndex={setHighlightedIndex}
                      setRefElement={option.setRefElement}
                      onClick={() => selectOptionAndCleanUp(option)}
                    />
                  );
                })}
              </TypeaheadMenu.ScrollArea>
            )}
          </TypeaheadMenu>,
          portalContainer ?? document.body
        );
      }}
    />
  );
}

function SlashCommandMenuItem({
  command,
  executor,
  isSelected,
  index,
  setHighlightedIndex,
  setRefElement,
  onClick,
}: {
  command: SlashCommandDescription;
  executor: ExecutorProfileId['executor'];
  isSelected: boolean;
  index: number;
  setHighlightedIndex: (index: number) => void;
  setRefElement?: (element: HTMLElement | null) => void;
  onClick: () => void;
}) {
  const presentation = getSlashCommandPresentation(command, executor);
  const Icon = presentation.iconKey
    ? SLASH_COMMAND_ICONS[presentation.iconKey]
    : null;

  return (
    <TypeaheadMenu.Item
      isSelected={isSelected}
      index={index}
      setHighlightedIndex={setHighlightedIndex}
      setRefElement={setRefElement}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        {Icon && !presentation.isSkill ? (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        <span className="font-medium text-foreground">
          {presentation.label}
        </span>
      </div>
      {presentation.description && (
        <div
          className={`mt-0.5 truncate text-xs text-muted-foreground ${
            Icon && !presentation.isSkill ? 'pl-5' : ''
          }`}
        >
          {presentation.description}
        </div>
      )}
    </TypeaheadMenu.Item>
  );
}
