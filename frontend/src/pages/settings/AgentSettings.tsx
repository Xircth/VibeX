import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthenticationStatus,
  AgentDiagnosticView,
  AgentId,
  AgentManagementActionsView,
  AgentManagementView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigView,
  AgentOperationKind,
  AgentPreflightItemView,
  AgentPreflightView,
  AgentRegistryView,
  AgentRegistryViewRow,
  AgentUpdateCheckView,
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
} from 'shared/types';

import { useUserSystem } from '@/components/ConfigProvider';
import { toast } from '@/components/ui/toast';
import { AgentUpdateConfirmDialog } from '@/components/dialogs/settings/AgentUpdateConfirmDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
  useAgentManagement,
} from '@/features/agent-management';
import { recordAgentAcpUpdateCheck } from '@/features/agent-management/agentAcpUpdates';
import { consumeAgentSettingsFocus } from '@/features/agent-management/agentSettingsFocus';
import { agentHasAcpUpdate } from '@/features/agent-management/agentVersion';

import { AgentBar } from './AgentBar';
import { defaultAgentIdFromOrder, sortAgentsForBar } from './agentBarOrder';
import { AgentSettingsLoading } from './AgentSettingsLoading';
import {
  AgentConfigPathMeta,
  AgentConfigurationAndDiagnostics,
  configFilePathsForSurface,
  configForAuthMode,
} from './AgentConfigurationAndDiagnostics';
import { AgentDetail } from './AgentDetail';
import { AgentAuthModeControl } from './AgentAuthModeControl';
import { AgentEnvironmentEditor } from './AgentEnvironmentEditor';
import { AgentEnvironmentDiagnosticsDialog } from './AgentEnvironmentDiagnosticsDialog';
import { AgentModelProviderManager } from './AgentModelProviderManager';
import { AgentRegistryViewPanel } from './AgentRegistryView';
import { OpenCodeProviderConnections } from './OpenCodeProviderConnections';
import { OpenCodeSubscriptionPanel } from './OpenCodeSubscriptionPanel';
import { OpenCodePluginHealth } from './OpenCodePluginHealth';
import { DshAuthPanel } from './DshAuthPanel';
import { DshPluginManager } from './DshPluginManager';
import { GrokPluginManager } from './GrokPluginManager';
import { PiPluginManager } from './PiPluginManager';
import { DshSessionDefaults } from './DshSessionDefaults';
import { PluginsSettings, type PluginEcosystem } from './PluginsSettings';
import { SettingsSection as CollapsibleSettingsSection } from './SettingsSection';
import { AgentLockedSurface } from './SettingsUi';
import { UserAgentDefinitionPanel } from './UserAgentDefinitionPanel';
import {
  isAuthPreflightItem,
  mergePreflightItems,
  overlayAuthPreflightItems,
  presentPreflightItems,
  readPreflightSnapshot,
  writePreflightSnapshot,
} from './agentPreflightSnapshot';
import { agentProvisioningAction } from './agentProvisioning';

