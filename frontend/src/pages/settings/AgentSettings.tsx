import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthModeView,
  AgentDiagnosticView,
  AgentId,
  AgentManagementActionsView,
  AgentNativeConfigView,
  AgentOperationKind,
  AgentPreflightView,
  AgentRegistryView,
  AgentRegistryViewRow,
  AgentUpdateCheckView,
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
} from 'shared/types';

import { useUserSystem } from '@/components/ConfigProvider';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
  type AgentOperationState,
  useAgentManagement,
} from '@/features/agent-management';
import {
  invalidateAgentAcpUpdate,
  readCachedAgentAcpUpdate,
  recordAgentAcpUpdateCheck,
} from '@/features/agent-management/agentAcpUpdates';
import { consumeAgentSettingsFocus } from '@/features/agent-management/agentSettingsFocus';
import { agentHasAcpUpdate } from '@/features/agent-management/agentVersion';

import { AgentBar } from './AgentBar';
import { defaultAgentIdFromOrder, sortAgentsForBar } from './agentBarOrder';
import { AgentInstanceSwitcher } from './AgentInstanceSwitcher';
import {
  isAuthPreflightItem,
  mergePreflightItems,
  overlayAuthPreflightItems,
  presentPreflightItems,
  readPreflightSnapshot,
  writePreflightSnapshot,
} from './agentPreflightSnapshot';
import {
  agentProvisioningAction,
  isAgentSettingsLocked,
  isNativeEngineAgent,
  isPrimaryRuntimePreflightItem,
} from './agentProvisioning';
import { AgentModelMarketIntroDialog } from './AgentModelMarketIntroDialog';
import { AgentRegistryViewPanel } from './AgentRegistryView';
import { AgentSettingsDetailSections } from './AgentSettingsDetailSections';
import { AgentSettingsLoading } from './AgentSettingsLoading';
import {
  applyCachedUpdateToPreflight,
  applyInstallationToPreflight,
  applyUpdateCheckToPreflight,
} from './agentSettingsPreflightHelpers';
import type { PluginEcosystem } from './PluginsSettings';
import { useAgentAccountFlowWatcher } from './useAgentAccountFlowWatcher';
import {
  agentInspectCacheKey,
  type ConfigConflictState,
  useAgentNativeConfigActions,
} from './useAgentNativeConfigActions';
import {
  deriveCustomInstanceAuthStatus,
  useAgentProviderInstances,
} from './useAgentProviderInstances';
import {
  MODEL_ROUTER_IMPORT_EVENT,
  type PendingModelRouterImport,
  useAgentModelRouterImport,
} from './useAgentModelRouterImport';
import { useUnsavedAgentSettingsGuard } from './useUnsavedAgentSettingsGuard';

export { MODEL_ROUTER_IMPORT_EVENT, type PendingModelRouterImport };

