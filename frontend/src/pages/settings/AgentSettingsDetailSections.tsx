import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDiagnosticView,
  AgentId,
  AgentManagementActionsView,
  AgentManagementView,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
  AgentPreflightView,
  AgentUpdateCheckView,
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
} from 'shared/types';

import type { AgentOperationState } from '@/features/agent-management';

import { AgentAuthModeControl } from './AgentAuthModeControl';
import {
  AgentConfigPathMeta,
  AgentConfigurationAndDiagnostics,
  configFilePathsForSurface,
  configForAuthMode,
} from './AgentConfigurationAndDiagnostics';
import { AgentDetail } from './AgentDetail';
import { AgentEnvironmentDiagnosticsDialog } from './AgentEnvironmentDiagnosticsDialog';
import { AgentEnvironmentEditor } from './AgentEnvironmentEditor';
import { AgentModelProviderManager } from './AgentModelProviderManager';
import { DshAuthPanel } from './DshAuthPanel';
import { DshPluginManager } from './DshPluginManager';
import { DshSessionDefaults } from './DshSessionDefaults';
import { GrokPluginManager } from './GrokPluginManager';
import { OpenCodePluginHealth } from './OpenCodePluginHealth';
import { OpenCodeProviderConnections } from './OpenCodeProviderConnections';
import { OpenCodeSubscriptionPanel } from './OpenCodeSubscriptionPanel';
import { PiPluginManager } from './PiPluginManager';
import { PluginsSettings, type PluginEcosystem } from './PluginsSettings';
import { SettingsSection as CollapsibleSettingsSection } from './SettingsSection';
import { AgentLockedSurface } from './SettingsUi';
import { UserAgentDefinitionPanel } from './UserAgentDefinitionPanel';

type AgentSettingsDetailSectionsProps = {
  selectedAgent: AgentManagementView;
  liveConfig: AgentNativeConfigView | null;
  config: AgentNativeConfigView | null;
  hasAuthenticationMode: boolean;
  agentLocked: boolean;
  providerRefreshKey: number;
  actions: AgentManagementActionsView | null;
  actionRunning: string | null;
  operations: Record<string, AgentOperationState | undefined>;
  enablingOperation: (AgentOperationState & { agentId: AgentId }) | null;
  preflight: AgentPreflightView | null;
  diagnostics: AgentDiagnosticView[];
  focusDiagnostics: boolean;
  checking: boolean;
  checkingUpdate: boolean;
  updateCheck: AgentUpdateCheckView | null;
  savingConfig: boolean;
  configConflictMessage?: string;
  environmentDiagnosticsAgentId: AgentId | null;
  setEnvironmentDiagnosticsAgentId: Dispatch<SetStateAction<AgentId | null>>;
  userDefinition: UserAgentDefinitionView | null;
  savingUserDefinition: boolean;
  nativePluginEcosystem: PluginEcosystem | null;
  nativePluginsExpanded: boolean;
  setNativePluginsExpanded: Dispatch<SetStateAction<boolean>>;
  pluginCount: number;
  setPluginCount: Dispatch<SetStateAction<number>>;
  onDirtySource: (source: string, dirty: boolean) => void;
  onNotifyAuthenticationChanged: () => void;
  onRunManagementAction: (actionId: string) => void;
  onSaveConfig: (
    request: AgentNativeConfigPatchRequest,
    options?: { refreshAuth?: boolean }
  ) => Promise<void>;
  onSaveConfigFile: (request: AgentNativeConfigFileWriteRequest) => void;
  onReloadConflict: () => void;
  onAdoptExternalConflict: () => void;
  onOverwriteConflict: () => void;
  onMarkAllDiagnosticsRead: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onPreflight: () => void;
  onInstall: () => void;
  onInstallVersion: (input: {
    version?: string;
    runtimeVersion?: string;
    acpVersion?: string;
  }) => void;
  onPreviewVersions: (input: {
    runtimeVersion?: string;
    acpVersion?: string;
  }) => Promise<string | null>;
  onRepair: () => void;
  onCheckUpdate: () => void;
  onUpdatePreflightItem: (itemId: string) => void;
  onCancelOperation: () => void;
  onUninstall: (options?: { clearData?: boolean }) => void;
  onRemove: () => void;
  onExportDiagnostics: () => void;
  onSaveUserDefinition: (
    request: UserAgentDefinitionRequest
  ) => Promise<boolean>;
  onReinstallUserDefinition: () => void;
  onRefreshManagement: () => Promise<unknown>;
};

