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
  const [selectedInstanceByAgent, setSelectedInstanceByAgent] = useState<
    Record<string, string>
  >({});
  const personaPromptRef = useRef<string | null>(null);
  const persistedConfigValuesRef = useRef<Record<string, string>>({});
  const persistedModeRef = useRef<string | null>(null);
  const switchedAgentIdRef = useRef<string | null>(null);
  const configLoadSeqRef = useRef(0);
  const effectiveAgentIdRef = useRef('');

  const botTargetKey = `${memberId}::${activeBotConversationId}`;
  useEffect(() => {
    setConfigAgentId('');
    setSwitchedAgentId(null);
    switchedAgentIdRef.current = null;
    setSelectedMode(null);
    setSelectedConfigValues({});
    setSelectedInstanceByAgent({});
    persistedConfigValuesRef.current = {};
    persistedModeRef.current = null;
    personaPromptRef.current = null;
    configLoadSeqRef.current += 1;
  }, [botTargetKey]);

  useEffect(() => {
    if (!memberId) return;
    let active = true;

    const loadMemberConfig = () => {
      const seq = ++configLoadSeqRef.current;
      void collaborationCall<{ config?: Record<string, unknown> | null }>(
        'collaboration',
        'member.config.get',
        { memberId }
      )
        .then((page) => {
          if (!active || seq !== configLoadSeqRef.current) return;
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

          const expectedSwitched = switchedAgentIdRef.current;
          if (
            expectedSwitched &&
            (!nextAgent ||
              canonicalSessionAgentId(nextAgent) !==
                canonicalSessionAgentId(expectedSwitched))
          ) {
            return;
          }

          if (nextAgent) setConfigAgentId(nextAgent);
          persistedModeRef.current = nextMode || null;
          persistedConfigValuesRef.current = nextValues;
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
      const prevCanonical = effectiveAgentIdRef.current
        ? canonicalSessionAgentId(effectiveAgentIdRef.current)
        : '';
      if (prevCanonical !== nextCanonical) {
        setSelectedMode(null);
        setSelectedConfigValues({});
        persistedConfigValuesRef.current = {};
        persistedModeRef.current = null;
      }
      switchedAgentIdRef.current = nextCanonical;
      effectiveAgentIdRef.current = nextCanonical;
      setSwitchedAgentId(nextCanonical);
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
  effectiveAgentIdRef.current = effectiveAgentId;

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
  const currentDisplayMode = displaySessionModes.current;
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
      reconcilePendingMode(currentDisplayMode, previous)
    );
  }, [activeBotConversationId, currentDisplayMode]);

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

  const mergePersistedConfigValues = useCallback(
    (
      base: Record<string, string>,
      overrides: Record<string, string>,
      changedKey?: string,
      changedValue?: string
    ): Record<string, string> => {
      const combined = { ...base, ...overrides };
      const visibleKeys = new Set(
        displaySessionConfigOptions.map((option) => option.key)
      );
      const preservedHidden = Object.fromEntries(
        Object.entries(combined).filter(([k]) => !visibleKeys.has(k))
      );
      const visibleSubset = Object.fromEntries(
        Object.entries(combined).filter(([k]) => visibleKeys.has(k))
      );
      const nextVisible =
        changedKey !== undefined && changedValue !== undefined
          ? selectConfigOptionValue(
              displaySessionConfigOptions,
              visibleSubset,
              changedKey,
              changedValue
            )
          : sanitizeDependentConfigValues(
              displaySessionConfigOptions,
              visibleSubset
            );
      return { ...preservedHidden, ...nextVisible };
    },
    [displaySessionConfigOptions]
  );

  const persistMemberConfig = useCallback(
    async (next: {
      agentId?: string;
      modeId: string;
      configValues: Record<string, string>;
    }) => {
      if (!memberId) return;
      try {
        let resolvedConfigValues = next.configValues;
        let resolvedModeId = next.modeId;
        if (personaPromptRef.current === null) {
          const current = await collaborationCall<{
            config?: Record<string, unknown> | null;
          }>('collaboration', 'member.config.get', { memberId });
          const currentConfig = current?.config ?? null;
          personaPromptRef.current = configField(
            currentConfig,
            'persona_prompt',
            'personaPrompt'
          );
          const serverValues = stringRecord(
            currentConfig?.config_values ?? currentConfig?.configValues
          );
          if (Object.keys(serverValues).length > 0 && !next.agentId) {
            resolvedConfigValues = { ...serverValues, ...next.configValues };
            persistedConfigValuesRef.current = resolvedConfigValues;
          }
          if (!resolvedModeId) {
            resolvedModeId = configField(currentConfig, 'mode_id', 'modeId');
          }
        }
        if (personaPromptRef.current === null) {
          return;
        }
        await collaborationCall('collaboration', 'member.config.update', {
          memberId,
          ...(next.agentId ? { agentId: next.agentId } : {}),
          modeId: resolvedModeId,
          configValues: resolvedConfigValues,
          personaPrompt: personaPromptRef.current,
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
      if (!nextProfile) {
        switchedAgentIdRef.current = null;
        setSwitchedAgentId(null);
        setSelectedMode(null);
        setSelectedConfigValues({});
        persistedConfigValuesRef.current = {};
        persistedModeRef.current = null;
        return;
      }
      const nextAgent = canonicalSessionAgentId(nextProfile.executor);
      const agentChanged = effectiveAgentIdRef.current !== nextAgent;
      switchedAgentIdRef.current = nextAgent;
      effectiveAgentIdRef.current = nextAgent;
      setSwitchedAgentId(nextAgent);
      setConfigAgentId(nextAgent);
      if (agentChanged) {
        setSelectedMode(null);
        setSelectedConfigValues({});
        persistedConfigValuesRef.current = {};
        persistedModeRef.current = null;
      }
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
      const nextPersistedValues = mergePersistedConfigValues(
        persistedConfigValuesRef.current,
        effectiveConfigOverrides
      );
      persistedModeRef.current = modeId;
      persistedConfigValuesRef.current = nextPersistedValues;
      void persistMemberConfig({
        modeId,
        configValues: nextPersistedValues,
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
    [
      activeBotConversationId,
      effectiveConfigOverrides,
      mergePersistedConfigValues,
      persistMemberConfig,
    ]
  );

  const handleSelectConfigOption = useCallback(
    (key: string, value: string) => {
      const nextMode =
        selectedMode || persistedModeRef.current || currentDisplayMode || '';
      if (!selectedMode && currentDisplayMode) {
        setSelectedMode(currentDisplayMode);
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
      const nextPersistedValues = mergePersistedConfigValues(
        persistedConfigValuesRef.current,
        effectiveConfigOverrides,
        key,
        value
      );
      persistedModeRef.current = nextMode || null;
      persistedConfigValuesRef.current = nextPersistedValues;
      void persistMemberConfig({
        modeId: nextMode,
        configValues: nextPersistedValues,
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
      currentDisplayMode,
      displaySessionConfigOptions,
      effectiveConfigOverrides,
      mergePersistedConfigValues,
      persistMemberConfig,
      selectedMode,
    ]
  );

  const selectedInstanceId = effectiveAgentId
    ? (selectedInstanceByAgent[effectiveAgentId] ?? null)
    : null;

  const handleSelectInstance = useCallback(
    (instanceId: string) => {
      if (!effectiveAgentId) return;
      setSelectedInstanceByAgent((prev) =>
        prev[effectiveAgentId] === instanceId
          ? prev
          : { ...prev, [effectiveAgentId]: instanceId }
      );
    },
    [effectiveAgentId]
  );

  if (!effectiveAgentId && selectableAgents.length === 0) {
    return null;
  }

  return (
    <>
      <ComposerProviderInstanceSlot
        agentId={effectiveAgentId || null}
        disabled={disabled}
        selectedInstanceId={selectedInstanceId}
        onSelectInstance={handleSelectInstance}
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
