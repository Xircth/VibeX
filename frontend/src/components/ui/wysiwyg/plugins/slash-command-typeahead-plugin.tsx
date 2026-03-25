import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode } from 'lexical';
import { $createSlashCommandNode } from '../nodes/slash-command-node';
import { Command as CommandIcon } from 'lucide-react';import type { BaseCodingAgent, SlashCommandDescription } from 'shared/types';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useTaskAttemptId } from '@/components/ui/wysiwyg/context/task-attempt-context';
import { useTypeaheadOpen } from '@/components/ui/wysiwyg/context/typeahead-open-context';
import { TypeaheadMenu } from './typeahead-menu-components';

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
  query: string
): SlashCommandDescription[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;

  const startsWith = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const includes = all.filter(
    (c) => !startsWith.includes(c) && c.name.toLowerCase().includes(q)
  );
  return [...startsWith, ...includes];
}

export function SlashCommandTypeaheadPlugin({
  agent,
  repoId,
}: {
  agent: BaseCodingAgent | null;
  repoId?: string;
}) {
  const [editor] = useLexicalComposerContext();
  const portalContainer = usePortalContainer();
  const taskAttemptId = useTaskAttemptId();  const { setIsOpen } = useTypeaheadOpen();
  const [options, setOptions] = useState<SlashCommandOption[]>([]);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  const slashCommandsQuery = useSlashCommands(agent, {
    workspaceId: taskAttemptId,
    repoId,
  });
  const allCommands = useMemo(
    () => slashCommandsQuery.commands ?? [],
    [slashCommandsQuery.commands]
  );
  const isLoading = !slashCommandsQuery.isInitialized && !!agent;
  const isDiscovering = slashCommandsQuery.discovering;

  const menuOptions = useMemo(() => {
    if (!agent || activeQuery === null) {
      return [] as SlashCommandOption[];
    }

    if (isLoading || isDiscovering) {
      return [new SlashCommandOption(null, 'loading')];
    }

    if (options.length === 0) {
      return [new SlashCommandOption(null, 'empty')];
    }

    return options;
  }, [activeQuery, agent, isDiscovering, isLoading, options]);

  const updateOptions = useCallback(
    (query: string | null) => {
      setActiveQuery(query);

      if (!agent || query === null) {
        setOptions([]);
        return;
      }

      const filtered = filterSlashCommands(allCommands, query).slice(0, 50);
      setOptions(filtered.map((c) => new SlashCommandOption(c)));
    },
    [agent, allCommands]
  );

  const hasVisibleResults = useMemo(() => {
    if (!agent || activeQuery === null) return false;
    if (isLoading || isDiscovering) return true;
    if (!activeQuery.trim()) return true;
    return options.length > 0;
  }, [agent, activeQuery, isDiscovering, isLoading, options.length]);

  // If command list loads while menu is open, refresh options.
  useEffect(() => {
    if (activeQuery === null) return;
    updateOptions(activeQuery);
  }, [activeQuery, updateOptions]);

  return (
    <LexicalTypeaheadMenuPlugin<SlashCommandOption>
      triggerFn={(text) => {
        const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
        if (!match) return null;

        const fullMatch = match[0];
        const slashOffset = text.length - fullMatch.length + fullMatch.indexOf('/');
        return {
          leadOffset: slashOffset,
          matchingString: match[1],
          replaceableString: fullMatch.slice(fullMatch.indexOf('/')),
        };
      }}
      options={menuOptions}
      onQueryChange={updateOptions}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        const selectedCommand = option.command;
        if (!selectedCommand) {
          return;
        }

        editor.update(() => {
          if (!nodeToReplace) return;

          // Insert a compact slash command chip (DecoratorNode)
          const commandNode = $createSlashCommandNode({
            commandName: selectedCommand.name,
            description: selectedCommand.description ?? undefined,
          });
          nodeToReplace.replace(commandNode);

          // Add a trailing space after the chip for continued typing
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
        if (!agent) return null;
        if (!hasVisibleResults) return null;

        const commandOptions = menuOptions.flatMap((option) =>
          option.command ? [{ option, command: option.command }] : []
        );
        const metaState = menuOptions.find((option) => option.meta)?.meta ?? null;
        const isEmpty =
          metaState === 'empty' ||
          (!isLoading && !isDiscovering && allCommands.length === 0);
        const showLoadingRow = isLoading || isDiscovering;
        const loadingText = isLoading
          ? 'Loading commands…'
          : 'Discovering commands…';

        return createPortal(
          <TypeaheadMenu anchorEl={anchorRef.current}>
            <TypeaheadMenu.Header>
              <CommandIcon className="h-3.5 w-3.5" />
              {'命令'}
            </TypeaheadMenu.Header>

            {isEmpty ? (
              <TypeaheadMenu.Empty>
                {'此代理没有可用的命令。'}
              </TypeaheadMenu.Empty>
            ) : commandOptions.length === 0 && !showLoadingRow ? null : (
              <TypeaheadMenu.ScrollArea>
                {showLoadingRow && (
                  <div className="px-3 py-2 text-sm text-muted-foreground select-none">
                    {loadingText}
                  </div>
                )}
                {commandOptions.map(({ option, command }, index) => {
                  const details = command.description ?? null;

                  return (
                    <TypeaheadMenu.Item
                      key={option.key}
                      isSelected={index === selectedIndex}
                      index={index}
                      setHighlightedIndex={setHighlightedIndex}
                      onClick={() => selectOptionAndCleanUp(option)}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        <span className="font-mono">
                          /{command.name}
                        </span>
                      </div>
                      {details && (
                        <div className="text-xs mt-0.5 truncate text-muted-foreground">
                          {details}
                        </div>
                      )}
                    </TypeaheadMenu.Item>
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
