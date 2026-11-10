import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChatComposerToken } from '@astryxdesign/core/Chat';
import type {
  SearchableItem,
  SearchSource,
} from '@astryxdesign/core/Typeahead';
import { useSlashCommands } from '@vibex/plugin-sdk';
import { type AgentLocalSkill, type AgentSkillsListResult } from '@/lib/api';
import type { BackendTransport } from '@/lib/backendTransport';
import { createPluginApi, createPluginControlApi } from '@/lib/api/plugins';
import { DOLLAR_COMMANDS, mergeDollarCommands } from '@/lib/dollarCommands';
import {
  agentAvailableCommandsToSlashCommands,
  localSkillsToDollarCommands,
  mergeComposerSlashCommands,
  pluginComposerSlashContributions,
  pluginInvocationsToSlashCommands,
  sdkSlashCommandsToComposerCommands,
  slashCatalogReady,
} from '@/lib/conversation-rendering/commandSources';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import {
  agentMentionsToTypeaheadOptions,
  dollarCommandsToTypeaheadOptions,
  pluginActionsToTypeaheadOptions,
  slashCommandsToTypeaheadOptions,
} from '../sessionComposerTypeaheadOptions';
import { formatSessionComposerCommand } from '../sessionComposerStructuredTokens';
import { toSessionComposerChatToken } from '../SessionComposerStructuredText';
import type { AgentAvailableCommand } from '@/features/agents/types';
import {
  getTokenFromInsertText,
  toSearchableItem,
  type ComposerSearchItemData,
} from './composerSearch';
import { useAgentMentions } from '../AgentMention';

