import { useQuery } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, ExecutorProfileId } from 'shared/types';

import { getAgentName } from '@/components/agents/AgentIcon';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import {
  ComposerEngineHandoffModal,
  ComposerProviderInstanceSlot,
  useComposerEngineHandoff,
} from '@/components/tasks/follow-up/ComposerEngineHandoffControl';
import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  reconcilePendingConfigValues,
  reconcilePendingMode,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { agentsApi } from '@/features/agents/api';
import {
  composerSessionControlDisplay,
  liveSessionControlsSnapshot,
  loadAgentSessionControlsCatalog,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from '@/features/agents/sessionControlsQuery';
import {
  useSelectableAgents,
  type SelectableAgent,
} from '@/features/agents/useSelectableAgents';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  canonicalSessionAgentId,
  SESSION_AGENT_SWITCHED_EVENT,
  type SessionAgentSwitchedDetail,
} from '@/lib/sessionQueryCache';

import { collaborationCall } from '../collaborationApi';
import { useCollaborationSpacePick } from './SpaceContext';

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function configField(
  config: Record<string, unknown> | null,
  ...keys: string[]
): string {
  if (!config) return '';
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

const BOT_SPACE_SESSION_SETTINGS_PICK_KEYS = [
  'activeBotConversationId',
  'activeBotTimeline',
  'activeDirectThreadId',
  'agents',
  'conversationById',
  'draftMemberMetaByConvId',
  'identityMemberIdByConversation',
  'loadRolesAndAgents',
  'refreshSidebar',
  'sidebarItems',
  'visibleRoster',
] as const;

export const BotSpaceSessionSettings = memo(function BotSpaceSessionSettings({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const {
    activeBotConversationId,
    activeBotTimeline,
    activeDirectThreadId,
    agents,
    conversationById,
    draftMemberMetaByConvId,
    identityMemberIdByConversation,
    loadRolesAndAgents,
    refreshSidebar,
    sidebarItems,
    visibleRoster,
  } = useCollaborationSpacePick(BOT_SPACE_SESSION_SETTINGS_PICK_KEYS);

  const optionalUserSystem = useOptionalUserSystem();
  const profiles = useMemo(
    () => optionalUserSystem?.profiles ?? {},
    [optionalUserSystem?.profiles]
  );

  const managementSelectableAgents = useSelectableAgents();
  useEffect(() => {
    if (managementSelectableAgents.length === 0 && agents.length === 0) {
      void loadRolesAndAgents();
    }
  }, [agents.length, loadRolesAndAgents, managementSelectableAgents.length]);

  const sidebarMember = useMemo(
    () =>
      activeDirectThreadId
        ? sidebarItems?.find((item) => item.thread_id === activeDirectThreadId)
            ?.member
        : undefined,
    [activeDirectThreadId, sidebarItems]
  );

  const memberId = useMemo(() => {
    const fromSidebar = String(sidebarMember?.member_id ?? '').trim();
    if (fromSidebar) return fromSidebar;
    const fromRoster = String(visibleRoster[0]?.member_id ?? '').trim();
    if (fromRoster) return fromRoster;
    if (activeBotConversationId) {
      const fromIdentity = String(
        identityMemberIdByConversation.get(activeBotConversationId) ?? ''
      ).trim();
      if (fromIdentity) return fromIdentity;
    }
    return '';
  }, [
    activeBotConversationId,
    identityMemberIdByConversation,
    sidebarMember?.member_id,
    visibleRoster,
  ]);

  const [configAgentId, setConfigAgentId] = useState('');
  const [switchedAgentId, setSwitchedAgentId] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [selectedConfigValues, setSelectedConfigValues] = useState<
    Record<string, string>
  >({});
  const personaPromptRef = useRef<string | null>(null);

  const botTargetKey = `${memberId}::${activeBotConversationId}`;
  useEffect(() => {
    setConfigAgentId('');
    setSwitchedAgentId(null);
    setSelectedMode(null);
    setSelectedConfigValues({});
    personaPromptRef.current = null;
  }, [botTargetKey]);

  useEffect(() => {
    if (!memberId) return;
    let active = true;

    const loadMemberConfig = () => {
      void collaborationCall<{ config?: Record<string, unknown> | null }>(
        'collaboration',
        'member.config.get',
        { memberId }
      )
        .then((page) => {
          if (!active) return;
          const config = page.config ?? null;
          const nextAgent = configField(config, 'agent_id', 'agentId');
          const nextMode = configField(config, 'mode_id', 'modeId');
          const nextValues = stringRecord(
            config?.config_values ?? config?.configValues
          );
          personaPromptRef.current = configField(
            config,
            'persona_prompt',
            'personaPrompt'
          );
          if (nextAgent) setConfigAgentId(nextAgent);
          setSelectedMode(nextMode || null);
          setSelectedConfigValues(nextValues);
        })
        .catch(() => undefined);
    };

    loadMemberConfig();

    const onAgentSwitched = (event: Event) => {
      const detail = (event as CustomEvent<SessionAgentSwitchedDetail>).detail;
      if (
        !detail?.agentId ||
        !activeBotConversationId ||
        detail.sessionId !== activeBotConversationId
      ) {
        return;
      }
      const nextCanonical = canonicalSessionAgentId(detail.agentId);
      setSwitchedAgentId((prev) => {
        if (prev && canonicalSessionAgentId(prev) !== nextCanonical) {
          setSelectedMode(null);
          setSelectedConfigValues({});
        }
        return nextCanonical;
      });
      loadMemberConfig();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(SESSION_AGENT_SWITCHED_EVENT, onAgentSwitched);
    }
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener(
          SESSION_AGENT_SWITCHED_EVENT,
          onAgentSwitched
        );
      }
    };
  }, [activeBotConversationId, memberId]);

  const rawAgentId = useMemo(() => {
    if (switchedAgentId) return switchedAgentId;
    if (configAgentId) return configAgentId;
    if (activeBotConversationId) {
      const fromConv = conversationById.get(activeBotConversationId)?.agent_id;
      if (fromConv) return fromConv;
      const fromDraft = draftMemberMetaByConvId[activeBotConversationId]?.agentId;
      if (fromDraft) return fromDraft;
    }
    const fromSidebar = String(sidebarMember?.agent ?? '').trim();
    if (fromSidebar) return fromSidebar;
    const fromRoster = String(visibleRoster[0]?.agent ?? '').trim();
    if (fromRoster) return fromRoster;
    return agents[0]?.agent_id ?? '';
  }, [
    activeBotConversationId,
    agents,
    configAgentId,
    conversationById,
    draftMemberMetaByConvId,
    sidebarMember?.agent,
    switchedAgentId,
    visibleRoster,
  ]);

  const effectiveAgentId = useMemo(
    () => (rawAgentId ? canonicalSessionAgentId(rawAgentId) : ''),
    [rawAgentId]
  );

  const selectableAgents = useMemo<SelectableAgent[]>(() => {
    if (managementSelectableAgents.length > 0) {
      return managementSelectableAgents;
    }
    return agents.map((agent) => ({
      agentId: agent.agent_id as AgentId,
      displayName:
        getAgentName(agent.agent_id) || agent.name || agent.agent_id,
      iconLight: null,
      iconDark: null,
      iconSvg: null,
      enabled: true,
      lifecycle: 'ready',
      runnable: true,
      settingsFeatures: [],
    }));
  }, [agents, managementSelectableAgents]);

  const currentAgentIcons = useMemo(() => {
    if (!effectiveAgentId) return null;
    return (
      selectableAgents.find(
        (agent) =>
          agent.agentId === effectiveAgentId ||
          canonicalSessionAgentId(agent.agentId) === effectiveAgentId
      ) ?? null
    );
  }, [effectiveAgentId, selectableAgents]);

  const catalogQuery = useQuery({
    queryKey: sessionControlsQueryKey(
      effectiveAgentId || null,
      activeBotConversationId || null
    ),
    queryFn: () => loadAgentSessionControlsCatalog(effectiveAgentId),
    enabled: Boolean(effectiveAgentId),
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });

  const schemaQuery = useQuery({
    queryKey: sessionControlsSchemaQueryKey(effectiveAgentId || null),
    queryFn: () => loadAgentSessionControlsCatalog(effectiveAgentId),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  const catalogFreshnessQuery = useQuery({
    queryKey: ['agentCapabilityCatalogFreshness', effectiveAgentId],
    queryFn: () => agentsApi.capabilityCatalogFresh(effectiveAgentId),
    enabled: Boolean(effectiveAgentId && catalogQuery.data),
    staleTime: 0,
    retry: false,
  });

  const backgroundRefreshAgent = useRef<string | null>(null);
  useEffect(() => {
    if (
      !effectiveAgentId ||
      catalogFreshnessQuery.data !== false ||
      backgroundRefreshAgent.current === effectiveAgentId
    ) {
      return;
    }
    backgroundRefreshAgent.current = effectiveAgentId;
    void agentsApi
      .refreshCapabilityCatalog(effectiveAgentId)
      .then(async (refreshed) => {
        if (!refreshed) return;
        await catalogQuery.refetch();
        await catalogFreshnessQuery.refetch();
      })
      .catch(() => undefined);
  }, [catalogFreshnessQuery, catalogQuery, effectiveAgentId]);

  useEffect(() => {
    backgroundRefreshAgent.current = null;
  }, [effectiveAgentId]);

  const displayControls = useMemo(
    () =>
      composerSessionControlDisplay([
        activeBotConversationId
          ? liveSessionControlsSnapshot(
              activeBotTimeline?.sessionModes ?? { current: null, modes: [] },
              activeBotTimeline?.sessionConfigOptions ?? []
            )
          : null,
        catalogQuery.data,
        schemaQuery.data,
      ]),
    [
      activeBotConversationId,
      activeBotTimeline?.sessionConfigOptions,
      activeBotTimeline?.sessionModes,
      catalogQuery.data,
      schemaQuery.data,
    ]
  );

  const displaySessionModes = displayControls.sessionModes;
  const displaySessionConfigOptions = useMemo(
    () => visibleSessionConfigOptions(displayControls.sessionConfigOptions),
    [displayControls.sessionConfigOptions]
  );

  useEffect(() => {
    if (!activeBotConversationId) return;
    setSelectedConfigValues((previous) =>
      reconcilePendingConfigValues(displaySessionConfigOptions, previous)
    );
  }, [activeBotConversationId, displaySessionConfigOptions]);

  useEffect(() => {
    if (!activeBotConversationId) return;
    setSelectedMode((previous) =>
      reconcilePendingMode(displaySessionModes.current, previous)
    );
  }, [activeBotConversationId, displaySessionModes.current]);

  const effectiveConfigOverrides = useMemo(() => {
    const presentable = presentableSessionConfigOptions(
      displaySessionConfigOptions,
      displaySessionModes.modes
    );
    const presentableKeys = new Set(presentable.map((option) => option.key));
    const advertised = advertisedSessionConfigValues(
      displaySessionConfigOptions
    );
    const sanitized = sanitizeDependentConfigValues(
      displaySessionConfigOptions,
      {
        ...advertised,
        ...selectedConfigValues,
      }
    );
    return Object.fromEntries(
      Object.entries(sanitized).filter(
        ([key]) =>
          presentableKeys.has(key) && key in selectedConfigValues
      )
    );
  }, [displaySessionConfigOptions, displaySessionModes.modes, selectedConfigValues]);

  const persistMemberConfig = useCallback(
    async (next: {
      agentId?: string;
      modeId: string;
      configValues: Record<string, string>;
    }) => {
      if (!memberId) return;
      try {
        if (personaPromptRef.current === null) {
          const current = await collaborationCall<{
            config?: Record<string, unknown> | null;
          }>('collaboration', 'member.config.get', { memberId }).catch(
            () => null
          );
          personaPromptRef.current = configField(
            current?.config ?? null,
            'persona_prompt',
            'personaPrompt'
          );
        }
        await collaborationCall('collaboration', 'member.config.update', {
          memberId,
          ...(next.agentId ? { agentId: next.agentId } : {}),
          modeId: next.modeId,
          configValues: next.configValues,
          personaPrompt: personaPromptRef.current ?? '',
        });
      } catch {
        // Ignore persistence errors when capability is unavailable in mock/offline contexts
      }
    },
    [memberId]
  );

  const effectiveExecutorProfile = useMemo<ExecutorProfileId | null>(
    () =>
      effectiveAgentId
        ? {
            executor: effectiveAgentId as ExecutorProfileId['executor'],
            variant: null,
          }
        : null,
    [effectiveAgentId]
  );

  const handleApplyExecutorProfile = useCallback(
    (nextProfile: ExecutorProfileId | null) => {
      if (!nextProfile) return;
      const nextAgent = canonicalSessionAgentId(nextProfile.executor);
      setSwitchedAgentId(nextAgent);
      setConfigAgentId(nextAgent);
      setSelectedMode(null);
      setSelectedConfigValues({});
      if (!activeBotConversationId && memberId) {
        void persistMemberConfig({
          agentId: nextAgent,
          modeId: '',
          configValues: {},
        }).then(() => {
          void refreshSidebar();
        });
      }
    },
    [activeBotConversationId, memberId, persistMemberConfig, refreshSidebar]
  );

  const engineHandoff = useComposerEngineHandoff({
    sessionId: activeBotConversationId || null,
    hasExistingTurns: (activeBotTimeline?.timeline?.length ?? 0) > 0,
    currentExecutor: effectiveAgentId || null,
    onApplyExecutorProfile: handleApplyExecutorProfile,
  });

  const handleSelectExecutorProfile = useCallback(
    (profile: ExecutorProfileId) => {
      engineHandoff.handleChangeExecutorProfile(profile);
    },
    [engineHandoff]
  );

  const agentRail = useMemo(
    () => ({
      profiles,
      effectiveExecutorProfile,
      onChangeExecutorProfile: handleSelectExecutorProfile,
      selectableAgents,
    }),
    [
      effectiveExecutorProfile,
      handleSelectExecutorProfile,
      profiles,
      selectableAgents,
    ]
  );

  const handleSelectMode = useCallback(
    (modeId: string) => {
      setSelectedMode(modeId);
      void persistMemberConfig({
        modeId,
        configValues: effectiveConfigOverrides,
      });
      if (activeBotConversationId) {
        void conversationApi
          .setSessionMode({
            conversationId: activeBotConversationId,
            modeId,
          })
          .catch(() => undefined);
      }
    },
    [activeBotConversationId, effectiveConfigOverrides, persistMemberConfig]
  );

  const handleSelectConfigOption = useCallback(
    (key: string, value: string) => {
      const nextMode = selectedMode || displaySessionModes.current || '';
      if (!selectedMode && displaySessionModes.current) {
        setSelectedMode(displaySessionModes.current);
      }
      const nextValues = selectConfigOptionValue(
        displaySessionConfigOptions,
        effectiveConfigOverrides,
        key,
        value
      );
      const accepted = nextValues[key] === value;
      setSelectedConfigValues(nextValues);
      if (!accepted) return;
      void persistMemberConfig({
        modeId: nextMode,
        configValues: nextValues,
      });
      if (activeBotConversationId) {
        void conversationApi
          .setSessionConfigOption({
            conversationId: activeBotConversationId,
            key,
            value,
          })
          .catch(() => undefined);
      }
    },
    [
      activeBotConversationId,
      displaySessionConfigOptions,
      displaySessionModes.current,
      effectiveConfigOverrides,
      persistMemberConfig,
      selectedMode,
    ]
  );

  if (!effectiveAgentId && selectableAgents.length === 0) {
    return null;
  }

  return (
    <>
      <ComposerProviderInstanceSlot
        agentId={effectiveAgentId || null}
        disabled={disabled}
      />
      <SessionSettingsSummary
        sessionModes={displaySessionModes}
        selectedMode={selectedMode}
        onSelectMode={handleSelectMode}
        options={displaySessionConfigOptions}
        pending={effectiveConfigOverrides}
        onSelectConfigOption={handleSelectConfigOption}
        disabled={disabled}
        dropdownAlign="end"
        agentIcon={effectiveAgentId || null}
        agentIconLight={currentAgentIcons?.iconLight ?? null}
        agentIconDark={currentAgentIcons?.iconDark ?? null}
        agentIconSvg={currentAgentIcons?.iconSvg ?? null}
        agentRail={agentRail}
        controlsLoading={catalogQuery.isLoading}
      />
      <ComposerEngineHandoffModal controller={engineHandoff} />
    </>
  );
});
