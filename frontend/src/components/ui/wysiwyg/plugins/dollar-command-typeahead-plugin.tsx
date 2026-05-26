import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode } from 'lexical';
import { useQuery } from '@tanstack/react-query';

import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { useTypeaheadOpen } from '@/components/ui/wysiwyg/context/typeahead-open-context';
import { skillsApi } from '@/lib/api';
import {
  DOLLAR_COMMANDS,
  filterDollarCommands,
  mergeDollarCommands,
  skillsToDollarCommands,
  type DollarCommandDescription,
} from '@/lib/dollarCommands';

import { $createDollarCommandNode } from '../nodes/dollar-command-node';
import { TypeaheadMenu } from './typeahead-menu-components';
import { matchDollarCommandTrigger } from './typeahead-triggers';

class DollarCommandOption extends MenuOption {
  command: DollarCommandDescription;

  constructor(command: DollarCommandDescription) {
    super(`dollar-command-${command.name}`);
    this.command = command;
  }
}

export function DollarCommandTypeaheadPlugin() {
  const [editor] = useLexicalComposerContext();
  const portalContainer = usePortalContainer();
  const { setIsOpen } = useTypeaheadOpen();
  const isThisMenuOpenRef = useRef(false);
  const { data: localSkills = [], refetch: refetchLocalSkills } = useQuery({
    queryKey: ['local-agent-skills', 'CODEX'],
    queryFn: () => skillsApi.listLocal('CODEX'),
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  const allCommands = useMemo(
    () =>
      mergeDollarCommands(DOLLAR_COMMANDS, skillsToDollarCommands(localSkills)),
    [localSkills]
  );
  const [options, setOptions] = useState<DollarCommandOption[]>(
    allCommands.map((command) => new DollarCommandOption(command))
  );
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  const updateOptions = useCallback(
    (query: string | null) => {
      setActiveQuery(query);

      if (query === null) {
        setOptions([]);
        return;
      }

      const filtered = filterDollarCommands(allCommands, query).slice(0, 50);
      setOptions(filtered.map((command) => new DollarCommandOption(command)));
    },
    [allCommands]
  );

  useEffect(() => {
    if (activeQuery === null) return;
    updateOptions(activeQuery);
  }, [activeQuery, updateOptions]);

  const hasVisibleResults = useMemo(() => options.length > 0, [options.length]);

  return (
    <LexicalTypeaheadMenuPlugin<DollarCommandOption>
      triggerFn={matchDollarCommandTrigger}
      options={options}
      onQueryChange={updateOptions}
      onOpen={() => {
        isThisMenuOpenRef.current = true;
        setIsOpen(true);
        void refetchLocalSkills();
        updateOptions('');
      }}
      onClose={() => {
        if (isThisMenuOpenRef.current) {
          isThisMenuOpenRef.current = false;
          setIsOpen(false);
        }
        setActiveQuery(null);
        setOptions(
          allCommands.map((command) => new DollarCommandOption(command))
        );
      }}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        editor.update(() => {
          if (!nodeToReplace) return;

          const commandNode = $createDollarCommandNode({
            commandName: option.command.name,
            description: option.command.description,
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
        if (!anchorRef.current || !hasVisibleResults) return null;

        return createPortal(
          <TypeaheadMenu anchorEl={anchorRef.current}>
            <TypeaheadMenu.ScrollArea>
              {options.map((option, index) => (
                <TypeaheadMenu.Item
                  key={option.key}
                  isSelected={index === selectedIndex}
                  index={index}
                  setHighlightedIndex={setHighlightedIndex}
                  setRefElement={option.setRefElement}
                  onClick={() => selectOptionAndCleanUp(option)}
                >
                  <div className="font-medium">
                    <span className="font-mono">${option.command.name}</span>
                  </div>
                  {option.command.description && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {option.command.description}
                    </div>
                  )}
                </TypeaheadMenu.Item>
              ))}
            </TypeaheadMenu.ScrollArea>
          </TypeaheadMenu>,
          portalContainer ?? document.body
        );
      }}
    />
  );
}
