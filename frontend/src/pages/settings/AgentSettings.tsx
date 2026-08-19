import { Loader2, Puzzle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDiagnosticView,
  AgentId,
  AgentManagementActionsView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigView,
  AgentPreflightView,
  AgentRegistryView,
  AgentRegistryViewRow,
  AgentUpdateCheckView,
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
  useAgentManagement,
} from '@/features/agent-management';

import { AgentBar } from './AgentBar';
import {
  AgentConfigPathMeta,
  AgentConfigurationAndDiagnostics,
  configFilePathsForSurface,
} from './AgentConfigurationAndDiagnostics';
import { AgentDetail } from './AgentDetail';
import { AgentAuthModeControl } from './AgentAuthModeControl';
import { AgentEnvironmentEditor } from './AgentEnvironmentEditor';
import { AgentEnvironmentDiagnosticsDialog } from './AgentEnvironmentDiagnosticsDialog';
import { AgentModelProviderManager } from './AgentModelProviderManager';
import { AgentRegistryViewPanel } from './AgentRegistryView';
import { OpenCodeProviderConnections } from './OpenCodeProviderConnections';
import { OpenCodePluginHealth } from './OpenCodePluginHealth';
import { DshAuthPanel } from './DshAuthPanel';
import { DshPluginManager } from './DshPluginManager';
import { GrokPluginManager } from './GrokPluginManager';
import { DshSessionDefaults } from './DshSessionDefaults';
import { PluginsSettings, type PluginEcosystem } from './PluginsSettings';
import { SettingsSection as CollapsibleSettingsSection } from './SettingsSection';
import { UserAgentDefinitionPanel } from './UserAgentDefinitionPanel';

