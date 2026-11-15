import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthenticationStatus,
  AgentId,
  AgentNativeConfigView,
} from 'shared/types';

import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import { accountSessionMatchesAction } from './agentSettingsPreflightHelpers';

export function useAgentAccountFlowWatcher({
  selectedAgentId,
  registryOpen,
  refreshAuthentication,
  setConfig,
}: {
  selectedAgentId: AgentId | null;
  registryOpen: boolean;
  refreshAuthentication: () => Promise<AgentAuthenticationStatus | null>;
  setConfig: Dispatch<SetStateAction<AgentNativeConfigView | null>>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const authWatchGeneration = useRef(0);

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
    [selectedAgentId, setConfig, t, watchAccountFlow]
  );

  return {
    actionRunning,
    runManagementAction,
  };
}