export function AgentSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config: userConfig, updateAndSaveConfig } = useUserSystem();
  const management = useAgentManagement();
  const [focusDiagnostics, setFocusDiagnostics] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<AgentPreflightView | null>(null);
  const [actions, setActions] = useState<AgentManagementActionsView | null>(
    null
  );
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [config, setConfig] = useState<AgentNativeConfigView | null>(null);
  const [diagnostics, setDiagnostics] = useState<AgentDiagnosticView[]>([]);
  const [environmentDiagnosticsAgentId, setEnvironmentDiagnosticsAgentId] =
    useState<AgentId | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configConflict, setConfigConflict] = useState<
    | {
        kind: 'fields';
        message: string;
        request: AgentNativeConfigPatchRequest;
      }
    | {
        kind: 'file';
        message: string;
        request: AgentNativeConfigFileWriteRequest;
      }
    | null
  >(null);
  const [updateCheck, setUpdateCheck] = useState<AgentUpdateCheckView | null>(
    null
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [userDefinition, setUserDefinition] =
    useState<UserAgentDefinitionView | null>(null);
  const [savingUserDefinition, setSavingUserDefinition] = useState(false);
  const [dirtySources, setDirtySources] = useState<Record<string, boolean>>({});
  const dirtySourcesRef = useRef(dirtySources);
  const configDirtyRef = useRef(false);
  const [nativePluginsExpanded, setNativePluginsExpanded] = useState(false);
  const [pluginCount, setPluginCount] = useState(0);
  const configDirty = Object.values(dirtySources).some(Boolean);
  const setDirtySource = useCallback((source: string, dirty: boolean) => {
    const current = dirtySourcesRef.current;
    const next =
      current[source] === dirty ? current : { ...current, [source]: dirty };
    dirtySourcesRef.current = next;
    configDirtyRef.current = Object.values(next).some(Boolean);
    if (next !== current) setDirtySources(next);
  }, []);
  const setConfigurationDirty = useCallback(
    (dirty: boolean) => setDirtySource('configuration', dirty),
    [setDirtySource]
  );
  const setAuthConfigurationDirty = useCallback(
    (dirty: boolean) => setDirtySource('auth-configuration', dirty),
    [setDirtySource]
  );
  const setAuthModeDirty = useCallback(
    (dirty: boolean) => setDirtySource('auth-mode', dirty),
    [setDirtySource]
  );
  const setUserDefinitionDirty = useCallback(
    (dirty: boolean) => setDirtySource('user-definition', dirty),
    [setDirtySource]
  );
  const setModelProviderDirty = useCallback(
    (dirty: boolean) => setDirtySource('model-provider', dirty),
    [setDirtySource]
  );
  const setOpenCodeProviderDirty = useCallback(
    (dirty: boolean) => setDirtySource('opencode-provider', dirty),
    [setDirtySource]
  );
  const setDshProviderDirty = useCallback(
    (dirty: boolean) => setDirtySource('dsh-provider', dirty),
    [setDirtySource]
  );
  const setEnvironmentDirty = useCallback(
    (dirty: boolean) => setDirtySource('environment', dirty),
    [setDirtySource]
  );

  const selectedAgent = management.selectedAgent;
  const selectedAgentId = selectedAgent?.agent_id ?? null;
  const selectAgent = management.select;
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
  const agentLocked =
    selectedAgentLifecycle === 'uninstalled' ||
    selectedAgentLifecycle === 'platform_unsupported';
  const nativePluginEcosystem: PluginEcosystem | null =
    selectedAgentId === 'codex'
      ? 'codex'
      : selectedAgentId === 'claude_code'
        ? 'claude_code'
        : null;
  const refreshManagement = management.refresh;
  const authWatchGeneration = useRef(0);
  const authRefreshGeneration = useRef(0);
  const inspectGeneration = useRef(0);
  const inspectCacheRef = useRef({
    config: new Map<AgentId, AgentNativeConfigView>(),
    actions: new Map<AgentId, AgentManagementActionsView>(),
    diagnostics: new Map<AgentId, AgentDiagnosticView[]>(),
    updateCheck: new Map<AgentId, AgentUpdateCheckView>(),
  });

  const confirmDiscardConfig = useCallback(async () => {
    if (!configDirtyRef.current) return true;
    const result = await ConfirmDialog.show({
      title: t('settings:agents.unsavedConfigTitle'),
      message: t('settings:agents.unsavedConfigMessage'),
      confirmText: t('settings:agents.discardConfig'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return false;
    dirtySourcesRef.current = {};
    configDirtyRef.current = false;
    setDirtySources({});
    return true;
  }, [t]);

  useEffect(() => {
    if (!configDirty) return;
    const currentHref = window.location.href;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const handleSidebarClick = (event: MouseEvent) => {
      if (!configDirtyRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const navTarget = target.closest<HTMLElement>(
        '.settings-sidebar a[href], .settings-sidebar .settings-nav-button, .settings-sidebar .settings-search-result'
      );
      if (!navTarget) return;
      if (
        navTarget.getAttribute('aria-current') === 'page' ||
        navTarget.classList.contains('is-active')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (!(await confirmDiscardConfig())) return;
        const fallbackAnchorNav = (e: MouseEvent) => {
          if (navTarget instanceof HTMLAnchorElement && !e.defaultPrevented) {
            e.preventDefault();
            const href = navTarget.getAttribute('href');
            if (href) window.history.pushState(null, '', href);
          }
        };
        window.addEventListener('click', fallbackAnchorNav, { once: true });
        navTarget.click();
        window.removeEventListener('click', fallbackAnchorNav);
      })();
    };
    const handlePopState = () => {
      if (!configDirtyRef.current) return;
      const nextHref = window.location.href;
      window.history.pushState(null, '', currentHref);
      void (async () => {
        if (await confirmDiscardConfig()) {
          window.history.replaceState(null, '', nextHref);
        }
      })();
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', handleSidebarClick, true);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', handleSidebarClick, true);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [configDirty, confirmDiscardConfig]);

  useEffect(() => {
    setNativePluginsExpanded(false);
  }, [selectedAgentId]);

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
    if (!selectedAgentId || registryOpen) return;
    let active = true;
    const watchId = ++inspectGeneration.current;
    const authGenAtStart = authRefreshGeneration.current;
    const cache = inspectCacheRef.current;
    const snapshot = readPreflightSnapshot(selectedAgentId);
    setPreflight(snapshot);
    setConfig(cache.config.get(selectedAgentId) ?? null);
    setActions(cache.actions.get(selectedAgentId) ?? null);
    setDiagnostics(cache.diagnostics.get(selectedAgentId) ?? []);
    setUpdateCheck(cache.updateCheck.get(selectedAgentId) ?? null);
    setConfigConflict(null);
    setChecking(!snapshot);
    void (async () => {
      try {
        const report = await agentManagementApi.preflight(selectedAgentId);
        if (!active || inspectGeneration.current !== watchId) return;
        setPreflight((current) => {
          const next =
            authRefreshGeneration.current !== authGenAtStart && current
              ? overlayAuthPreflightItems(report, current)
              : report;
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
        cache.config.set(selectedAgentId, configResult.value);
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
        cache.actions.set(selectedAgentId, actionsResult.value);
        setActions(actionsResult.value);
      }
    });
    return () => {
      active = false;
    };
  }, [refreshManagement, registryOpen, selectedAgentId]);

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

  const reinstallUserDefinition = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.applyUpdate(selectedAgentId);
      toast.success(t('settings:agents.definitionReinstallStarted'));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.definitionReinstallFailed'))
      );
    }
  }, [selectedAgentId, t]);

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

  const inspectAgent = useCallback(
    async (options?: { notify?: boolean; skipUpdateCheck?: boolean }) => {
      if (!selectedAgentId) return null;
      const watchId = ++inspectGeneration.current;
      setChecking(true);
      try {
        const report = await agentManagementApi.preflight(selectedAgentId);
        if (inspectGeneration.current !== watchId) return null;
        writePreflightSnapshot(report);
        setPreflight(report);
        setChecking(false);
        const agents = await management.refresh();
        if (inspectGeneration.current !== watchId) return null;
        if (options?.notify !== false) {
          toast.success(t('settings:agents.preflightComplete'));
        }
        const agent =
          agents.find((entry) => entry.agent_id === selectedAgentId) ?? null;
        if (options?.skipUpdateCheck) {
          return { report, agent, comparison: null };
        }
        const comparison = await applyBackgroundUpdateCheck(selectedAgentId);
        return { report, agent, comparison };
      } catch (error) {
        if (inspectGeneration.current !== watchId) return null;
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
      kind: liveOperation?.kind ?? previous.kind,
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
      finishedKind !== 'repair'
    ) {
      return;
    }
    toast.success(
      t(
        finishedKind === 'install'
          ? 'settings:agents.runtimeAcpInstallComplete'
          : finishedKind === 'repair'
            ? 'settings:agents.repairComplete'
            : 'settings:agents.runtimeAcpUpdateComplete'
      )
    );
    void refreshManagement()
      .then((agents) => {
        const agent = agents.find((item) => item.agent_id === selectedAgentId);
        if (!agent) return;
        setPreflight((current) => {
          const next = applyInstallationToPreflight(current, agent);
          writePreflightSnapshot(next);
          return next;
        });
        setUpdateCheck(null);
        setChecking(false);
      })
      .catch(() => undefined);
  }, [
    liveOperation?.kind,
    refreshManagement,
    operationActive,
    registryOpen,
    selectedAgent?.lifecycle,
    selectedAgentId,
    t,
  ]);

  const refreshAuthentication = useCallback(async () => {
    if (!selectedAgentId) return null;
    authRefreshGeneration.current += 1;
    const generation = authRefreshGeneration.current;
    try {
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
      inspectCacheRef.current.config.set(selectedAgentId, nextConfig);
      inspectCacheRef.current.actions.set(selectedAgentId, nextActions);
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
  }, [refreshManagement, selectedAgentId]);

  const notifyAuthenticationChanged = useCallback(() => {
    void refreshAuthentication();
  }, [refreshAuthentication]);

  const watchAccountFlow = useCallback(
    async (
      agentId: string,
      expectPending: boolean,
      expectedAction?: string
    ) => {
      const watchId = ++authWatchGeneration.current;
      const deadline = Date.now() + 15 * 60 * 1000;
      let sawPending = false;
      let completedAction: string | null = null;
      let consecutiveErrors = 0;
      try {
        while (Date.now() < deadline) {
          if (authWatchGeneration.current !== watchId) return;
          if (!completedAction) {
            let flow;
            try {
              flow = await agentManagementApi.accountFlow(agentId);
              consecutiveErrors = 0;
            } catch (error) {
              consecutiveErrors += 1;
              if ((!expectPending && !sawPending) || consecutiveErrors >= 3) {
                if (expectPending || sawPending) {
                  toast.error(
                    errorMessage(
                      error,
                      t('settings:agents.accountFlowCommandFailed')
                    )
                  );
                }
                return;
              }
              await new Promise((resolve) => {
                window.setTimeout(resolve, 1000);
              });
              continue;
            }
            if (authWatchGeneration.current !== watchId) return;
            if (flow.status === 'pending') {
              sawPending = true;
              if (flow.action_id) {
                setActionRunning(flow.action_id);
              }
            } else if (flow.status === 'succeeded') {
              completedAction = flow.action_id ?? expectedAction ?? 'login';
            } else if (flow.status === 'failed') {
              toast.error(t('settings:agents.accountFlowCommandFailed'));
              return;
            } else if (!expectPending && !sawPending) {
              return;
            } else if (expectPending && flow.status === 'idle') {
              completedAction = expectedAction ?? 'login';
            }
          }
          if (completedAction) {
            const authentication = await refreshAuthentication();
            if (authWatchGeneration.current !== watchId) return;
            if (accountSessionMatchesAction(completedAction, authentication)) {
              return;
            }
          }
          await new Promise((resolve) => {
            window.setTimeout(resolve, 1000);
          });
        }
      } finally {
        if (authWatchGeneration.current === watchId) {
          setActionRunning(null);
        }
      }
    },
    [refreshAuthentication, t]
  );

  useEffect(() => {
    authWatchGeneration.current += 1;
    setActionRunning(null);
    return () => {
      authWatchGeneration.current += 1;
    };
  }, [selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId || registryOpen) return;
    void watchAccountFlow(selectedAgentId, false);
  }, [registryOpen, selectedAgentId, watchAccountFlow]);

  const runManagementAction = useCallback(
    async (actionId: string) => {
      if (!selectedAgentId) return;
      const watchIdAtStart = authWatchGeneration.current;
      setActionRunning(actionId);
      try {
        await agentManagementApi.runAction(selectedAgentId, actionId);
        if (selectedAgentId === 'kimi_code' && actionId === 'login') {
          setConfig(await agentManagementApi.readConfig(selectedAgentId));
        }
        toast.success(
          actionId === 'subscription'
            ? t('settings:agents.subscriptionOpened')
            : selectedAgentId === 'antigravity' && actionId === 'login'
              ? t('settings:agents.browserLoginStarted')
              : t('settings:agents.terminalFlowStarted')
        );
        if (actionId === 'login' || actionId === 'logout') {
          await watchAccountFlow(selectedAgentId, true, actionId);
        }
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.accountFlowFailed'))
        );
      } finally {
        if (
          authWatchGeneration.current === watchIdAtStart ||
          (actionId !== 'login' && actionId !== 'logout')
        ) {
          setActionRunning(null);
        }
      }
    },
    [selectedAgentId, t, watchAccountFlow]
  );

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
                  presentPreflightItems(report.items).filter(
                    (item) => !isAuthPreflightItem(item)
                  )
                )
              : enabledAgent.lifecycle === 'uninstalled'
                ? 'install'
                : enabledAgent.lifecycle === 'needs_repair'
                  ? 'repair'
                  : null;
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

  const queueRepair = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      const receipt = await agentManagementApi.repair(selectedAgentId);
      management.beginOperation(receipt);
      toast.success(t('settings:agents.repairStarted'));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.operationStartFailed'))
      );
    }
  }, [management, selectedAgentId, t]);

  const queueInstall = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      const receipt = await agentManagementApi.addAndInstall(selectedAgentId);
      management.beginOperation(receipt);
      toast.success(t('settings:agents.installStarted'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.installStartFailed')));
    }
  }, [management, selectedAgentId, t]);

  const queueVersionInstall = useCallback(
    async (input: {
      version?: string;
      runtimeVersion?: string;
      acpVersion?: string;
    }) => {
      if (!selectedAgentId) return;
      const version =
        input.acpVersion || input.runtimeVersion || input.version || '';
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
      const acpItem = preflight?.items.find((item) => item.id === 'acp');
      const hasUpdate =
        comparison.update_available ||
        agentHasAcpUpdate(comparison, acpItem?.version);
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
  }, [applyBackgroundUpdateCheck, preflight, selectedAgentId, t]);

  const applyUpdate = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.applyUpdate(selectedAgentId);
      toast.success(t('settings:agents.updateStarted'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.updateStartFailed')));
    }
  }, [selectedAgentId, t]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!selectedAgentId) return;
      let updatedAgent;
      try {
        updatedAgent = await agentManagementApi.setEnabled(
          selectedAgentId,
          enabled
        );
        management.mergeAgent(updatedAgent);
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.enableUpdateFailed'))
        );
        return;
      }
      if (!enabled) return;
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
            presentPreflightItems(report.items).filter(
              (item) => !isAuthPreflightItem(item)
            )
          )
        : agent.lifecycle === 'uninstalled'
          ? 'install'
          : agent.lifecycle === 'needs_repair'
            ? 'repair'
            : null;
      if (action === 'install') return queueInstall();
      if (action === 'repair') return queueRepair();
      const comparison = await applyBackgroundUpdateCheck(selectedAgentId);
      const acpItem = report?.items.find((item) => item.id === 'acp');
      if (
        comparison?.update_available ||
        (comparison && agentHasAcpUpdate(comparison, acpItem?.version))
      ) {
        await applyUpdate();
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
      const item = preflight?.items.find((entry) => entry.id === itemId);
      if (!item?.update_available || !selectedAgentId) return;
      const grouped = item.update_group
        ? (preflight?.items.filter(
            (entry) =>
              entry.update_group === item.update_group && entry.update_available
          ) ?? [item])
        : [item];
      const confirmed = await AgentUpdateConfirmDialog.show({ items: grouped });
      if (confirmed !== 'confirmed') return;
      await applyUpdate();
    },
    [applyUpdate, preflight, selectedAgentId]
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

  const rollback = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      management.mergeAgent(await agentManagementApi.rollback(selectedAgentId));
      toast.success(t('settings:agents.rollbackComplete'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.rollbackFailed')));
    }
  }, [management, selectedAgentId, t]);

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

  const saveConfig = useCallback(
    async (
      request: AgentNativeConfigPatchRequest,
      options?: { refreshAuth?: boolean }
    ) => {
      setSavingConfig(true);
      try {
        setConfig(await agentManagementApi.writeConfig(request));
        setConfigConflict(null);
        if (options?.refreshAuth) await refreshAuthentication();
        else await management.refresh();
      } catch (error) {
        if (isConfigConflict(error)) {
          const external = await agentManagementApi.readConfig(
            request.agent_id
          );
          setConfig(external);
          setConfigConflict({
            kind: 'fields',
            message: errorMessage(
              error,
              t('settings:agents.configExternallyModified')
            ),
            request,
          });
          toast.warning(t('settings:agents.configConflictDetected'));
        } else {
          toast.error(
            errorMessage(error, t('settings:agents.configSaveFailed'))
          );
        }
      } finally {
        setSavingConfig(false);
      }
    },
    [management, refreshAuthentication, t]
  );

  const saveConfigFile = useCallback(
    async (request: AgentNativeConfigFileWriteRequest) => {
      setSavingConfig(true);
      try {
        setConfig(await agentManagementApi.writeConfigFile(request));
        setConfigConflict(null);
        toast.success(t('settings:agents.configFileSaved'));
        await management.refresh();
      } catch (error) {
        if (isConfigConflict(error)) {
          setConfig(await agentManagementApi.readConfig(request.agent_id));
          setConfigConflict({
            kind: 'file',
            message: errorMessage(
              error,
              t('settings:agents.configExternallyModified')
            ),
            request,
          });
          toast.warning(t('settings:agents.configConflictDetected'));
        } else {
          toast.error(
            errorMessage(error, t('settings:agents.configFileSaveFailed'))
          );
        }
      } finally {
        setSavingConfig(false);
      }
    },
    [management, t]
  );

  const reloadConflict = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      setConfig(await agentManagementApi.readConfig(selectedAgentId));
      toast.success(t('settings:agents.configReloaded'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.configReloadFailed')));
    }
  }, [selectedAgentId, t]);

  const overwriteConflict = useCallback(async () => {
    if (!configConflict || !config) return;
    setSavingConfig(true);
    try {
      if (configConflict.kind === 'fields') {
        const revisions = Object.fromEntries(
          config.fields
            .filter((field) => field.id in configConflict.request.fields)
            .map((field) => [field.id, field.revision])
        );
        setConfig(
          await agentManagementApi.writeConfig({
            ...configConflict.request,
            base_field_revisions: revisions,
          })
        );
      } else {
        const file = config.files.find(
          (candidate) => candidate.path === configConflict.request.path
        );
        if (!file) throw new Error(t('settings:agents.configFileMissing'));
        setConfig(
          await agentManagementApi.writeConfigFile({
            ...configConflict.request,
            base_revision: file.revision,
          })
        );
      }
      setConfigConflict(null);
      toast.success(t('settings:agents.configOverwritten'));
      await management.refresh();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.configOverwriteFailed'))
      );
    } finally {
      setSavingConfig(false);
    }
  }, [config, configConflict, management, t]);

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
    // 一键已读 = 全部标记已读并清空列表;已读记录不再显示,新诊断照常出现。
    setDiagnostics([]);
    void agentManagementApi
      .markDiagnosticsRead(selectedAgentId)
      .catch(() => undefined);
  }, [selectedAgentId]);

  if (management.loading && management.state.agents.length === 0) {
    return <AgentSettingsLoading />;
  }

  const authenticationPanel =
    selectedAgent?.agent_id === 'deepseek_harness' ? (
      <AgentLockedSurface locked={agentLocked}>
        <DshAuthPanel
          locked={agentLocked}
          onDirtyChange={setDshProviderDirty}
          onChanged={notifyAuthenticationChanged}
        />
      </AgentLockedSurface>
    ) : selectedAgent && hasAuthenticationMode ? (
      <AgentLockedSurface locked={agentLocked}>
        <AgentAuthModeControl
          key={selectedAgent.agent_id}
          actions={actions}
          actionRunning={actionRunning}
          authentication={selectedAgent.authentication}
          agentId={selectedAgent.agent_id}
          busy={Boolean(
            agentLocked ||
              selectedAgent.retired ||
              selectedAgent.active_operation ||
              management.state.operations[selectedAgent.agent_id]
          )}
          headingExtra={
            liveConfig ? (
              <AgentConfigPathMeta
                paths={configFilePathsForSurface(liveConfig, 'authentication')}
                saving={savingConfig}
              />
            ) : null
          }
          configuration={
            liveConfig?.fields.some(
              (field) => (field.surface ?? 'configuration') === 'authentication'
            )
              ? (mode) => (
                  <AgentConfigurationAndDiagnostics
                    config={configForAuthMode(
                      selectedAgent.agent_id,
                      mode,
                      liveConfig
                    )}
                    fieldSurface="authentication"
                    locked={agentLocked}
                    saving={savingConfig}
                    conflictMessage={configConflict?.message}
                    embedded
                    onSave={(request) =>
                      saveConfig(request, { refreshAuth: true })
                    }
                    onReloadConflict={() => void reloadConflict()}
                    onAdoptExternal={() => setConfigConflict(null)}
                    onOverwriteConflict={() => void overwriteConflict()}
                    onDirtyChange={setAuthConfigurationDirty}
                  />
                )
              : undefined
          }
          configurationOnAccount={(mode) =>
            selectedAgent.agent_id === 'antigravity' &&
            mode === 'oauth-business'
          }
          modelProvider={
            selectedAgent.agent_id === 'opencode' ||
            selectedAgent.agent_id === 'mimo_code' ? (
              <OpenCodeProviderConnections
                agentId={selectedAgent.agent_id}
                surface="provider"
                onDirtyChange={setOpenCodeProviderDirty}
                onChanged={notifyAuthenticationChanged}
              />
            ) : liveConfig?.settings_features.includes(
                'reusable_model_providers'
              ) ||
              selectedAgent.settings_features?.includes(
                'reusable_model_providers'
              ) ? (
              <AgentModelProviderManager
                agentId={selectedAgent.agent_id}
                disabled={savingConfig || agentLocked}
                embedded
                signedIn={
                  selectedAgent.authentication === 'account' ||
                  selectedAgent.authentication === 'multiple_unknown'
                }
                onDirtyChange={setModelProviderDirty}
                onChanged={notifyAuthenticationChanged}
              />
            ) : undefined
          }
          onChanged={notifyAuthenticationChanged}
          onDirtyChange={setAuthModeDirty}
          onAuthenticated={notifyAuthenticationChanged}
          onRunAction={(actionId) => void runManagementAction(actionId)}
          accountExtra={
            selectedAgent.agent_id === 'opencode' ? (
              <OpenCodeSubscriptionPanel
                onDirtyChange={setOpenCodeProviderDirty}
                onChanged={notifyAuthenticationChanged}
              />
            ) : undefined
          }
          nativeCredentialPresent={(fieldId) =>
            Boolean(
              liveConfig?.fields.some(
                (field) => field.id === fieldId && field.present
              )
            )
          }
          locked={agentLocked}
        />
      </AgentLockedSurface>
    ) : null;

  return (
    <div className="agent-settings-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-24">
      <AgentBar
        agents={sortAgentsForBar(
          management.state.agents,
          userConfig?.executor_profile.executor ?? null
        )}
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
        <div className="space-y-4">
          <div className="space-y-4">
            <AgentDetail
              agent={selectedAgent}
              operation={
                management.state.operations[selectedAgent.agent_id] ?? null
              }
              preflight={preflight}
              authentication={authenticationPanel}
              diagnostics={diagnostics}
              focusDiagnostics={focusDiagnostics}
              onMarkAllDiagnosticsRead={markAllDiagnosticsRead}
              checking={checking}
              checkingUpdate={checkingUpdate}
              updateCheck={updateCheck}
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
              onRollback={() => void rollback()}
              onCancelOperation={() => void cancelOperation()}
              onUninstall={(options) => void uninstall(options)}
              onRemove={() => void remove()}
              onExportDiagnostics={exportDiagnostics}
              onEnvironmentDiagnostics={
                selectedAgent.built_in ||
                selectedAgent.settings_features?.includes('authentication_mode')
                  ? () =>
                      setEnvironmentDiagnosticsAgentId(selectedAgent.agent_id)
                  : undefined
              }
            />
            {environmentDiagnosticsAgentId ? (
              <AgentEnvironmentDiagnosticsDialog
                agentId={environmentDiagnosticsAgentId}
                open
                onOpenChange={(open) => {
                  if (!open) setEnvironmentDiagnosticsAgentId(null);
                }}
              />
            ) : null}
            {selectedAgent.source === 'user_definition' ? (
              <UserAgentDefinitionPanel
                definition={userDefinition}
                loading={savingUserDefinition}
                operationActive={Boolean(
                  selectedAgent.active_operation ||
                    management.state.operations[selectedAgent.agent_id]
                )}
                onSave={saveUserDefinition}
                onReinstall={() => void reinstallUserDefinition()}
                onDirtyChange={setUserDefinitionDirty}
              />
            ) : null}

            {selectedAgent.agent_id === 'deepseek_harness' ? (
              <AgentLockedSurface locked={agentLocked}>
                <DshSessionDefaults
                  onDirtyChange={setConfigurationDirty}
                  onChanged={async () => {
                    await management.refresh();
                  }}
                />
              </AgentLockedSurface>
            ) : (
              <AgentLockedSurface locked={agentLocked}>
                <AgentConfigurationAndDiagnostics
                  config={config}
                  locked={agentLocked}
                  fieldSurface={
                    config?.settings_features.includes('authentication_mode')
                      ? 'configuration'
                      : undefined
                  }
                  saving={savingConfig}
                  conflictMessage={configConflict?.message}
                  onSave={(request) => saveConfig(request)}
                  onSaveFile={(request) => void saveConfigFile(request)}
                  onReloadConflict={() => void reloadConflict()}
                  onAdoptExternal={() => setConfigConflict(null)}
                  onOverwriteConflict={() => void overwriteConflict()}
                  onDirtyChange={setConfigurationDirty}
                />
              </AgentLockedSurface>
            )}
            <AgentLockedSurface locked={agentLocked}>
              <AgentEnvironmentEditor
                key={`environment:${selectedAgent.agent_id}`}
                agentId={selectedAgent.agent_id}
                disabled={Boolean(
                  agentLocked ||
                    selectedAgent.retired ||
                    selectedAgent.active_operation ||
                    management.state.operations[selectedAgent.agent_id]
                )}
                onChanged={async () => {
                  await management.refresh();
                }}
                onDirtyChange={setEnvironmentDirty}
              />
            </AgentLockedSurface>
          </div>
          {selectedAgent.agent_id === 'deepseek_harness' ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
              summary={t('settings:agents.pluginCount', { count: pluginCount })}
            >
              <DshPluginManager
                onChanged={runPreflight}
                onCount={setPluginCount}
              />
            </CollapsibleSettingsSection>
          ) : selectedAgent.agent_id === 'opencode' ||
            selectedAgent.agent_id === 'mimo_code' ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
              summary={t('settings:agents.pluginCount', { count: pluginCount })}
            >
              <OpenCodePluginHealth
                agentId={selectedAgent.agent_id}
                onChanged={runPreflight}
                onCount={setPluginCount}
              />
            </CollapsibleSettingsSection>
          ) : selectedAgent.agent_id === 'grok' ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
              summary={t('settings:agents.pluginCount', { count: pluginCount })}
            >
              <GrokPluginManager
                onChanged={runPreflight}
                onCount={setPluginCount}
              />
            </CollapsibleSettingsSection>
          ) : selectedAgent.agent_id === 'pi' ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
              summary={t('settings:agents.pluginCount', { count: pluginCount })}
            >
              <PiPluginManager
                onChanged={runPreflight}
                onCount={setPluginCount}
              />
            </CollapsibleSettingsSection>
          ) : nativePluginEcosystem ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
              summary={t('settings:agents.pluginCount', { count: pluginCount })}
            >
              <PluginsSettings ecosystem={nativePluginEcosystem} embedded />
            </CollapsibleSettingsSection>
          ) : null}
        </div>
      ) : (
        <section className="settings-surface flex min-h-44 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('settings:agents.emptyList')}
        </section>
      )}
    </div>
  );
}