export function useSessionComposerCommands({
  transport,
  executor,
  workspacePath,
  availableCommands,
  commandsLoading,
  agentMentions,
}: {
  transport: BackendTransport;
  executor: string | null;
  workspacePath?: string;
  availableCommands: AgentAvailableCommand[] | null;
  commandsLoading: boolean;
  agentMentions: ReturnType<typeof useAgentMentions>;
}) {
  const pluginApi = useMemo(() => createPluginApi(transport), [transport]);
  const pluginControlApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const { data: pluginCatalog } = useQuery({
    queryKey: ['session-composer-plugin-actions', transport.environment],
    queryFn: () => pluginApi.catalog(),
    staleTime: 5_000,
  });
  const { data: pluginControlCatalog } = useQuery({
    queryKey: ['session-composer-plugin-control', transport.environment],
    queryFn: () => pluginControlApi.catalog(),
    staleTime: 5_000,
  });
  const composerSlashContributions =
    usePluginHostContributions('composer_slash');
  const sdkSlashCommands = useSlashCommands();
  const { data: agentSkills } = useQuery({
    queryKey: [
      'session-composer-agent-skills',
      transport.environment,
      executor,
      workspacePath,
    ],
    queryFn: () =>
      transport.call('list_agent_skills', {
        agentType: executor!,
        workspacePath: workspacePath ?? null,
      }) as Promise<AgentSkillsListResult>,
    enabled: executor === 'codex',
    staleTime: 0,
  });
  const hostedPluginSkillIds = useMemo(
    () => new Set(agentSkills?.skills.map((skill) => skill.id) ?? []),
    [agentSkills]
  );
  const localSkills = useMemo<AgentLocalSkill[]>(
    () =>
      (agentSkills?.skills ?? []).map((skill) => {
        const id = (skill.id ?? '').trim();
        return {
          name: id,
          description: skill.description,
          path: skill.path,
          invocation: executor === 'codex' ? `$${id}` : `/${id}`,
        };
      }),
    [agentSkills, executor]
  );
  const allSlashCommands = useMemo(
    () =>
      mergeComposerSlashCommands({
        catalogCommands: [],
        runtimeCommands: agentAvailableCommandsToSlashCommands(
          availableCommands ?? []
        ),
        skillCommands: [],
        pluginCommands: [
          ...sdkSlashCommandsToComposerCommands(sdkSlashCommands),
          ...pluginInvocationsToSlashCommands(pluginControlCatalog),
          ...pluginComposerSlashContributions(composerSlashContributions),
        ],
      }),
    [
      availableCommands,
      composerSlashContributions,
      pluginControlCatalog,
      sdkSlashCommands,
    ]
  );
  const allDollarCommands = useMemo(
    () =>
      mergeDollarCommands(
        DOLLAR_COMMANDS,
        localSkillsToDollarCommands(localSkills)
      ),
    [localSkills]
  );

  // --- Trigger search sources (adapted to the Astryx SearchSource contract) ---

  const liveCommandsReadyRef = useRef(
    slashCatalogReady(commandsLoading, allSlashCommands)
  );
  liveCommandsReadyRef.current = slashCatalogReady(
    commandsLoading,
    allSlashCommands
  );
  const allSlashCommandsRef = useRef(allSlashCommands);
  allSlashCommandsRef.current = allSlashCommands;
  const executorRef = useRef(executor);
  executorRef.current = executor;
  const liveCommandsWaitersRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (!slashCatalogReady(commandsLoading, allSlashCommands)) return;
    const waiters = liveCommandsWaitersRef.current;
    liveCommandsWaitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  }, [allSlashCommands, commandsLoading]);
  useEffect(() => {
    return () => {
      const waiters = liveCommandsWaitersRef.current;
      liveCommandsWaitersRef.current = [];
      waiters.forEach((resolve) => resolve());
    };
  }, []);

  const slashSource = useMemo<SearchSource>(
    () => ({
      search: async (query) => {
        if (!liveCommandsReadyRef.current) {
          await new Promise<void>((resolve) => {
            liveCommandsWaitersRef.current.push(resolve);
          });
        }
        return slashCommandsToTypeaheadOptions(
          allSlashCommandsRef.current,
          query,
          executorRef.current
        ).map(toSearchableItem);
      },
      bootstrap: async () => {
        if (!liveCommandsReadyRef.current) {
          await new Promise<void>((resolve) => {
            liveCommandsWaitersRef.current.push(resolve);
          });
        }
        return slashCommandsToTypeaheadOptions(
          allSlashCommandsRef.current,
          '',
          executorRef.current
        ).map(toSearchableItem);
      },
    }),
    []
  );
  const dollarSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        dollarCommandsToTypeaheadOptions(allDollarCommands, query).map(
          toSearchableItem
        ),
      bootstrap: () =>
        dollarCommandsToTypeaheadOptions(allDollarCommands, '').map(
          toSearchableItem
        ),
    }),
    [allDollarCommands]
  );
  const agentMentionSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        agentMentionsToTypeaheadOptions(agentMentions.candidates, query).map(
          toSearchableItem
        ),
      bootstrap: () =>
        agentMentionsToTypeaheadOptions(agentMentions.candidates, '').map(
          toSearchableItem
        ),
    }),
    [agentMentions.candidates]
  );
  const pluginSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        pluginActionsToTypeaheadOptions(
          pluginCatalog,
          query,
          hostedPluginSkillIds
        ).map(toSearchableItem),
      bootstrap: () =>
        pluginActionsToTypeaheadOptions(
          pluginCatalog,
          '',
          hostedPluginSkillIds
        ).map(toSearchableItem),
    }),
    [hostedPluginSkillIds, pluginCatalog]
  );
  const makeToken = useCallback((item: SearchableItem): ChatComposerToken => {
    const data = item.auxiliaryData as ComposerSearchItemData | undefined;
    let insertText = data?.insertText ?? '';
    if (data?.execute) {
      try {
        const execResult = data.execute('');
        if (typeof execResult === 'string' && execResult.trim()) {
          const existingToken = getTokenFromInsertText(insertText);
          if (existingToken) {
            insertText = formatSessionComposerCommand({
              type: '/',
              key: `${existingToken.kind}:${existingToken.label}`,
              value: execResult,
            });
          } else {
            insertText = execResult;
          }
        } else if (
          typeof execResult === 'object' &&
          execResult !== null &&
          'then' in execResult
        ) {
          void execResult.catch(() => undefined);
        }
      } catch {
        // Isolate plugin slash execute errors
      }
    }
    const token = getTokenFromInsertText(insertText);
    if (token) {
      return { ...toSessionComposerChatToken(token), value: insertText };
    }
    return {
      value: insertText,
      label: item.label,
      variant: 'neutral',
    };
  }, []);
  const pluginOnSelect = useCallback((item: SearchableItem): string => {
    const insertText =
      (item.auxiliaryData as { insertText?: string } | undefined)?.insertText ??
      '';
    return insertText;
  }, []);

  return {
    slashSource,
    dollarSource,
    agentMentionSource,
    pluginSource,
    makeToken,
    pluginOnSelect,
  };
}