export function AgentSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const management = useAgentManagement();
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
  const [nativePluginsExpanded, setNativePluginsExpanded] = useState(false);
  const configDirty = Object.values(dirtySources).some(Boolean);
  const setDirtySource = useCallback((source: string, dirty: boolean) => {
    setDirtySources((current) =>
      current[source] === dirty ? current : { ...current, [source]: dirty }
    );
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
  const selectedAgentSource = selectedAgent?.source ?? null;
  const selectedAgentLifecycle = selectedAgent?.lifecycle ?? null;
  const selectedAgentOperation = selectedAgent?.active_operation ?? null;
  const nativePluginEcosystem: PluginEcosystem | null =
    selectedAgentId === 'codex'
      ? 'codex'
      : selectedAgentId === 'claude_code'
        ? 'claude_code'
        : null;
  const refreshManagement = management.refresh;

  useEffect(() => {
    if (!configDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [configDirty]);

  const confirmDiscardConfig = useCallback(async () => {
    if (!configDirty) return true;
    const result = await ConfirmDialog.show({
      title: t('settings:agents.unsavedConfigTitle'),
      message: t('settings:agents.unsavedConfigMessage'),
      confirmText: t('settings:agents.discardConfig'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return false;
    setDirtySources({});
    return true;
  }, [configDirty, t]);

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
    setPreflight(null);
    setActions(null);
    setConfig(null);
    setConfigConflict(null);
    setUpdateCheck(null);
    void Promise.allSettled([
      agentManagementApi.readConfig(selectedAgentId),
      agentManagementApi.diagnostics(selectedAgentId),
      agentManagementApi.actions(selectedAgentId),
    ]).then(([configResult, diagnosticResult, actionsResult]) => {
      if (!active) return;
      if (configResult.status === 'fulfilled') {
        setConfig(configResult.value);
        void refreshManagement().catch(() => undefined);
      }
      if (diagnosticResult.status === 'fulfilled') {
        // 已读诊断不再显示;未读的新诊断照常出现。
        setDiagnostics(
          diagnosticResult.value.filter((diagnostic) => !diagnostic.read)
        );
      }
      if (actionsResult.status === 'fulfilled') {
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

  const runPreflight = useCallback(async () => {
    if (!selectedAgentId) return;
    setChecking(true);
    try {
      setPreflight(await agentManagementApi.preflight(selectedAgentId));
      await management.refresh();
      toast.success(t('settings:agents.preflightComplete'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.preflightFailed')));
    } finally {
      setChecking(false);
    }
  }, [management, selectedAgentId, t]);

  const runManagementAction = useCallback(
    async (actionId: string) => {
      if (!selectedAgentId) return;
      setActionRunning(actionId);
      try {
        await agentManagementApi.runAction(selectedAgentId, actionId);
        if (selectedAgentId === 'kimi_code' && actionId === 'login') {
          setConfig(await agentManagementApi.readConfig(selectedAgentId));
        }
        toast.success(
          actionId === 'subscription'
            ? t('settings:agents.subscriptionOpened')
            : t('settings:agents.terminalFlowStarted')
        );
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.accountFlowFailed'))
        );
      } finally {
        setActionRunning(null);
      }
    },
    [selectedAgentId, t]
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!selectedAgentId) return;
      try {
        management.mergeAgent(
          await agentManagementApi.setEnabled(selectedAgentId, enabled)
        );
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.enableUpdateFailed'))
        );
      }
    },
    [management, selectedAgentId, t]
  );

  const reorder = useCallback(
    async (order: string[]) => {
      try {
        await agentManagementApi.reorder(order);
        await management.refresh();
      } catch (error) {
        toast.error(errorMessage(error, t('settings:agents.reorderFailed')));
        await management.refresh().catch(() => undefined);
      }
    },
    [management, t]
  );

  const queueRepair = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.repair(selectedAgentId);
      toast.success(t('settings:agents.repairStarted'));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.operationStartFailed'))
      );
    }
  }, [selectedAgentId, t]);

  const queueInstall = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.addAndInstall(selectedAgentId);
      toast.success(t('settings:agents.installStarted'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.installStartFailed')));
    }
  }, [selectedAgentId, t]);

  const queueVersionInstall = useCallback(
    async (version: string) => {
      if (!selectedAgentId) return;
      try {
        await agentManagementApi.installVersion(selectedAgentId, version);
        toast.success(
          t('settings:agents.customVersionInstallStarted', { version })
        );
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.installStartFailed'))
        );
      }
    },
    [selectedAgentId, t]
  );

  const checkUpdate = useCallback(async () => {
    if (!selectedAgentId) return;
    setCheckingUpdate(true);
    try {
      const comparison = await agentManagementApi.checkUpdate(selectedAgentId);
      setUpdateCheck(comparison);
      toast.success(
        comparison.update_available
          ? t('settings:agents.updateAvailable')
          : t('settings:agents.upToDate')
      );
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.updateCheckFailed')));
    } finally {
      setCheckingUpdate(false);
    }
  }, [selectedAgentId, t]);

  const applyUpdate = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.applyUpdate(selectedAgentId);
      toast.success(t('settings:agents.updateStarted'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.updateStartFailed')));
    }
  }, [selectedAgentId, t]);

  const uninstall = useCallback(async () => {
    if (!selectedAgentId) return;
    const result = await ConfirmDialog.show({
      title: t('settings:agents.uninstallTitle', {
        agent: selectedAgent?.display_name ?? selectedAgentId,
      }),
      message: t('settings:agents.uninstallMessage'),
      confirmText: t('settings:agents.uninstallConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    try {
      management.mergeAgent(
        await agentManagementApi.uninstall(selectedAgentId)
      );
      toast.success(t('settings:agents.uninstalled'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.uninstallFailed')));
    }
  }, [management, selectedAgent?.display_name, selectedAgentId, t]);

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
    async (request: AgentNativeConfigPatchRequest) => {
      setSavingConfig(true);
      try {
        setConfig(await agentManagementApi.writeConfig(request));
        setConfigConflict(null);
        toast.success(t('settings:agents.configSaved'));
        await management.refresh();
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
    [management, t]
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
    return (
      <div className="space-y-4" aria-label={t('settings:agents.loadingAgent')}>
        <div className="agent-management-bar animate-pulse">
          <span aria-hidden="true" className="agent-management-bar-surface" />
        </div>
        <div className="settings-surface flex min-h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="agent-settings-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-24">
      <div className="flex shrink-0 items-center gap-2">
        <AgentBar
          agents={management.state.agents}
          selectedAgentId={management.state.selectedAgentId}
          registryOpen={registryOpen}
          onSelect={(agentId) =>
            void (async () => {
              if (!(await confirmDiscardConfig())) return;
              management.select(agentId);
              setRegistryOpen(false);
            })()
          }
          onOpenRegistry={() =>
            void (async () => {
              if (await confirmDiscardConfig()) setRegistryOpen(true);
            })()
          }
          onReorder={(order) => void reorder(order)}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-9 w-9 shrink-0 p-0"
          aria-label={t('settings:agents.refreshStatusAria')}
          aria-busy={management.loading}
          disabled={management.loading}
          onClick={() => void management.refreshFresh().catch(() => undefined)}
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${
              management.loading ? 'animate-spin' : ''
            }`}
          />
        </Button>
      </div>

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
              authentication={
                selectedAgent.agent_id === 'deepseek_harness' ? (
                  <DshAuthPanel
                    onDirtyChange={setDshProviderDirty}
                    onChanged={async () => {
                      setConfig(
                        await agentManagementApi.readConfig(
                          selectedAgent.agent_id
                        )
                      );
                      await management.refresh();
                      await runPreflight();
                    }}
                  />
                ) : config?.settings_features.includes(
                    'authentication_mode'
                  ) ? (
                  <AgentAuthModeControl
                    actions={actions}
                    actionRunning={actionRunning}
                    agentId={selectedAgent.agent_id}
                    busy={Boolean(
                      selectedAgent.retired ||
                        selectedAgent.active_operation ||
                        management.state.operations[selectedAgent.agent_id]
                    )}
                    headingExtra={
                      <AgentConfigPathMeta
                        paths={configFilePathsForSurface(
                          config,
                          'authentication'
                        )}
                        saving={savingConfig}
                      />
                    }
                    configuration={
                      config.fields.some(
                        (field) =>
                          (field.surface ?? 'configuration') ===
                          'authentication'
                      ) ? (
                        <AgentConfigurationAndDiagnostics
                          config={config}
                          fieldSurface="authentication"
                          saving={savingConfig}
                          conflictMessage={configConflict?.message}
                          embedded
                          onSave={(request) => void saveConfig(request)}
                          onReloadConflict={() => void reloadConflict()}
                          onAdoptExternal={() => setConfigConflict(null)}
                          onOverwriteConflict={() => void overwriteConflict()}
                          onDirtyChange={setAuthConfigurationDirty}
                        />
                      ) : undefined
                    }
                    modelProvider={
                      config.settings_features.includes(
                        'reusable_model_providers'
                      ) ? (
                        <AgentModelProviderManager
                          agentId={selectedAgent.agent_id}
                          disabled={savingConfig}
                          embedded
                          onDirtyChange={setModelProviderDirty}
                        />
                      ) : undefined
                    }
                    onChanged={runPreflight}
                    onDirtyChange={setAuthModeDirty}
                    onAuthenticated={runPreflight}
                    onRunAction={(actionId) =>
                      void runManagementAction(actionId)
                    }
                    nativeCredentialPresent={(fieldId) =>
                      config.fields.some(
                        (field) => field.id === fieldId && field.present
                      )
                    }
                  />
                ) : null
              }
              diagnostics={diagnostics}
              onMarkAllDiagnosticsRead={markAllDiagnosticsRead}
              checking={checking}
              checkingUpdate={checkingUpdate}
              updateCheck={updateCheck}
              onSetEnabled={(enabled) => void setEnabled(enabled)}
              onPreflight={() => void runPreflight()}
              onInstall={() => void queueInstall()}
              onInstallVersion={(version) => void queueVersionInstall(version)}
              onRepair={() => void queueRepair()}
              onCheckUpdate={() => void checkUpdate()}
              onApplyUpdate={() => void applyUpdate()}
              onRollback={() => void rollback()}
              onCancelOperation={() => void cancelOperation()}
              onUninstall={() => void uninstall()}
              onRemove={() => void remove()}
              onExportDiagnostics={exportDiagnostics}
              onEnvironmentDiagnostics={
                selectedAgent.built_in
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
            <AgentEnvironmentEditor
              key={`environment:${selectedAgent.agent_id}`}
              agentId={selectedAgent.agent_id}
              disabled={Boolean(
                selectedAgent.retired ||
                  selectedAgent.active_operation ||
                  management.state.operations[selectedAgent.agent_id]
              )}
              onChanged={async () => {
                await management.refresh();
              }}
              onDirtyChange={setEnvironmentDirty}
            />
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
            {config?.settings_features.includes('open_code_providers') ||
            config?.settings_features.includes('open_code_plugins') ? (
              <>
                {config.settings_features.includes('open_code_providers') ? (
                  <OpenCodeProviderConnections
                    onDirtyChange={setOpenCodeProviderDirty}
                    onChanged={async () => {
                      setConfig(
                        await agentManagementApi.readConfig(
                          selectedAgent.agent_id
                        )
                      );
                      await management.refresh();
                    }}
                  />
                ) : null}
                {config.settings_features.includes('open_code_plugins') ? (
                  <OpenCodePluginHealth onChanged={runPreflight} />
                ) : null}
              </>
            ) : null}
            {selectedAgent.agent_id === 'deepseek_harness' ? (
              <DshSessionDefaults
                onDirtyChange={setConfigurationDirty}
                onChanged={async () => {
                  await management.refresh();
                }}
              />
            ) : (
              <AgentConfigurationAndDiagnostics
                config={config}
                fieldSurface={
                  config?.settings_features.includes('authentication_mode')
                    ? 'configuration'
                    : undefined
                }
                saving={savingConfig}
                conflictMessage={configConflict?.message}
                onSave={(request) => void saveConfig(request)}
                onSaveFile={(request) => void saveConfigFile(request)}
                onReloadConflict={() => void reloadConflict()}
                onAdoptExternal={() => setConfigConflict(null)}
                onOverwriteConflict={() => void overwriteConflict()}
                onDirtyChange={setConfigurationDirty}
              />
            )}
          </div>
          {selectedAgent.agent_id === 'deepseek_harness' ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              icon={Puzzle}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
            >
              <DshPluginManager onChanged={runPreflight} />
            </CollapsibleSettingsSection>
          ) : selectedAgent.agent_id === 'grok' ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              icon={Puzzle}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
            >
              <GrokPluginManager onChanged={runPreflight} />
            </CollapsibleSettingsSection>
          ) : nativePluginEcosystem ? (
            <CollapsibleSettingsSection
              id={`${selectedAgent.agent_id}-native-plugins`}
              title={t('settings:agents.pluginsTab')}
              icon={Puzzle}
              expanded={nativePluginsExpanded}
              onToggle={() => setNativePluginsExpanded((current) => !current)}
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

function isConfigConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'config_conflict'
  );
}
