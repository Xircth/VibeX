import { type Dispatch, type SetStateAction, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
} from 'shared/types';

import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import { isConfigConflict } from './agentSettingsPreflightHelpers';

export type ConfigConflictState =
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
  | null;

export function agentInspectCacheKey(
  agentId: AgentId,
  providerInstanceId: string | null
): string {
  return `${agentId}::${providerInstanceId ?? 'local'}`;
}

export function useAgentNativeConfigActions({
  selectedAgentId,
  activeProviderInstanceId,
  config,
  configConflict,
  setConfig,
  setConfigConflict,
  setSavingConfig,
  refreshAuthentication,
  refreshManagement,
}: {
  selectedAgentId: AgentId | null;
  activeProviderInstanceId: string | null;
  config: AgentNativeConfigView | null;
  configConflict: ConfigConflictState;
  setConfig: Dispatch<SetStateAction<AgentNativeConfigView | null>>;
  setConfigConflict: Dispatch<SetStateAction<ConfigConflictState>>;
  setSavingConfig: Dispatch<SetStateAction<boolean>>;
  refreshAuthentication: () => Promise<unknown>;
  refreshManagement: () => Promise<unknown>;
}) {
  const { t } = useTranslation(['settings', 'common']);

  const saveConfig = useCallback(
    async (
      request: AgentNativeConfigPatchRequest,
      options?: { refreshAuth?: boolean }
    ) => {
      setSavingConfig(true);
      try {
        setConfig(
          activeProviderInstanceId
            ? await agentManagementApi.writeConfig(
                request,
                activeProviderInstanceId
              )
            : await agentManagementApi.writeConfig(request)
        );
        setConfigConflict(null);
        if (options?.refreshAuth) await refreshAuthentication();
        else await refreshManagement();
      } catch (error) {
        if (isConfigConflict(error)) {
          const external = activeProviderInstanceId
            ? await agentManagementApi.readConfig(
                request.agent_id,
                activeProviderInstanceId
              )
            : await agentManagementApi.readConfig(request.agent_id);
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
    [
      activeProviderInstanceId,
      refreshAuthentication,
      refreshManagement,
      setConfig,
      setConfigConflict,
      setSavingConfig,
      t,
    ]
  );

  const saveConfigFile = useCallback(
    async (request: AgentNativeConfigFileWriteRequest) => {
      setSavingConfig(true);
      try {
        setConfig(
          activeProviderInstanceId
            ? await agentManagementApi.writeConfigFile(
                request,
                activeProviderInstanceId
              )
            : await agentManagementApi.writeConfigFile(request)
        );
        setConfigConflict(null);
        toast.success(t('settings:agents.configFileSaved'));
        await refreshManagement();
      } catch (error) {
        if (isConfigConflict(error)) {
          setConfig(
            activeProviderInstanceId
              ? await agentManagementApi.readConfig(
                  request.agent_id,
                  activeProviderInstanceId
                )
              : await agentManagementApi.readConfig(request.agent_id)
          );
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
    [
      activeProviderInstanceId,
      refreshManagement,
      setConfig,
      setConfigConflict,
      setSavingConfig,
      t,
    ]
  );

  const reloadConflict = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      setConfig(
        activeProviderInstanceId
          ? await agentManagementApi.readConfig(
              selectedAgentId,
              activeProviderInstanceId
            )
          : await agentManagementApi.readConfig(selectedAgentId)
      );
      toast.success(t('settings:agents.configReloaded'));
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.configReloadFailed')));
    }
  }, [activeProviderInstanceId, selectedAgentId, setConfig, t]);

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
        const patchRequest = {
          ...configConflict.request,
          base_field_revisions: revisions,
        };
        setConfig(
          activeProviderInstanceId
            ? await agentManagementApi.writeConfig(
                patchRequest,
                activeProviderInstanceId
              )
            : await agentManagementApi.writeConfig(patchRequest)
        );
      } else {
        const file = config.files.find(
          (candidate) => candidate.path === configConflict.request.path
        );
        if (!file) throw new Error(t('settings:agents.configFileMissing'));
        const fileRequest = {
          ...configConflict.request,
          base_revision: file.revision,
        };
        setConfig(
          activeProviderInstanceId
            ? await agentManagementApi.writeConfigFile(
                fileRequest,
                activeProviderInstanceId
              )
            : await agentManagementApi.writeConfigFile(fileRequest)
        );
      }
      setConfigConflict(null);
      toast.success(t('settings:agents.configOverwritten'));
      await refreshManagement();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.configOverwriteFailed'))
      );
    } finally {
      setSavingConfig(false);
    }
  }, [
    activeProviderInstanceId,
    config,
    configConflict,
    refreshManagement,
    setConfig,
    setConfigConflict,
    setSavingConfig,
    t,
  ]);

  return {
    saveConfig,
    saveConfigFile,
    reloadConflict,
    overwriteConflict,
  };
}