function accountSessionMatchesAction(
  actionId: string,
  authentication: AgentAuthenticationStatus | null | undefined
): boolean {
  const signedIn =
    authentication === 'account' || authentication === 'multiple_unknown';
  if (actionId === 'logout') return !signedIn;
  if (actionId === 'login') return signedIn;
  return true;
}

function applyUpdateCheckToPreflight(
  current: AgentPreflightView,
  check: AgentUpdateCheckView
): AgentPreflightView {
  return {
    ...current,
    items: current.items.map((item) => {
      if (item.id === 'acp') {
        const acpUpdate = agentHasAcpUpdate(check, item.version);
        return {
          ...item,
          update_available: acpUpdate,
          available_version: acpUpdate ? (check.acp_available ?? null) : null,
          update_group: null,
        };
      }
      return item;
    }),
  };
}

function applyInstallationToPreflight(
  current: AgentPreflightView | null,
  agent: AgentManagementView
): AgentPreflightView {
  const items = [...(current?.items ?? [])].filter(
    (item) => item.id !== 'runtime'
  );
  const patch = (version: string | null) => {
    const index = items.findIndex((item) => item.id === 'acp');
    const previous = index >= 0 ? items[index] : null;
    const available = Boolean(version);
    const next: AgentPreflightItemView = {
      id: 'acp',
      label: previous?.label ?? 'ACP 适配器',
      status: available ? 'pass' : (previous?.status ?? 'fail'),
      detail: available ? '' : (previous?.detail ?? ''),
      version,
      path: previous?.path ?? null,
      source: previous?.source ?? null,
      repairable: !available,
      update_available: false,
      available_version: null,
      update_group: previous?.update_group ?? null,
    };
    if (index >= 0) {
      items[index] = { ...previous, ...next };
    } else {
      items.push(next);
    }
  };
  patch(agent.acp_version);
  return {
    agent_id: agent.agent_id,
    checked_at: new Date().toISOString(),
    items,
  };
}

function isConfigConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'config_conflict'
  );
}