export function AgentSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config: userConfig, updateAndSaveConfig } = useUserSystem();
  const management = useAgentManagement();
  const [focusDiagnostics, setFocusDiagnostics] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [providerRefreshKey, setProviderRefreshKey] = useState(0);
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<AgentPreflightView | null>(null);
  const [actions, setActions] = useState<AgentManagementActionsView | null>(
    null
  );
  const [checking, setChecking] = useState(false);
  const [config, setConfig] = useState<AgentNativeConfigView | null>(null);
  const [diagnostics, setDiagnostics] = useState<AgentDiagnosticView[]>([]);
  const [environmentDiagnosticsAgentId, setEnvironmentDiagnosticsAgentId] =
    useState<AgentId | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configConflict, setConfigConflict] =
    useState<ConfigConflictState>(null);
  const [updateCheck, setUpdateCheck] = useState<AgentUpdateCheckView | null>(
    null
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [enablingOperation, setEnablingOperation] = useState<
    (AgentOperationState & { agentId: AgentId }) | null
  >(null);
  const [userDefinition, setUserDefinition] =
    useState<UserAgentDefinitionView | null>(null);
  const [savingUserDefinition, setSavingUserDefinition] = useState(false);
  const [nativePluginsExpanded, setNativePluginsExpanded] = useState(false);
  const [pluginCount, setPluginCount] = useState(0);

  const selectedAgent = management.selectedAgent;
  const selectedAgentId = selectedAgent?.agent_id ?? null;
  const { setDirtySource, confirmDiscardConfig, resetDirty } =
    useUnsavedAgentSettingsGuard(selectedAgentId, t);
  const providerInstances = useAgentProviderInstances({
    selectedAgentId,
    confirmDiscardConfig,
  });
  const activeProviderInstanceId = providerInstances.activeProviderInstanceId;
  const isCustomInstance = providerInstances.isCustomInstance;
  const inspectKey = selectedAgentId
    ? agentInspectCacheKey(selectedAgentId, activeProviderInstanceId)
    : null;
  const [customAuthView, setCustomAuthView] =
    useState<AgentAuthModeView | null>(null);
  const authenticationOverride = isCustomInstance
    ? deriveCustomInstanceAuthStatus(customAuthView)
    : undefined;
  const selectAgent = management.select;
  useEffect(() => {
    setCustomAuthView(null);
    resetDirty();
  }, [inspectKey, resetDirty]);
  useEffect(() => {
    const applyFocus = () => {
      const focus = consumeAgentSettingsFocus();
      if (!focus) return;
      selectAgent(focus.agentId);
      setFocusDiagnostics(focus.focusDiagnostics);
      setRegistryOpen(false);
    };
    applyFocus();
    window.addEventListener('focus', applyFocus);
    return () => window.removeEventListener('focus', applyFocus);
  }, [selectAgent]);
  useEffect(() => {
    setPluginCount(0);
    setNativePluginsExpanded(false);
  }, [selectedAgentId]);
  const liveConfig = config?.agent_id === selectedAgentId ? config : null;
  const hasAuthenticationMode = Boolean(
    selectedAgent?.settings_features?.includes('authentication_mode') ||
      liveConfig?.settings_features.includes('authentication_mode')
  );
  const selectedAgentSource = selectedAgent?.source ?? null;
  const selectedAgentLifecycle = selectedAgent?.lifecycle ?? null;
  const selectedAgentOperation = selectedAgent?.active_operation ?? null;
  const selectedPreflightItems =
    preflight?.agent_id === selectedAgentId ? preflight.items : [];
  const agentLocked = isAgentSettingsLocked(
    selectedAgent,
    selectedPreflightItems
  );
  const nativePluginEcosystem: PluginEcosystem | null =
    selectedAgentId === 'codex'
      ? 'codex'
      : selectedAgentId === 'claude_code'
        ? 'claude_code'
        : null;
  const refreshManagement = management.refresh;
  const authRefreshGeneration = useRef(0);
  const inspectGeneration = useRef(0);
  const inspectCacheRef = useRef({
    config: new Map<string, AgentNativeConfigView>(),
    actions: new Map<string, AgentManagementActionsView>(),
    diagnostics: new Map<AgentId, AgentDiagnosticView[]>(),
    updateCheck: new Map<AgentId, AgentUpdateCheckView>(),
  });

  const loadRegistry = useCallback(
    async (forceRefresh = false) => {
      setRegistryLoading(true);
      try {
        const cached = await agentManagementApi.registry();
        setRegistry(cached);
        if (forceRefresh || !cached.fresh) {
          const refreshed = await agentManagementApi.refreshRegistry();
          setRegistry(refreshed);
          if (refreshed.refresh_error) {
            toast.warning(t('settings:agents.registryRefreshCached'));
          }
        }
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.registryLoadFailed'))
        );
      } finally {
        setRegistryLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!registryOpen || registry) return;
    void loadRegistry();
  }, [loadRegistry, registry, registryOpen]);

  useEffect(() => {
    if (!selectedAgentId || !inspectKey || registryOpen) return;
    let active = true;
    const watchId = ++inspectGeneration.current;
    const authGenAtStart = authRefreshGeneration.current;
    const cache = inspectCacheRef.current;
    setConfig(cache.config.get(inspectKey) ?? null);
    setActions(cache.actions.get(inspectKey) ?? null);
    setConfigConflict(null);
    if (isCustomInstance) {
      setPreflight(null);
      setDiagnostics([]);
      setUpdateCheck(null);
      setChecking(false);
      void Promise.allSettled([
        agentManagementApi.readConfig(
          selectedAgentId,
          activeProviderInstanceId
        ),
        agentManagementApi.actions(selectedAgentId, activeProviderInstanceId),
      ]).then(([configResult, actionsResult]) => {
        if (!active) return;
        if (configResult.status === 'fulfilled') {
          cache.config.set(inspectKey, configResult.value);
          setConfig(configResult.value);
        }
        if (actionsResult.status === 'fulfilled') {
          cache.actions.set(inspectKey, actionsResult.value);
          setActions(actionsResult.value);
        }
      });
      return () => {
        active = false;
      };
    }
    const cachedUpdateCheck = cache.updateCheck.get(selectedAgentId) ?? null;
    const cachedAcpUpdate = readCachedAgentAcpUpdate(selectedAgentId);
    const snapshot = readPreflightSnapshot(selectedAgentId);
    setPreflight(
      snapshot
        ? applyCachedUpdateToPreflight(
            snapshot,
            cachedAcpUpdate,
            cachedUpdateCheck
          )
        : null
    );
    setDiagnostics(cache.diagnostics.get(selectedAgentId) ?? []);
    setUpdateCheck(cachedUpdateCheck);
    setChecking(!snapshot);
    void (async () => {
      try {
        const report = await agentManagementApi.preflight(selectedAgentId);
        if (!active || inspectGeneration.current !== watchId) return;
        setPreflight((current) => {
          const base =
            authRefreshGeneration.current !== authGenAtStart && current
              ? overlayAuthPreflightItems(report, current)
              : report;
          const next = applyCachedUpdateToPreflight(
            base,
            readCachedAgentAcpUpdate(selectedAgentId),
            cache.updateCheck.get(selectedAgentId) ?? null
          );
          writePreflightSnapshot(next);
          return next;
        });
        setChecking(false);
        if (authRefreshGeneration.current === authGenAtStart) {
          await refreshManagement().catch(() => undefined);
        }
        if (!active || inspectGeneration.current !== watchId) return;
        const comparison =
          await agentManagementApi.checkUpdate(selectedAgentId);
        if (!active || inspectGeneration.current !== watchId) return;
        cache.updateCheck.set(selectedAgentId, comparison);
        recordAgentAcpUpdateCheck(comparison);
        setUpdateCheck(comparison);
        setPreflight((current) => {
          if (!current || current.agent_id !== selectedAgentId) return current;
          const next = applyUpdateCheckToPreflight(current, comparison);
          writePreflightSnapshot(next);
          return next;
        });
      } catch {
        return;
      } finally {
        if (active && inspectGeneration.current === watchId) {
          setChecking(false);
        }
      }
    })();
    void Promise.allSettled([
      agentManagementApi.readConfig(selectedAgentId),
      agentManagementApi.diagnostics(selectedAgentId),
      agentManagementApi.actions(selectedAgentId),
    ]).then(([configResult, diagnosticResult, actionsResult]) => {
      if (!active) return;
      if (configResult.status === 'fulfilled') {
        cache.config.set(inspectKey, configResult.value);
        setConfig(configResult.value);
      }
      if (diagnosticResult.status === 'fulfilled') {
        const unread = diagnosticResult.value.filter(
          (diagnostic) => !diagnostic.read
        );
        cache.diagnostics.set(selectedAgentId, unread);
        setDiagnostics(unread);
      }
      if (actionsResult.status === 'fulfilled') {
        cache.actions.set(inspectKey, actionsResult.value);
        setActions(actionsResult.value);
      }
    });
    return () => {
      active = false;
    };
  }, [
    activeProviderInstanceId,
    inspectKey,
    isCustomInstance,
    refreshManagement,
    registryOpen,
    selectedAgentId,
  ]);

  useEffect(() => {
    if (
      !selectedAgentId ||
      selectedAgentSource !== 'user_definition' ||
      registryOpen
    ) {
      setUserDefinition(null);
      return;
    }
    let active = true;
    setUserDefinition(null);
    void agentManagementApi
      .userDefinition(selectedAgentId)
      .then((definition) => {
        if (active) setUserDefinition(definition);
      })
      .catch((error) => {
        if (active) {
          toast.error(
            errorMessage(error, t('settings:agents.userDefinitionLoadFailed'))
          );
        }
      });
    return () => {
      active = false;
    };
  }, [
    registryOpen,
    selectedAgentId,
    selectedAgentLifecycle,
    selectedAgentOperation,
    selectedAgentSource,
    t,
  ]);

  useEffect(() => {
    if (!management.error) return;
    toast.error(
      errorMessage(management.error, t('settings:agents.loadFailed'))
    );
  }, [management.error, t]);

  const addAgent = useCallback(
    async (row: AgentRegistryViewRow) => {
      setAddingAgentId(row.agent_id);
      try {
        await management.addAndInstall(row);
        setRegistryOpen(false);
        setRegistry((current) =>
          current
            ? {
                ...current,
                installed: [
                  ...current.installed,
                  { ...row, added: true, installed: true },
                ],
                uninstalled: current.uninstalled.filter(
                  (item) => item.agent_id !== row.agent_id
                ),
              }
            : current
        );
        toast.success(
          t('settings:agents.addedInstalling', { agent: row.display_name })
        );
      } catch (error) {
        toast.error(errorMessage(error, t('settings:agents.addFailed')));
      } finally {
        setAddingAgentId(null);
      }
    },
    [management, t]
  );

  const addUserAgent = useCallback(
    async (request: UserAgentDefinitionRequest) => {
      setAddingAgentId(request.agent_id);
      try {
        await agentManagementApi.addUserDefinitionAndInstall(request);
        await management.refresh();
        management.select(request.agent_id);
        setRegistryOpen(false);
        toast.success(
          t('settings:agents.addedInstalling', {
            agent: request.display_name,
          })
        );
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.userAgentAddFailed'))
        );
      } finally {
        setAddingAgentId(null);
      }
    },
    [management, t]
  );

  const saveUserDefinition = useCallback(
    async (request: UserAgentDefinitionRequest): Promise<boolean> => {
      setSavingUserDefinition(true);
      try {
        const definition =
          await agentManagementApi.updateUserDefinition(request);
        setUserDefinition(definition);
        await management.refresh();
        toast.success(
          definition.reinstall_required
            ? t('settings:agents.definitionSavedReinstall')
            : t('settings:agents.definitionSaved')
        );
        return true;
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.definitionSaveFailed'))
        );
        return false;
      } finally {
        setSavingUserDefinition(false);
      }
    },
    [management, t]
  );

  const startingOperationAgentsRef = useRef<Set<string>>(new Set());

  const reinstallUserDefinition = useCallback(async () => {
    if (
      !selectedAgentId ||
      startingOperationAgentsRef.current.has(selectedAgentId)
    ) {
      return;
    }
    startingOperationAgentsRef.current.add(selectedAgentId);
    setEnablingOperation({
      agentId: selectedAgentId,
      operationId: `pending-reinstall-${selectedAgentId}`,
      kind: 'update',
      status: 'running',
      progressPercent: 8,
      message: null,
      logs: [`$ dimo agent update ${selectedAgentId}`],
      sequence: 0,
    });
    try {
      const receipt = await agentManagementApi.applyUpdate(selectedAgentId);
      if (receipt) {
        management.beginOperation(receipt);
      }
      toast.success(t('settings:agents.definitionReinstallStarted'));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.definitionReinstallFailed'))
      );
    } finally {
      setEnablingOperation((current) =>
        current?.agentId === selectedAgentId ? null : current
      );
      startingOperationAgentsRef.current.delete(selectedAgentId);
    }
  }, [management, selectedAgentId, t]);

  const applyBackgroundUpdateCheck = useCallback(async (agentId: AgentId) => {
    try {
      const comparison = await agentManagementApi.checkUpdate(agentId, {
        force: true,
      });
      recordAgentAcpUpdateCheck(comparison);
      setUpdateCheck(comparison);
      setPreflight((current) => {
        if (!current || current.agent_id !== agentId) return current;
        const next = applyUpdateCheckToPreflight(current, comparison);
        writePreflightSnapshot(next);
        return next;
      });
      return comparison;
    } catch {
      return null;
    }
  }, []);

  const selectedAgentIdRef = useRef<AgentId | null>(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  const inspectAgent = useCallback(
    async (options?: { notify?: boolean; skipUpdateCheck?: boolean }) => {
      if (!selectedAgentId) return null;
      const targetAgentId = selectedAgentId;
      const watchId = ++inspectGeneration.current;
      setChecking(true);
      try {
        const [report, nextActions, nextDiagnostics] = await Promise.all([
          agentManagementApi.preflight(targetAgentId),
          agentManagementApi.actions(targetAgentId).catch(() => null),
          agentManagementApi.diagnostics(targetAgentId).catch(() => null),
        ]);
        if (nextActions) {
          inspectCacheRef.current.actions.set(targetAgentId, nextActions);
        }
        if (nextDiagnostics) {
          const unread = nextDiagnostics.filter(
            (diagnostic) => !diagnostic.read
          );
          inspectCacheRef.current.diagnostics.set(targetAgentId, unread);
        }
        if (
          inspectGeneration.current !== watchId ||
          selectedAgentIdRef.current !== targetAgentId
        ) {
          return null;
        }
        writePreflightSnapshot(report);
        setPreflight(report);
        if (nextActions) {
          setActions(nextActions);
        }
        if (nextDiagnostics) {
          setDiagnostics(
            nextDiagnostics.filter((diagnostic) => !diagnostic.read)
          );
        }
        setChecking(false);
        const agents = await management.refresh();
        if (
          inspectGeneration.current !== watchId ||
          selectedAgentIdRef.current !== targetAgentId
        ) {
          return null;
        }
        if (options?.notify !== false) {
          toast.success(t('settings:agents.preflightComplete'));
        }
        const agent =
          agents.find((entry) => entry.agent_id === targetAgentId) ?? null;
        if (options?.skipUpdateCheck) {
          return { report, agent, comparison: null };
        }
        const comparison = await applyBackgroundUpdateCheck(targetAgentId);
        return { report, agent, comparison };
      } catch (error) {
        if (
          inspectGeneration.current !== watchId ||
          selectedAgentIdRef.current !== targetAgentId
        ) {
          return null;
        }
        toast.error(errorMessage(error, t('settings:agents.preflightFailed')));
        return null;
      } finally {
        if (inspectGeneration.current === watchId) setChecking(false);
      }
    },
    [applyBackgroundUpdateCheck, management, selectedAgentId, t]
  );

  const runPreflight = useCallback(
    async (options?: { notify?: boolean }) => {
      await inspectAgent(options);
    },
    [inspectAgent]
  );

  const liveOperation =
    (selectedAgentId && management.state.operations[selectedAgentId]) || null;
  const operationActive = Boolean(selectedAgentOperation || liveOperation);
  useEffect(() => {
    if (!operationActive) return;
    inspectGeneration.current += 1;
    setChecking(false);
  }, [operationActive]);
  const previousOperationRef = useRef<{
    agentId: string | null;
    busy: boolean;
    kind: AgentOperationKind | null;
  }>({ agentId: null, busy: false, kind: null });
  useEffect(() => {
    const previous = previousOperationRef.current;
    previousOperationRef.current = {
      agentId: selectedAgentId,
      busy: operationActive,
      kind: liveOperation?.kind ?? selectedAgentOperation ?? previous.kind,
    };
    if (
      !selectedAgentId ||
      registryOpen ||
      previous.agentId !== selectedAgentId ||
      !previous.busy ||
      operationActive
    ) {
      return;
    }
    if (selectedAgent?.lifecycle === 'needs_repair') {
      return;
    }
    const finishedKind = previous.kind;
    if (
      finishedKind !== 'install' &&
      finishedKind !== 'update' &&
      finishedKind !== 'repair' &&
      finishedKind !== 'uninstall'
    ) {
      return;
    }
    const finishedNativeEngine = isNativeEngineAgent(
      selectedAgent ?? selectedAgentId
    );
    if (finishedKind !== 'uninstall') {
      toast.success(
        t(
          finishedKind === 'install'
            ? finishedNativeEngine
              ? 'settings:agents.nativeRuntimeInstallComplete'
              : 'settings:agents.runtimeAcpInstallComplete'
            : finishedKind === 'repair'
              ? 'settings:agents.repairComplete'
              : finishedNativeEngine
                ? 'settings:agents.nativeRuntimeUpdateComplete'
                : 'settings:agents.runtimeAcpUpdateComplete'
        )
      );
    }
    const targetAgentId = selectedAgentId;
    const watchId = ++inspectGeneration.current;
    invalidateAgentAcpUpdate(targetAgentId);
    inspectCacheRef.current.updateCheck.delete(targetAgentId);
    const refreshPromise = refreshManagement()
      .then((agents) => {
        const agent =
          agents.find((item) => item.agent_id === targetAgentId) ?? null;
        if (
          !agent ||
          inspectGeneration.current !== watchId ||
          selectedAgentIdRef.current !== targetAgentId
        ) {
          return agent;
        }
        if (finishedKind !== 'uninstall') {
          setPreflight((current) => {
            const next = applyInstallationToPreflight(current, agent);
            writePreflightSnapshot(next);
            return next;
          });
        }
        setUpdateCheck(null);
        setChecking(false);
        return agent;
      })
      .catch(() => null);
    void Promise.all([
      refreshPromise,
      agentManagementApi.preflight(targetAgentId).catch(() => null),
      agentManagementApi.actions(targetAgentId).catch(() => null),
      agentManagementApi.diagnostics(targetAgentId).catch(() => null),
    ]).then(([agent, report, nextActions, nextDiagnostics]) => {
      if (nextActions) {
        inspectCacheRef.current.actions.set(targetAgentId, nextActions);
      }
      if (nextDiagnostics) {
        const unread = nextDiagnostics.filter((diagnostic) => !diagnostic.read);
        inspectCacheRef.current.diagnostics.set(targetAgentId, unread);
      }
      if (
        inspectGeneration.current !== watchId ||
        selectedAgentIdRef.current !== targetAgentId
      ) {
        return;
      }
      if (nextActions) {
        setActions(nextActions);
      }
      if (nextDiagnostics) {
        setDiagnostics(
          nextDiagnostics.filter((diagnostic) => !diagnostic.read)
        );
      }
      if (report) {
        const next =
          agent && finishedKind !== 'uninstall'
            ? applyInstallationToPreflight(report, agent)
            : report;
        writePreflightSnapshot(next);
        setPreflight(next);
      }
      setUpdateCheck(null);
      setChecking(false);
    });
  }, [
    liveOperation?.kind,
    refreshManagement,
    operationActive,
    registryOpen,
    selectedAgent,
    selectedAgentId,
    selectedAgentOperation,
    t,
  ]);

  const reloadProviderInstances = providerInstances.reload;
  const refreshAuthentication = useCallback(async () => {
    if (!selectedAgentId || !inspectKey) return null;
    authRefreshGeneration.current += 1;
    const generation = authRefreshGeneration.current;
    try {
      if (isCustomInstance) {
        const [nextConfig, nextActions, nextAuthView] = await Promise.all([
          agentManagementApi.readConfig(
            selectedAgentId,
            activeProviderInstanceId
          ),
          agentManagementApi.actions(selectedAgentId, activeProviderInstanceId),
          agentManagementApi
            .authMode(selectedAgentId, activeProviderInstanceId)
            .catch(() => null),
        ]);
        if (authRefreshGeneration.current !== generation) return null;
        inspectCacheRef.current.config.set(inspectKey, nextConfig);
        inspectCacheRef.current.actions.set(inspectKey, nextActions);
        setConfig(nextConfig);
        setActions(nextActions);
        if (nextAuthView) setCustomAuthView(nextAuthView);
        await reloadProviderInstances();
        return deriveCustomInstanceAuthStatus(nextAuthView) ?? 'not_logged_in';
      }
      const report = await agentManagementApi.preflight(
        selectedAgentId,
        'authentication'
      );
      if (authRefreshGeneration.current !== generation) return null;
      setPreflight((current) => {
        const next = current ? mergePreflightItems(current, report) : report;
        writePreflightSnapshot(next);
        return next;
      });
      const [nextConfig, nextActions] = await Promise.all([
        agentManagementApi.readConfig(selectedAgentId),
        agentManagementApi.actions(selectedAgentId),
      ]);
      if (authRefreshGeneration.current !== generation) return null;
      inspectCacheRef.current.config.set(inspectKey, nextConfig);
      inspectCacheRef.current.actions.set(inspectKey, nextActions);
      setConfig(nextConfig);
      setActions(nextActions);
      const agents = await refreshManagement();
      if (authRefreshGeneration.current !== generation) return null;
      return (
        agents.find((agent) => agent.agent_id === selectedAgentId)
          ?.authentication ?? null
      );
    } catch {
      return null;
    }
  }, [
    activeProviderInstanceId,
    inspectKey,
    isCustomInstance,
    refreshManagement,
    reloadProviderInstances,
    selectedAgentId,
  ]);

  const notifyAuthenticationChanged = useCallback(() => {
    void refreshAuthentication();
  }, [refreshAuthentication]);

  useAgentModelRouterImport({
    agents: management.state.agents,
    selectedAgentId,
    selectAgent,
    setFocusDiagnostics,
    setRegistryOpen,
    setProviderRefreshKey,
    refreshAuthentication,
  });

  const { actionRunning, runManagementAction } = useAgentAccountFlowWatcher({
    selectedAgentId,
    providerInstanceId: activeProviderInstanceId,
    registryOpen,
    refreshAuthentication,
    setConfig,
  });

  const reorder = useCallback(
    async (order: string[]) => {
      const currentDefault = userConfig?.executor_profile.executor ?? null;
      const nextDefault = defaultAgentIdFromOrder(order, currentDefault);
      try {
        await agentManagementApi.reorder(order);
        if (nextDefault && nextDefault !== currentDefault) {
          const moved = management.state.agents.find(
            (agent) => agent.agent_id === nextDefault
          );
          if (moved && !moved.enabled) {
            const enabledAgent = await agentManagementApi.setEnabled(
              nextDefault,
              true
            );
            management.mergeAgent(enabledAgent);
            const report = await agentManagementApi
              .preflight(nextDefault)
              .catch(() => null);
            const action = report
              ? agentProvisioningAction(
                  enabledAgent,
                  presentPreflightItems(report.items, enabledAgent).filter(
                    (item) => !isAuthPreflightItem(item)
                  )
                )
              : agentProvisioningAction(enabledAgent, []);
            if (action === 'install') {
              const receipt =
                await agentManagementApi.addAndInstall(nextDefault);
              management.beginOperation(receipt);
            } else if (action === 'repair') {
              const receipt = await agentManagementApi.repair(nextDefault);
              management.beginOperation(receipt);
            }
          }
          await updateAndSaveConfig({
            executor_profile: { executor: nextDefault, variant: null },
          });
        }
        await management.refresh();
      } catch (error) {
        toast.error(errorMessage(error, t('settings:agents.reorderFailed')));
        await management.refresh().catch(() => undefined);
      }
    },
    [userConfig?.executor_profile.executor, management, t, updateAndSaveConfig]
  );

  const showKiroWebInstallFallbackToast = useCallback(
    (error?: unknown) => {
      const detail = error
        ? errorMessage(error, t('settings:agents.installStartFailed'))
        : null;
      const guideDescription = t(
        'settings:agents.kiroSilentInstallFailedDescription'
      );
      toast.error(t('settings:agents.kiroSilentInstallFailedTitle'), {
        description: detail
          ? `${guideDescription} (${detail})`
          : guideDescription,
        duration: 12_000,
        action: {
          label: t('settings:agents.officialInstallGuide'),
          onClick: () => {
            window.open(
              'https://kiro.dev/docs/getting-started/installation/',
              '_blank',
              'noopener,noreferrer'
            );
          },
        },
      });
    },
    [t]
  );

  const queueRepair = useCallback(async () => {
    if (
      !selectedAgentId ||
      startingOperationAgentsRef.current.has(selectedAgentId)
    ) {
      return;
    }
    startingOperationAgentsRef.current.add(selectedAgentId);
    setEnablingOperation({
      agentId: selectedAgentId,
      operationId: `pending-repair-${selectedAgentId}`,
      kind: 'repair',
      status: 'running',
      progressPercent: 8,
      message: null,
      logs: [`$ dimo agent repair ${selectedAgentId}`],
      sequence: 0,
    });
    try {
      const receipt = await agentManagementApi.repair(selectedAgentId);
      management.beginOperation(receipt);
      toast.success(t('settings:agents.repairStarted'));
    } catch (error) {
      if (selectedAgentId === 'kiro') {
        showKiroWebInstallFallbackToast(error);
        return;
      }
      toast.error(
        errorMessage(error, t('settings:agents.operationStartFailed'))
      );
    } finally {
      setEnablingOperation((current) =>
        current?.agentId === selectedAgentId ? null : current
      );
      startingOperationAgentsRef.current.delete(selectedAgentId);
    }
  }, [management, selectedAgentId, showKiroWebInstallFallbackToast, t]);

  const queueInstall = useCallback(async () => {
    if (
      !selectedAgentId ||
      startingOperationAgentsRef.current.has(selectedAgentId)
    ) {
      return;
    }
    startingOperationAgentsRef.current.add(selectedAgentId);
    setEnablingOperation({
      agentId: selectedAgentId,
      operationId: `pending-install-${selectedAgentId}`,
      kind: 'install',
      status: 'running',
      progressPercent: 8,
      message: null,
      logs: [`$ dimo agent install ${selectedAgentId}`],
      sequence: 0,
    });
    try {
      const receipt = await agentManagementApi.addAndInstall(selectedAgentId);
      management.beginOperation(receipt);
      toast.success(
        t(
          isNativeEngineAgent(selectedAgent ?? selectedAgentId)
            ? 'settings:agents.nativeInstallStarted'
            : 'settings:agents.installStarted'
        )
      );
    } catch (error) {
      if (selectedAgentId === 'kiro') {
        showKiroWebInstallFallbackToast(error);
        return;
      }
      toast.error(errorMessage(error, t('settings:agents.installStartFailed')));
    } finally {
      setEnablingOperation((current) =>
        current?.agentId === selectedAgentId ? null : current
      );
      startingOperationAgentsRef.current.delete(selectedAgentId);
    }
  }, [
    management,
    selectedAgent,
    selectedAgentId,
    showKiroWebInstallFallbackToast,
    t,
  ]);

  const queueVersionInstall = useCallback(
    async (input: {
      version?: string;
      runtimeVersion?: string;
      acpVersion?: string;
    }) => {
      if (
        !selectedAgentId ||
        startingOperationAgentsRef.current.has(selectedAgentId)
      ) {
        return;
      }
      startingOperationAgentsRef.current.add(selectedAgentId);
      const version =
        input.acpVersion || input.runtimeVersion || input.version || '';
      setEnablingOperation({
        agentId: selectedAgentId,
        operationId: `pending-install-version-${selectedAgentId}`,
        kind: 'install',
        status: 'running',
        progressPercent: 8,
        message: null,
        logs: [
          `$ dimo agent install ${selectedAgentId}${version ? ` --version ${version}` : ''}`,
        ],
        sequence: 0,
      });
      try {
        const receipt = await agentManagementApi.installVersion(
          selectedAgentId,
          input
        );
        management.beginOperation(receipt);
        toast.success(
          t('settings:agents.customVersionInstallStarted', { version })
        );
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.installStartFailed'))
        );
      } finally {
        setEnablingOperation((current) =>
          current?.agentId === selectedAgentId ? null : current
        );
        startingOperationAgentsRef.current.delete(selectedAgentId);
      }
    },
    [management, selectedAgentId, t]
  );

  const previewVersions = useCallback(
    async (input: { runtimeVersion?: string; acpVersion?: string }) => {
      if (!selectedAgentId) return null;
      try {
        const comparison = await agentManagementApi.checkUpdate(
          selectedAgentId,
          input
        );
        return comparison.compatibility_warning ?? null;
      } catch {
        return null;
      }
    },
    [selectedAgentId]
  );

  const checkUpdate = useCallback(async () => {
    if (!selectedAgentId) return;
    setCheckingUpdate(true);
    try {
      const comparison = await applyBackgroundUpdateCheck(selectedAgentId);
      if (!comparison) {
        toast.error(t('settings:agents.updateCheckFailed'));
        return;
      }
      const primaryItem = preflight?.items.find((item) =>
        isPrimaryRuntimePreflightItem(item, selectedAgent ?? selectedAgentId)
      );
      const hasUpdate =
        comparison.update_available ||
        agentHasAcpUpdate(comparison, primaryItem?.version);
      const learnedLatest = Boolean(
        comparison.acp_available ||
          comparison.runtime_available ||
          comparison.available_version
      );
      if (!hasUpdate && !learnedLatest) {
        toast.error(t('settings:agents.updateCheckFailed'));
        return;
      }
      toast.success(
        hasUpdate
          ? t('settings:agents.updateAvailable')
          : t('settings:agents.upToDate')
      );
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.updateCheckFailed')));
    } finally {
      setCheckingUpdate(false);
    }
  }, [
    applyBackgroundUpdateCheck,
    preflight,
    selectedAgent,
    selectedAgentId,
    t,
  ]);

  const applyUpdate = useCallback(async () => {
    if (
      !selectedAgentId ||
      startingOperationAgentsRef.current.has(selectedAgentId)
    ) {
      return;
    }
    startingOperationAgentsRef.current.add(selectedAgentId);
    setEnablingOperation({
      agentId: selectedAgentId,
      operationId: `pending-update-${selectedAgentId}`,
      kind: 'update',
      status: 'running',
      progressPercent: 8,
      message: null,
      logs: [`$ dimo agent update ${selectedAgentId}`],
      sequence: 0,
    });
    try {
      const receipt = await agentManagementApi.applyUpdate(selectedAgentId);
      if (receipt) {
        management.beginOperation(receipt);
      }
      toast.success(t('settings:agents.updateStarted'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.updateStartFailed')));
    } finally {
      setEnablingOperation((current) =>
        current?.agentId === selectedAgentId ? null : current
      );
      startingOperationAgentsRef.current.delete(selectedAgentId);
    }
  }, [management, selectedAgentId, t]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!selectedAgentId) return;
      if (enabled) {
        setEnablingOperation({
          agentId: selectedAgentId,
          operationId: `enable-${selectedAgentId}`,
          kind: 'install',
          status: 'running',
          progressPercent: 10,
          message: null,
          logs: [`$ dimo agent enable ${selectedAgentId}`],
          sequence: 0,
        });
      }
      let updatedAgent;
      try {
        updatedAgent = await agentManagementApi.setEnabled(
          selectedAgentId,
          enabled
        );
        management.mergeAgent(updatedAgent);
      } catch (error) {
        if (enabled) setEnablingOperation(null);
        toast.error(
          errorMessage(error, t('settings:agents.enableUpdateFailed'))
        );
        return;
      }
      if (!enabled) return;
      try {
        setEnablingOperation((current) =>
          current?.agentId === selectedAgentId
            ? {
                ...current,
                progressPercent: 22,
                message: null,
                logs: [
                  ...(current.logs ?? []),
                  `$ dimo agent preflight ${selectedAgentId}`,
                ],
              }
            : current
        );
        const inspected = await inspectAgent({
          notify: false,
          skipUpdateCheck: true,
        });
        const agent = inspected?.agent ?? updatedAgent;
        if (agent.active_operation) return;
        const report = inspected?.report ?? null;
        const action = report
          ? agentProvisioningAction(
              agent,
              presentPreflightItems(report.items, agent).filter(
                (item) => !isAuthPreflightItem(item)
              )
            )
          : agentProvisioningAction(agent, []);
        if (action === 'install') {
          await queueInstall();
          return;
        }
        if (action === 'repair') {
          await queueRepair();
          return;
        }
        const comparison = await applyBackgroundUpdateCheck(selectedAgentId);
        const primaryItem = report?.items.find((item) =>
          isPrimaryRuntimePreflightItem(item, agent)
        );
        if (
          comparison?.update_available ||
          (comparison && agentHasAcpUpdate(comparison, primaryItem?.version))
        ) {
          await applyUpdate();
        }
      } finally {
        setEnablingOperation((current) =>
          current?.agentId === selectedAgentId ? null : current
        );
      }
    },
    [
      applyBackgroundUpdateCheck,
      applyUpdate,
      inspectAgent,
      management,
      queueInstall,
      queueRepair,
      selectedAgentId,
      t,
    ]
  );

  const applyPreflightItemUpdate = useCallback(
    async (itemId: string) => {
      if (!selectedAgentId) return;
      const item = preflight?.items.find((entry) => entry.id === itemId);
      const hasKnownUpdate =
        Boolean(item?.update_available) ||
        (isPrimaryRuntimePreflightItem(
          { id: itemId },
          selectedAgent ?? selectedAgentId
        ) &&
          Boolean(
            updateCheck?.update_available ||
              readCachedAgentAcpUpdate(selectedAgentId)?.available
          ));
      if (!hasKnownUpdate) return;
      await applyUpdate();
    },
    [applyUpdate, preflight, selectedAgent, selectedAgentId, updateCheck]
  );

  const uninstall = useCallback(
    async (options?: { clearData?: boolean }) => {
      if (!selectedAgentId) return;
      try {
        const result = await agentManagementApi.uninstall(
          selectedAgentId,
          options
        );
        if (Array.isArray(result)) {
          const updated = result.find(
            (entry) => entry.agent_id === selectedAgentId
          );
          if (updated) {
            management.mergeAgent(updated);
          } else {
            await management.refresh();
          }
        } else if (result) {
          management.mergeAgent(result);
        }
        await inspectAgent({ notify: false, skipUpdateCheck: true });
        toast.success(t('settings:agents.uninstalled'));
      } catch (error) {
        toast.error(errorMessage(error, t('settings:agents.uninstallFailed')));
      }
    },
    [inspectAgent, management, selectedAgentId, t]
  );

  const cancelOperation = useCallback(async () => {
    if (!selectedAgentId) return;
    const operation = management.state.operations[selectedAgentId];
    if (!operation) return;
    try {
      await agentManagementApi.cancelOperation(
        selectedAgentId,
        operation.operationId
      );
      toast.success(t('settings:agents.cancelingOperation'));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.cancelOperationFailed'))
      );
    }
  }, [management.state.operations, selectedAgentId, t]);

  const remove = useCallback(async () => {
    if (!selectedAgentId) return;
    const result = await ConfirmDialog.show({
      title: t('settings:agents.removeTitle', {
        agent: selectedAgent?.display_name ?? selectedAgentId,
      }),
      message: t('settings:agents.removeMessage'),
      confirmText: t('settings:agents.removeConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    try {
      await agentManagementApi.remove(selectedAgentId);
      await management.refresh();
      toast.success(t('settings:agents.removed'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.removeFailed')));
    }
  }, [management, selectedAgent?.display_name, selectedAgentId, t]);

  const { saveConfig, saveConfigFile, reloadConflict, overwriteConflict } =
    useAgentNativeConfigActions({
      selectedAgentId,
      activeProviderInstanceId,
      config,
      configConflict,
      setConfig,
      setConfigConflict,
      setSavingConfig,
      refreshAuthentication,
      refreshManagement: isCustomInstance
        ? reloadProviderInstances
        : refreshManagement,
    });

  const exportDiagnostics = useCallback(() => {
    if (!selectedAgentId) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            agent_id: selectedAgentId,
            exported_at: new Date().toISOString(),
            diagnostics,
          },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedAgentId}-diagnostics.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(t('settings:agents.diagnosticsExported'));
  }, [diagnostics, selectedAgentId, t]);

  const markAllDiagnosticsRead = useCallback(() => {
    if (!selectedAgentId) return;
    setDiagnostics([]);
    void agentManagementApi
      .markDiagnosticsRead(selectedAgentId)
      .catch(() => undefined);
  }, [selectedAgentId]);

  const defaultExecutor = userConfig?.executor_profile.executor ?? null;
  const barAgents = useMemo(
    () => sortAgentsForBar(management.state.agents, defaultExecutor),
    [management.state.agents, defaultExecutor]
  );

  if (management.loading && management.state.agents.length === 0) {
    return <AgentSettingsLoading />;
  }

  return (
    <div className="agent-settings-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-24">
      <AgentBar
        agents={barAgents}
        selectedAgentId={management.state.selectedAgentId}
        registryOpen={registryOpen}
        refreshing={management.loading}
        onSelect={(agentId) =>
          void (async () => {
            if (!(await confirmDiscardConfig())) return;
            management.select(agentId);
            setRegistryOpen(false);
          })()
        }
        onReorder={(order) => void reorder(order)}
        onAdd={() =>
          void (async () => {
            if (await confirmDiscardConfig()) setRegistryOpen(true);
          })()
        }
        onRefresh={() => void management.refreshFresh().catch(() => undefined)}
      />

      {registryOpen ? (
        <AgentRegistryViewPanel
          view={registry}
          loading={registryLoading}
          addingAgentId={addingAgentId}
          onRefresh={() => void loadRegistry(true)}
          onAdd={(row) => void addAgent(row)}
          onAddUserDefinition={(request) => void addUserAgent(request)}
        />
      ) : selectedAgent ? (
        <AgentSettingsDetailSections
          selectedAgent={selectedAgent}
          providerInstanceId={activeProviderInstanceId}
          isCustomInstance={isCustomInstance}
          authenticationOverride={authenticationOverride}
          onAuthViewChange={setCustomAuthView}
          instanceSwitcher={
            providerInstances.supportsInstances ? (
              <AgentInstanceSwitcher
                agentDisplayName={selectedAgent.display_name}
                instances={providerInstances.instances}
                selectedInstanceId={providerInstances.selectedInstanceId}
                disabled={operationActive || Boolean(actionRunning)}
                mutating={providerInstances.mutating}
                onSelectInstance={providerInstances.selectInstance}
                onCreateInstance={providerInstances.createInstance}
                onRenameInstance={providerInstances.renameInstance}
                onSetDefaultInstance={providerInstances.setDefaultInstance}
                onDeleteInstance={providerInstances.deleteInstance}
              />
            ) : null
          }
          liveConfig={liveConfig}
          config={config}
          hasAuthenticationMode={hasAuthenticationMode}
          agentLocked={agentLocked}
          providerRefreshKey={providerRefreshKey}
          actions={actions}
          actionRunning={actionRunning}
          operations={management.state.operations}
          enablingOperation={enablingOperation}
          preflight={preflight}
          diagnostics={diagnostics}
          focusDiagnostics={focusDiagnostics}
          checking={checking}
          checkingUpdate={checkingUpdate}
          updateCheck={updateCheck}
          savingConfig={savingConfig}
          configConflictMessage={configConflict?.message}
          environmentDiagnosticsAgentId={environmentDiagnosticsAgentId}
          setEnvironmentDiagnosticsAgentId={setEnvironmentDiagnosticsAgentId}
          userDefinition={userDefinition}
          savingUserDefinition={savingUserDefinition}
          nativePluginEcosystem={nativePluginEcosystem}
          nativePluginsExpanded={nativePluginsExpanded}
          setNativePluginsExpanded={setNativePluginsExpanded}
          pluginCount={pluginCount}
          setPluginCount={setPluginCount}
          onDirtySource={setDirtySource}
          onNotifyAuthenticationChanged={notifyAuthenticationChanged}
          onRunManagementAction={(actionId) =>
            void runManagementAction(actionId)
          }
          onSaveConfig={saveConfig}
          onSaveConfigFile={(request) => void saveConfigFile(request)}
          onReloadConflict={() => void reloadConflict()}
          onAdoptExternalConflict={() => setConfigConflict(null)}
          onOverwriteConflict={() => void overwriteConflict()}
          onMarkAllDiagnosticsRead={markAllDiagnosticsRead}
          onSetEnabled={(enabled) => void setEnabled(enabled)}
          onPreflight={() => void runPreflight()}
          onInstall={() => void queueInstall()}
          onInstallVersion={(input) => void queueVersionInstall(input)}
          onPreviewVersions={previewVersions}
          onRepair={() => void queueRepair()}
          onCheckUpdate={() => void checkUpdate()}
          onUpdatePreflightItem={(itemId) =>
            void applyPreflightItemUpdate(itemId)
          }
          onCancelOperation={() => void cancelOperation()}
          onUninstall={(options) => void uninstall(options)}
          onRemove={() => void remove()}
          onExportDiagnostics={exportDiagnostics}
          onSaveUserDefinition={saveUserDefinition}
          onReinstallUserDefinition={() => void reinstallUserDefinition()}
          onRefreshManagement={management.refresh}
        />
      ) : (
        <section className="settings-surface flex min-h-44 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('settings:agents.emptyList')}
        </section>
      )}

      <AgentModelMarketIntroDialog
        ready={!management.loading || management.state.agents.length > 0}
        selectedAgentId={selectedAgent?.agent_id ?? null}
      />
    </div>
  );
}
