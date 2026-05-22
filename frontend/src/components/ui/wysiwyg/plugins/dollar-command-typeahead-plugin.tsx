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
import { skillsApi, type AgentLocalSkill } from '@/lib/api';

import { $createDollarCommandNode } from '../nodes/dollar-command-node';
import { TypeaheadMenu } from './typeahead-menu-components';
import { matchDollarCommandTrigger } from './typeahead-triggers';

export type DollarCommandDescription = {
  name: string;
  description?: string;
};

export const DOLLAR_COMMANDS: DollarCommandDescription[] = [
  { name: 'autopilot', description: 'Run autonomous implementation workflow' },
  { name: 'plan', description: 'Start the planning workflow' },
  {
    name: 'deep-interview',
    description: 'Run the requirements interview workflow',
  },
  { name: 'ralplan', description: 'Run consensus planning' },
  { name: 'ralph', description: 'Run the completion loop workflow' },
  { name: 'ultrawork', description: 'Run high-throughput parallel workflow' },
  { name: 'ultraqa', description: 'Run persistent verification workflow' },
  { name: 'team', description: 'Run coordinated team workflow' },
  { name: 'swarm', description: 'Alias for coordinated team workflow' },
  { name: 'ecomode', description: 'Run cost-aware workflow mode' },
  { name: 'cancel', description: 'Cancel an active workflow mode' },
  { name: 'trace', description: 'Show orchestration trace state' },
  { name: 'note', description: 'Save a durable session note' },
  { name: 'help', description: 'Show oh-my-codex help' },
  { name: 'doctor', description: 'Diagnose oh-my-codex installation issues' },
  { name: 'hud', description: 'Show or configure the OMX HUD' },
  { name: 'tdd', description: 'Run a test-first workflow' },
  { name: 'fix-build', description: 'Fix build or type errors' },
  { name: 'analyze', description: 'Run root-cause analysis' },
  { name: 'code-review', description: 'Request a code review workflow' },
  {
    name: 'security-review',
    description: 'Request a security review workflow',
  },
  { name: 'ai-slop-cleaner', description: 'Run cleanup and refactor workflow' },
  { name: 'web-clone', description: 'Start the web clone workflow' },
  { name: 'visual-verdict', description: 'Run structured visual QA' },
  { name: 'ask-claude', description: 'Ask Claude through the local CLI' },
  { name: 'ask-gemini', description: 'Ask Gemini through the local CLI' },
  { name: 'configure-notifications', description: 'Configure notifications' },
  { name: 'browser-use', description: 'Use the in-app browser workflow' },
  { name: 'openai-docs', description: 'Look up official OpenAI docs' },
  { name: 'shadcn', description: 'Work with shadcn/ui components' },
  { name: 'skill', description: 'Manage local Codex skills' },
  { name: 'skill-installer', description: 'Install Codex skills' },
  { name: 'skill-creator', description: 'Create or improve a Codex skill' },
  { name: 'plugin-creator', description: 'Create a local Codex plugin' },
];

function skillsToDollarCommands(
  skills: AgentLocalSkill[]
): DollarCommandDescription[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description ?? `Local Codex skill: ${skill.path}`,
  }));
}

function mergeDollarCommands(
  staticCommands: DollarCommandDescription[],
  skillCommands: DollarCommandDescription[]
): DollarCommandDescription[] {
  const seen = new Set<string>();
  const commands: DollarCommandDescription[] = [];

  for (const command of [...staticCommands, ...skillCommands]) {
    const name = command.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    commands.push({ ...command, name });
  }

  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

class DollarCommandOption extends MenuOption {
  command: DollarCommandDescription;

  constructor(command: DollarCommandDescription) {
    super(`dollar-command-${command.name}`);
    this.command = command;
  }
}

function filterDollarCommands(
  all: DollarCommandDescription[],
  query: string
): DollarCommandDescription[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;

  const startsWith = all.filter((command) =>
    command.name.toLowerCase().startsWith(q)
  );
  const includes = all.filter(
    (command) =>
      !startsWith.includes(command) && command.name.toLowerCase().includes(q)
  );
  return [...startsWith, ...includes];
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
