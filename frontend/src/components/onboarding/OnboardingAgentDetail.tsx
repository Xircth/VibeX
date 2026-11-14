import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  OnboardingAgentCheck,
  OnboardingAgentStatus,
} from './onboardingAgentModel';
import { AgentPreflightCard } from '@/pages/settings/AgentPreflightCheckItem';
import { presentPreflightItems } from '@/pages/settings/agentPreflightSnapshot';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, X } from 'lucide-react';
import type {
  AgentManagementActionsView,
  AgentManagementView,
  AgentNativeConfigView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigFileWriteRequest,
  AgentPreflightView,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  type AgentOperationState,
} from '@/features/agent-management';
import { AgentAuthModeControl } from '@/pages/settings/AgentAuthModeControl';
import {
  AgentConfigurationAndDiagnostics,
  configForAuthMode,
} from '@/pages/settings/AgentConfigurationAndDiagnostics';
import { AgentModelProviderManager } from '@/pages/settings/AgentModelProviderManager';
import { OpenCodeProviderConnections } from '@/pages/settings/OpenCodeProviderConnections';
import { OpenCodeSubscriptionPanel } from '@/pages/settings/OpenCodeSubscriptionPanel';
import { DshAuthPanel } from '@/pages/settings/DshAuthPanel';
import { DshSessionDefaults } from '@/pages/settings/DshSessionDefaults';
import { AgentOperationProgress } from '@/pages/settings/AgentOperationProgress';
import { AgentEnvironmentEditor } from '@/pages/settings/AgentEnvironmentEditor';
import { OnboardingAgentStatusBadge } from './OnboardingAgentStatusBadge';