export function AgentSettingsDetailSections({
  selectedAgent,
  liveConfig,
  config,
  hasAuthenticationMode,
  agentLocked,
  providerRefreshKey,
  actions,
  actionRunning,
  operations,
  enablingOperation,
  preflight,
  diagnostics,
  focusDiagnostics,
  checking,
  checkingUpdate,
  updateCheck,
  savingConfig,
  configConflictMessage,
  environmentDiagnosticsAgentId,
  setEnvironmentDiagnosticsAgentId,
  userDefinition,
  savingUserDefinition,
  nativePluginEcosystem,
  nativePluginsExpanded,
  setNativePluginsExpanded,
  pluginCount,
  setPluginCount,
  onDirtySource,
  onNotifyAuthenticationChanged,
  onRunManagementAction,
  onSaveConfig,
  onSaveConfigFile,
  onReloadConflict,
  onAdoptExternalConflict,
  onOverwriteConflict,
  onMarkAllDiagnosticsRead,
  onSetEnabled,
  onPreflight,
  onInstall,
  onInstallVersion,
  onPreviewVersions,
  onRepair,
  onCheckUpdate,
  onUpdatePreflightItem,
  onCancelOperation,
  onUninstall,
  onRemove,
  onExportDiagnostics,
  onSaveUserDefinition,
  onReinstallUserDefinition,
  onRefreshManagement,
}: AgentSettingsDetailSectionsProps) {
  const { t } = useTranslation(['settings', 'common']);
  const activeAgentOperation =
    operations[selectedAgent.agent_id] ??
    (enablingOperation?.agentId === selectedAgent.agent_id
      ? enablingOperation
      : null);
  const operationBusy = Boolean(
    selectedAgent.active_operation || operations[selectedAgent.agent_id]
  );

  const dirtyHandlers = useMemo(
    () => ({
      dshProvider: (dirty: boolean) => onDirtySource('dsh-provider', dirty),
      authConfiguration: (dirty: boolean) =>
        onDirtySource('auth-configuration', dirty),
      opencodeProvider: (dirty: boolean) =>
        onDirtySource('opencode-provider', dirty),
      opencodeSubscription: (dirty: boolean) =>
        onDirtySource('opencode-subscription', dirty),
      modelProvider: (dirty: boolean) => onDirtySource('model-provider', dirty),
      authMode: (dirty: boolean) => onDirtySource('auth-mode', dirty),
      userDefinition: (dirty: boolean) =>
        onDirtySource('user-definition', dirty),
      configuration: (dirty: boolean) => onDirtySource('configuration', dirty),
      environment: (dirty: boolean) => onDirtySource('environment', dirty),
    }),
    [onDirtySource]
  );

  const authenticationPanel =
    selectedAgent.agent_id === 'deepseek_harness' ? (
      <AgentLockedSurface locked={agentLocked}>
        <DshAuthPanel
          key={`deepseek_harness:${providerRefreshKey}`}
          locked={agentLocked}
          onDirtyChange={dirtyHandlers.dshProvider}
          onChanged={onNotifyAuthenticationChanged}
        />
      </AgentLockedSurface>
    ) : hasAuthenticationMode ? (
      <AgentLockedSurface locked={agentLocked}>
        <AgentAuthModeControl
          key={`${selectedAgent.agent_id}:${providerRefreshKey}`}
          actions={actions}
          actionRunning={actionRunning}
          authentication={selectedAgent.authentication}
          agentId={selectedAgent.agent_id}
          busy={Boolean(agentLocked || selectedAgent.retired || operationBusy)}
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
                    conflictMessage={configConflictMessage}
                    embedded
                    onSave={(request) =>
                      onSaveConfig(request, { refreshAuth: true })
                    }
                    onReloadConflict={onReloadConflict}
                    onAdoptExternal={onAdoptExternalConflict}
                    onOverwriteConflict={onOverwriteConflict}
                    onDirtyChange={dirtyHandlers.authConfiguration}
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
                onDirtyChange={dirtyHandlers.opencodeProvider}
                onChanged={onNotifyAuthenticationChanged}
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
                onDirtyChange={dirtyHandlers.modelProvider}
                onChanged={onNotifyAuthenticationChanged}
              />
            ) : undefined
          }
          onChanged={onNotifyAuthenticationChanged}
          onDirtyChange={dirtyHandlers.authMode}
          onAuthenticated={onNotifyAuthenticationChanged}
          onRunAction={onRunManagementAction}
          accountExtra={
            selectedAgent.agent_id === 'opencode' ? (
              <OpenCodeSubscriptionPanel
                onDirtyChange={dirtyHandlers.opencodeSubscription}
                onChanged={onNotifyAuthenticationChanged}
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
    ) : undefined;

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <AgentDetail
          agent={selectedAgent}
          operation={activeAgentOperation}
          preflight={preflight}
          authentication={authenticationPanel}
          diagnostics={diagnostics}
          focusDiagnostics={focusDiagnostics}
          onMarkAllDiagnosticsRead={onMarkAllDiagnosticsRead}
          checking={checking}
          checkingUpdate={checkingUpdate}
          updateCheck={updateCheck}
          onSetEnabled={onSetEnabled}
          onPreflight={onPreflight}
          onInstall={onInstall}
          onInstallVersion={onInstallVersion}
          onPreviewVersions={onPreviewVersions}
          onRepair={onRepair}
          onCheckUpdate={onCheckUpdate}
          onUpdatePreflightItem={onUpdatePreflightItem}
          onCancelOperation={onCancelOperation}
          onUninstall={onUninstall}
          onRemove={onRemove}
          onExportDiagnostics={onExportDiagnostics}
          onEnvironmentDiagnostics={
            selectedAgent.built_in ||
            selectedAgent.settings_features?.includes('authentication_mode')
              ? () => setEnvironmentDiagnosticsAgentId(selectedAgent.agent_id)
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
            operationActive={operationBusy}
            onSave={onSaveUserDefinition}
            onReinstall={onReinstallUserDefinition}
            onDirtyChange={dirtyHandlers.userDefinition}
          />
        ) : null}

        {selectedAgent.agent_id === 'deepseek_harness' ? (
          <AgentLockedSurface locked={agentLocked}>
            <DshSessionDefaults
              onDirtyChange={dirtyHandlers.configuration}
              onChanged={async () => {
                await onRefreshManagement();
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
              conflictMessage={configConflictMessage}
              onSave={(request) => onSaveConfig(request)}
              onSaveFile={onSaveConfigFile}
              onReloadConflict={onReloadConflict}
              onAdoptExternal={onAdoptExternalConflict}
              onOverwriteConflict={onOverwriteConflict}
              onDirtyChange={dirtyHandlers.configuration}
            />
          </AgentLockedSurface>
        )}
        <AgentLockedSurface locked={agentLocked}>
          <AgentEnvironmentEditor
            key={`environment:${selectedAgent.agent_id}`}
            agentId={selectedAgent.agent_id}
            disabled={Boolean(
              agentLocked || selectedAgent.retired || operationBusy
            )}
            onChanged={async () => {
              await onRefreshManagement();
            }}
            onDirtyChange={dirtyHandlers.environment}
          />
        </AgentLockedSurface>
      </div>
      {selectedAgent.agent_id === 'deepseek_harness' ? (
        <CollapsibleSettingsSection
          id={`${selectedAgent.agent_id}-native-plugins`}
          title={t('settings:agents.pluginsTab')}
          description={t('settings:agents.pluginsDescription')}
          expanded={nativePluginsExpanded}
          onToggle={() => setNativePluginsExpanded((current) => !current)}
          summary={t('settings:agents.pluginCount', { count: pluginCount })}
        >
          <DshPluginManager
            onChanged={onPreflight}
            onCount={setPluginCount}
          />
        </CollapsibleSettingsSection>
      ) : selectedAgent.agent_id === 'opencode' ||
        selectedAgent.agent_id === 'mimo_code' ? (
        <CollapsibleSettingsSection
          id={`${selectedAgent.agent_id}-native-plugins`}
          title={t('settings:agents.pluginsTab')}
          description={t('settings:agents.pluginsDescription')}
          expanded={nativePluginsExpanded}
          onToggle={() => setNativePluginsExpanded((current) => !current)}
          summary={t('settings:agents.pluginCount', { count: pluginCount })}
        >
          <OpenCodePluginHealth
            agentId={selectedAgent.agent_id}
            onChanged={onPreflight}
            onCount={setPluginCount}
          />
        </CollapsibleSettingsSection>
      ) : selectedAgent.agent_id === 'grok' ? (
        <CollapsibleSettingsSection
          id={`${selectedAgent.agent_id}-native-plugins`}
          title={t('settings:agents.pluginsTab')}
          description={t('settings:agents.pluginsDescription')}
          expanded={nativePluginsExpanded}
          onToggle={() => setNativePluginsExpanded((current) => !current)}
          summary={t('settings:agents.pluginCount', { count: pluginCount })}
        >
          <GrokPluginManager
            onChanged={onPreflight}
            onCount={setPluginCount}
          />
        </CollapsibleSettingsSection>
      ) : selectedAgent.agent_id === 'pi' ? (
        <CollapsibleSettingsSection
          id={`${selectedAgent.agent_id}-native-plugins`}
          title={t('settings:agents.pluginsTab')}
          description={t('settings:agents.pluginsDescription')}
          expanded={nativePluginsExpanded}
          onToggle={() => setNativePluginsExpanded((current) => !current)}
          summary={t('settings:agents.pluginCount', { count: pluginCount })}
        >
          <PiPluginManager
            onChanged={onPreflight}
            onCount={setPluginCount}
          />
        </CollapsibleSettingsSection>
      ) : nativePluginEcosystem ? (
        <CollapsibleSettingsSection
          id={`${selectedAgent.agent_id}-native-plugins`}
          title={t('settings:agents.pluginsTab')}
          description={t('settings:agents.pluginsDescription')}
          expanded={nativePluginsExpanded}
          onToggle={() => setNativePluginsExpanded((current) => !current)}
          summary={t('settings:agents.pluginCount', { count: pluginCount })}
        >
          <PluginsSettings ecosystem={nativePluginEcosystem} embedded />
        </CollapsibleSettingsSection>
      ) : null}
    </div>
  );
}