export function OnboardingAgentDetail({
  agent,
  operation,
  onInstall,
  onRefresh,
  onClose,
  onDirtyChange,
  checkState,
  onCheck,
  installing = false,
  rosterAction,
  status,
}: {
  agent: AgentManagementView;
  operation?: AgentOperationState;
  onInstall: () => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  checkState?: OnboardingAgentCheck;
  onCheck?: () => Promise<void>;
  installing?: boolean;
  rosterAction?: ReactNode;
  status?: OnboardingAgentStatus;
}) {
  const { t } = useTranslation(['dialogs', 'settings', 'common']);
  const [config, setConfig] = useState<AgentNativeConfigView | null>(null);
  const [actions, setActions] = useState<AgentManagementActionsView | null>(
    null
  );
  const [preflight, setPreflight] = useState<AgentPreflightView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const conflictRequest = useRef<
    AgentNativeConfigPatchRequest | AgentNativeConfigFileWriteRequest | null
  >(null);
  const [configGeneration, setConfigGeneration] = useState(0);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const dirtySources = useRef<Record<string, boolean>>({});
  const active = useRef(true);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia('(max-width: 760px)').matches)
      detailRef.current?.focus();
  }, []);
  const locked =
    agent.lifecycle === 'uninstalled' ||
    agent.lifecycle === 'platform_unsupported' ||
    agent.retired;
  const operationBusy = Boolean(
    installing ||
      agent.active_operation ||
      (operation &&
        ['queued', 'running', 'canceling'].includes(operation.status))
  );
  const hasAuthMode =
    agent.settings_features?.includes('authentication_mode') ||
    config?.settings_features.includes('authentication_mode');
  const reportError = useCallback(
    (cause: unknown) =>
      setError(agentManagementErrorMessage(cause, t('onboarding.setupFailed'))),
    [t]
  );
  const setDirty = useCallback(
    (source: string, value: boolean) => {
      dirtySources.current[source] = value;
      onDirtyChange(Object.values(dirtySources.current).some(Boolean));
    },
    [onDirtyChange]
  );
  const configurationDirty = useCallback(
    (value: boolean) => setDirty('configuration', value),
    [setDirty]
  );
  const authConfigDirty = useCallback(
    (value: boolean) => setDirty('auth-config', value),
    [setDirty]
  );
  const modeDirty = useCallback(
    (value: boolean) => setDirty('mode', value),
    [setDirty]
  );
  const modePending = useCallback(
    (value: boolean) => setDirty('mode-pending', value),
    [setDirty]
  );
  const configPending = useCallback(
    (value: boolean) => setDirty('configuration-pending', value),
    [setDirty]
  );
  const authPending = useCallback(
    (value: boolean) => setDirty('authentication-pending', value),
    [setDirty]
  );
  useEffect(() => {
    setDirty('pending', busy || Boolean(conflict));
  }, [busy, conflict, setDirty]);
  const providerDirty = useCallback(
    (value: boolean) => setDirty('provider', value),
    [setDirty]
  );
  const environmentDirty = useCallback(
    (value: boolean) => setDirty('environment', value),
    [setDirty]
  );
  const environmentPending = useCallback(
    (value: boolean) => setDirty('environment-pending', value),
    [setDirty]
  );
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      agentManagementApi.readConfig(agent.agent_id),
      agentManagementApi.actions(agent.agent_id),
    ]);
    if (!active.current) return;
    if (results[0].status === 'fulfilled') setConfig(results[0].value);
    if (results[1].status === 'fulfilled') setActions(results[1].value);
    for (const result of results)
      if (result.status === 'rejected') reportError(result.reason);
    await onRefresh();
  }, [agent.agent_id, onRefresh, reportError]);
  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (onCheck) await onCheck();
      else {
        const report = await agentManagementApi.preflight(agent.agent_id);
        if (active.current) setPreflight(report);
      }
      await refresh();
    } catch (cause) {
      if (active.current) reportError(cause);
    } finally {
      if (active.current) setBusy(false);
    }
  }, [agent.agent_id, onCheck, refresh, reportError]);
  useEffect(() => {
    active.current = true;
    void refresh().catch(reportError);
    return () => {
      active.current = false;
    };
  }, [refresh, reportError]);
  useEffect(() => {
    if (!onCheck && operation?.status === 'succeeded') void check();
  }, [operation?.status, check, onCheck]);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const deadline = Date.now() + 15 * 60_000;
    let expectedAction = actionRunning;
    const poll = async () => {
      try {
        const flow = await agentManagementApi.accountFlow(agent.agent_id);
        if (stopped) return;
        if (!expectedAction && flow.status !== 'pending') return;
        if (!expectedAction && flow.status === 'pending') {
          setActionRunning(flow.action_id ?? 'login');
          return;
        }
        expectedAction ??= flow.action_id ?? 'login';
        if (flow.status === 'failed')
          throw new Error(t('settings:agents.accountFlowCommandFailed'));
        if (flow.status === 'succeeded' || flow.status === 'idle') {
          if (onCheck) await onCheck();
          else {
            const report = await agentManagementApi.preflight(agent.agent_id);
            if (stopped) return;
            setPreflight(report);
          }
          await refresh();
          const view = (await agentManagementApi.bar()).find(
            (item) => item.agent_id === agent.agent_id
          );
          if (stopped) return;
          const signedIn =
            view?.authentication === 'account' ||
            view?.authentication === 'multiple_unknown';
          if (
            view &&
            (expectedAction === 'logout'
              ? !signedIn
              : expectedAction !== 'login' || signedIn)
          ) {
            setActionRunning(null);
            return;
          }
        }
        if (Date.now() >= deadline)
          throw new Error(t('onboarding.authTimedOut'));
      } catch (cause) {
        if (stopped) return;
        reportError(cause);
        setActionRunning(null);
        return;
      }
      timer = window.setTimeout(() => void poll(), 1500);
    };
    timer = window.setTimeout(() => void poll(), 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [actionRunning, agent.agent_id, refresh, reportError, t, onCheck]);
  const changed = useCallback(() => {
    void check();
  }, [check]);
  const runAction = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await agentManagementApi.runAction(agent.agent_id, id);
      setActionRunning(id);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };
  const save = async (
    request: AgentNativeConfigPatchRequest | AgentNativeConfigFileWriteRequest
  ) => {
    setBusy(true);
    setError(null);
    try {
      const next =
        'path' in request
          ? await agentManagementApi.writeConfigFile(request)
          : await agentManagementApi.writeConfig(request);
      setConfig(next);
      setConflict(null);
      await check();
    } catch (cause) {
      reportError(cause);
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'config_conflict'
      ) {
        conflictRequest.current = request;
        setConflict(t('settings:agents.configExternallyModified'));
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    try {
      setConfig(await agentManagementApi.readConfig(agent.agent_id));
      conflictRequest.current = null;
      setConfigGeneration((value) => value + 1);
      setConflict(null);
      setError(null);
    } catch (cause) {
      reportError(cause);
    }
  };
  const overwrite = async () => {
    const request = conflictRequest.current;
    if (!request) return;
    setBusy(true);
    try {
      const latest = await agentManagementApi.readConfig(agent.agent_id);
      if ('path' in request) {
        const file = latest.files.find((item) => item.path === request.path);
        if (!file) throw new Error(t('settings:agents.configFileMissing'));
        await save({ ...request, base_revision: file.revision });
      } else {
        await save({
          ...request,
          base_field_revisions: Object.fromEntries(
            latest.fields
              .filter((field) => field.id in request.fields)
              .map((field) => [field.id, field.revision])
          ),
        });
      }
      conflictRequest.current = null;
      setConfigGeneration((value) => value + 1);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };
  const configPanel = (
    surface?: 'authentication' | 'configuration',
    mode?: string
  ) =>
    config ? (
      <AgentConfigurationAndDiagnostics
        key={`${surface ?? 'all'}:${configGeneration}`}
        config={mode ? configForAuthMode(agent.agent_id, mode, config) : config}
        embedded
        fieldSurface={surface}
        locked={locked || operationBusy}
        saving={busy}
        onSave={save}
        onSaveFile={save}
        conflictMessage={conflict ?? undefined}
        onReloadConflict={() => void reload()}
        onAdoptExternal={() => void reload()}
        onOverwriteConflict={() => void overwrite()}
        onPendingChange={
          surface === 'authentication' ? authPending : configPending
        }
        onDirtyChange={
          surface === 'authentication' ? authConfigDirty : configurationDirty
        }
      />
    ) : null;
  return (
    <aside
      className="onboarding-agent-detail onboarding-agent-settings settings-page"
      tabIndex={-1}
      ref={detailRef}
      aria-label={t('onboarding.agentDetail', { agent: agent.display_name })}
    >
      <header className="flex items-start gap-3">
        <AgentManagementIcon agent={agent} className="h-9 w-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold">{agent.display_name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {agent.description}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label={t('onboarding.closeDetail')}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <section
        className="onboarding-agent-preflight"
        aria-label={t('settings:agents.preflightTitle')}
      >
        <div className="onboarding-agent-preflight-actions">
          <div className="mr-auto">
            {status ? (
              <OnboardingAgentStatusBadge status={status} />
            ) : (
              <span role="status">
                {t(`settings:agents.lifecycleStatus.${agent.lifecycle}`)}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || operationBusy || checkState?.checking}
            onClick={() => void check()}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {t('onboarding.recheck')}
          </Button>
          {agent.lifecycle !== 'platform_unsupported' &&
          (status === 'uninstalled' ||
            locked ||
            agent.lifecycle === 'needs_repair' ||
            checkState?.installationFailed) ? (
            <Button
              size="sm"
              disabled={busy || operationBusy || checkState?.checking}
              onClick={() => {
                setBusy(true);
                void onInstall()
                  .catch(reportError)
                  .finally(() => setBusy(false));
              }}
            >
              {t(
                checkState?.installationFailed
                  ? 'onboarding.reinstall'
                  : 'onboarding.installOneClick'
              )}
            </Button>
          ) : null}
          {busy ? (
            <Loader2
              className="h-4 w-4 motion-safe:animate-spin"
              aria-label={t('onboarding.checking')}
            />
          ) : null}
        </div>
        {rosterAction}
        {error || checkState?.error ? (
          <p className="text-sm text-destructive" role="alert">
            {error || checkState?.error}
          </p>
        ) : null}
        {operation ? (
          <AgentOperationProgress
            operation={operation}
            onCancel={
              operationBusy
                ? () =>
                    void agentManagementApi
                      .cancelOperation(agent.agent_id, operation.operationId)
                      .catch(reportError)
                : undefined
            }
          />
        ) : null}
        {checkState?.report || preflight ? (
          <ul className="agent-preflight-grid">
            {presentPreflightItems(
              (checkState?.report ?? preflight)!.items
            ).map((item) => (
              <AgentPreflightCard
                key={item.id}
                item={item}
                busy={busy || Boolean(checkState?.checking)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground" role="status">
            {t(
              checkState?.checking
                ? 'onboarding.checking'
                : 'onboarding.preflightNotChecked'
            )}
          </p>
        )}
      </section>
      {agent.agent_id === 'deepseek_harness' ? (
        <>
          <DshAuthPanel
            locked={locked}
            onChanged={changed}
            onDirtyChange={providerDirty}
          />
          {!locked ? (
            <DshSessionDefaults
              onChanged={changed}
              onDirtyChange={configurationDirty}
            />
          ) : null}
        </>
      ) : hasAuthMode ? (
        <AgentAuthModeControl
          agentId={agent.agent_id}
          actions={actions}
          authentication={agent.authentication}
          actionRunning={actionRunning}
          busy={busy || operationBusy}
          locked={locked}
          configuration={(mode) => configPanel('authentication', mode)}
          configurationOnAccount={(mode) =>
            agent.agent_id === 'antigravity' && mode === 'oauth-business'
          }
          modelProvider={
            agent.agent_id === 'opencode' || agent.agent_id === 'mimo_code' ? (
              <OpenCodeProviderConnections
                agentId={agent.agent_id}
                surface="provider"
                onChanged={changed}
                onDirtyChange={providerDirty}
              />
            ) : agent.settings_features?.includes('reusable_model_providers') ||
              config?.settings_features.includes('reusable_model_providers') ? (
              <AgentModelProviderManager
                agentId={agent.agent_id}
                embedded
                disabled={locked || busy}
                signedIn={
                  agent.authentication === 'account' ||
                  agent.authentication === 'multiple_unknown'
                }
                onChanged={changed}
                onDirtyChange={providerDirty}
              />
            ) : undefined
          }
          accountExtra={
            agent.agent_id === 'opencode' ? (
              <OpenCodeSubscriptionPanel
                onChanged={changed}
                onDirtyChange={providerDirty}
              />
            ) : undefined
          }
          onChanged={changed}
          onAuthenticated={changed}
          onDirtyChange={modeDirty}
          onPendingChange={modePending}
          onRunAction={(id) => void runAction(id)}
          nativeCredentialPresent={(id) =>
            Boolean(
              config?.fields.some((field) => field.id === id && field.present)
            )
          }
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions?.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant="outline"
              disabled={
                !action.available || locked || busy || Boolean(actionRunning)
              }
              title={action.unavailable_reason ?? action.description}
              onClick={() => void runAction(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {agent.agent_id !== 'deepseek_harness'
        ? configPanel(hasAuthMode ? 'configuration' : undefined)
        : null}
      <AgentEnvironmentEditor
        agentId={agent.agent_id}
        togglePosition="trailing"
        disabled={locked || busy || operationBusy}
        onChanged={changed}
        onDirtyChange={environmentDirty}
        onPendingChange={environmentPending}
      />
    </aside>
  );
}
