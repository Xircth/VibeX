import { useEffect, useMemo, useState, type RefObject } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentManagementActionsView,
  AgentManagementView,
  AgentOperationEvent,
  AgentPreflightItemView,
  AgentPreflightView,
} from 'shared/types';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  type AgentOperationState,
} from '@/features/agent-management';
import { backendListen } from '@/lib/backendTransport';
import { AgentBar } from '@/pages/settings/AgentBar';
import { AgentAuthModeControl } from '@/pages/settings/AgentAuthModeControl';
import { AgentModelProviderManager } from '@/pages/settings/AgentModelProviderManager';
import { OpenCodeProviderConnections } from '@/pages/settings/OpenCodeProviderConnections';
import { AgentOperationProgress } from '@/pages/settings/AgentOperationProgress';
import { AgentPreflightCard } from '@/pages/settings/AgentPreflightCheckItem';
import { AgentSectionHeading } from '@/pages/settings/SettingsSection';
import { presentPreflightItems } from '@/pages/settings/agentPreflightSnapshot';
import {
  beginQueuedOperation,
  reduceOperationEvent,
} from '@/features/agent-management/agentManagementStore';

import {
  describeOnboardingPreflight,
  onboardingContinueGate,
  type OnboardingAgentCheckStatus,
  type OnboardingAgentOption,
} from './onboardingAgentModel';

export type OnboardingInstallRuntime = {
  started: Set<AgentId>;
  operations: Record<string, AgentOperationState>;
  ready: Set<AgentId>;
  errors: Record<string, string>;
  preflights: Record<string, AgentPreflightView>;
  authentication: Record<string, AgentManagementView['authentication']>;
  loginFailed: Set<AgentId>;
  sequence: number;
  listeners: Set<() => void>;
};

export function createOnboardingInstallRuntime(): OnboardingInstallRuntime {
  return {
    started: new Set(),
    operations: {},
    ready: new Set(),
    errors: {},
    preflights: {},
    authentication: {},
    loginFailed: new Set(),
    sequence: 0,
    listeners: new Set(),
  };
}

function publish(runtime: OnboardingInstallRuntime) {
  runtime.listeners.forEach((listener) => listener());
}

function judgedPreflightItems(items: AgentPreflightItemView[]) {
  const visible = presentPreflightItems(items);
  return visible.length > 0 ? visible : items;
}

function viewForOption(
  option: OnboardingAgentOption,
  views: AgentManagementView[]
): AgentManagementView {
  const existing = views.find((view) => view.agent_id === option.agentId);
  if (existing) return existing;
  return {
    agent_id: option.agentId,
    display_name: option.displayName,
    description: option.description,
    icon_light: option.iconLight,
    icon_dark: option.iconDark,
    icon_svg: option.iconSvg,
    source: 'built_in_profile',
    built_in: option.builtIn,
    retired: false,
    enabled: true,
    position: 0,
    lifecycle: option.lifecycle,
    authentication: 'not_logged_in',
    runtime_version: null,
    acp_version: null,
    active_operation: null,
    rollback_available: false,
  };
}

export function OnboardingAgentInstall({
  agents,
  views,
  defaultAgentId,
  runtimeRef,
  onBack,
  onFinish,
}: {
  agents: OnboardingAgentOption[];
  views: AgentManagementView[];
  defaultAgentId: AgentId | null;
  runtimeRef: RefObject<OnboardingInstallRuntime>;
  onBack: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslation(['dialogs', 'settings']);
  const runtime = runtimeRef.current;
  const [, setVersion] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(() =>
    defaultAgentId && agents.some((agent) => agent.agentId === defaultAgentId)
      ? defaultAgentId
      : (agents[0]?.agentId ?? null)
  );
  const [actionsByAgent, setActionsByAgent] = useState<
    Record<string, AgentManagementActionsView>
  >({});
  const [continuePrompt, setContinuePrompt] = useState<
    'partial' | 'none' | null
  >(null);
  const barAgents = useMemo(
    () => agents.map((agent) => viewForOption(agent, views)),
    [agents, views]
  );
  const selected =
    agents.find((agent) => agent.agentId === selectedAgentId) ??
    agents[0] ??
    null;
  const selectedView = selected ? viewForOption(selected, barAgents) : null;
  const authentication = selected
    ? (runtime.authentication[selected.agentId] ??
      selectedView?.authentication ??
      'not_logged_in')
    : 'not_logged_in';
  const operation = selected
    ? (runtime.operations[selected.agentId] ?? null)
    : null;
  const ready = selected ? runtime.ready.has(selected.agentId) : false;
  const installError = selected ? runtime.errors[selected.agentId] : undefined;
  const preflight = selected ? runtime.preflights[selected.agentId] : undefined;
  const loginFailed = selected
    ? runtime.loginFailed.has(selected.agentId)
    : false;

  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    runtime.listeners.add(listener);
    return () => {
      runtime.listeners.delete(listener);
    };
  }, [runtime]);

  useEffect(() => {
    const pending = agents.filter(
      (agent) => !runtime.started.has(agent.agentId)
    );
    if (pending.length === 0) return;
    pending.forEach((agent) => runtime.started.add(agent.agentId));
    void (async () => {
      if (pending.some((agent) => agent.needsInstallation)) {
        try {
          const registry = await agentManagementApi.registry();
          if (!registry.fresh) await agentManagementApi.refreshRegistry();
        } catch {
          // addAndInstall reports a concrete error when the catalog is unavailable.
        }
      }
      await Promise.all(
        pending.map(async (agent) => {
          if (!agent.needsInstallation) {
            await loadPreflight(runtime, agent.agentId);
            runtime.ready.add(agent.agentId);
            publish(runtime);
            return;
          }
          try {
            const receipt = await agentManagementApi.addAndInstall(
              agent.agentId
            );
            recordReceipt(runtime, receipt);
          } catch (error) {
            runtime.errors[agent.agentId] = agentManagementErrorMessage(
              error,
              t('dialogs:onboarding.installRuntimeNotice', {
                target: `${agent.displayName} ACP`,
              })
            );
            publish(runtime);
          }
        })
      );
    })();
  }, [agents, runtime, t]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void backendListen<AgentOperationEvent>(
      'agent-management-event',
      (event) => {
        if (!runtime.started.has(event.agent_id)) return;
        const next = reduceOperationEvent(
          {
            agents: [],
            selectedAgentId: null,
            operations: runtime.operations,
            lastEventSequence: runtime.sequence,
            snapshotRevision: 0,
          },
          event
        );
        runtime.sequence = next.lastEventSequence;
        runtime.operations = next.operations;
        const terminal =
          event.status === 'succeeded' ||
          event.status === 'failed' ||
          event.status === 'canceled' ||
          event.status === 'interrupted';
        if (terminal && (event.kind === 'install' || event.kind === 'repair')) {
          if (event.status === 'succeeded') {
            delete runtime.errors[event.agent_id];
            void loadPreflight(runtime, event.agent_id).then(() => {
              runtime.ready.add(event.agent_id);
              publish(runtime);
            });
          } else if (event.status === 'failed') {
            runtime.ready.delete(event.agent_id);
            runtime.errors[event.agent_id] =
              event.message?.trim() ||
              t('dialogs:onboarding.installRuntimeNotice', {
                target: event.agent_id,
              });
          }
        }
        publish(runtime);
      }
    ).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [runtime, t]);

  useEffect(() => {
    if (!selected || !ready) return;
    let active = true;
    void agentManagementApi
      .actions(selected.agentId)
      .then((actions) => {
        if (!active) return;
        setActionsByAgent((current) => ({
          ...current,
          [selected.agentId]: actions,
        }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [ready, selected]);

  const checkStatuses = agents.map((agent): OnboardingAgentCheckStatus => {
    if (runtime.loginFailed.has(agent.agentId)) return 'blocked';
    const report = runtime.preflights[agent.agentId];
    if (!report) return 'blocked';
    const judged = judgedPreflightItems(report.items);
    if (judged.length === 0) return 'blocked';
    return judged.some((item) => item.status === 'fail') ? 'blocked' : 'pass';
  });

  const continueDirectly = () => {
    setContinuePrompt(null);
    onFinish();
  };

  const requestContinue = () => {
    const decision = onboardingContinueGate(checkStatuses);
    if (decision === 'direct') {
      continueDirectly();
      return;
    }
    setContinuePrompt(decision);
  };

  const repair = async (agent: OnboardingAgentOption) => {
    delete runtime.errors[agent.agentId];
    publish(runtime);
    try {
      recordReceipt(runtime, await agentManagementApi.repair(agent.agentId));
      return;
    } catch {
      try {
        recordReceipt(
          runtime,
          await agentManagementApi.addAndInstall(agent.agentId)
        );
      } catch (error) {
        runtime.errors[agent.agentId] = agentManagementErrorMessage(
          error,
          t('dialogs:onboarding.installRuntimeNotice', {
            target: `${agent.displayName} ACP`,
          })
        );
        publish(runtime);
      }
    }
  };

  const runAction = async (actionId: string) => {
    if (!selected) return;
    const kind = actionsByAgent[selected.agentId]?.actions.find(
      (action) => action.id === actionId
    )?.kind;
    try {
      const receipt = await agentManagementApi.runAction(
        selected.agentId,
        actionId
      );
      if (kind === 'login' && !receipt.launched) {
        runtime.loginFailed.add(selected.agentId);
        publish(runtime);
      }
    } catch {
      if (kind === 'login') {
        runtime.loginFailed.add(selected.agentId);
        publish(runtime);
      }
    }
    await loadPreflight(runtime, selected.agentId);
  };

  const guidance = selected
    ? guidanceFor(selected, preflight, loginFailed, installError, t)
    : null;
  const installTitle = t('dialogs:onboarding.installEnvironment').replace(
    /(?:\.{3}|…)\s*$/u,
    ''
  );
  const showEnvironment = Boolean(operation) || Boolean(installError && !ready);
  const showConfiguration = Boolean(selected && ready && !operation);

  return (
    <main className="onboarding-install-step">
      <div className="onboarding-install-column">
        <div className="onboarding-install-copy">
          <h1 id="onboarding-title" tabIndex={-1}>
            {[
              installTitle,
              <span className="onboarding-install-dots" key="dots">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>,
            ]}
          </h1>
        </div>
        <div className="onboarding-install-layout">
          <div className="onboarding-install-detail settings-page">
            <div className="onboarding-agent-rail settings-page">
              <AgentBar
                agents={barAgents}
                selectedAgentId={selected?.agentId ?? null}
                registryOpen={false}
                pagingOnly
                installReadyIds={runtime.ready}
                onSelect={(agentId) => setSelectedAgentId(agentId as AgentId)}
                onReorder={() => undefined}
              />
            </div>
            <div className="onboarding-install-panels">
              {showEnvironment && operation ? (
                <AgentOperationProgress
                  operation={operation}
                  onCancel={() => {
                    if (!selected || !operation.operationId) return;
                    void agentManagementApi.cancelOperation(
                      selected.agentId,
                      operation.operationId
                    );
                  }}
                />
              ) : null}
              {showEnvironment && !operation && guidance ? (
                <InstallGuidance
                  guidance={guidance}
                  onRepair={selected ? () => void repair(selected) : undefined}
                />
              ) : null}
              {showConfiguration && selected && selectedView ? (
                <>
                  <AgentAuthModeControl
                    actions={actionsByAgent[selected.agentId] ?? null}
                    authentication={authentication}
                    agentId={selected.agentId}
                    modelProvider={
                      selected.agentId === 'opencode' ||
                      selected.agentId === 'mimo_code' ? (
                        <OpenCodeProviderConnections
                          agentId={selected.agentId}
                          surface="provider"
                        />
                      ) : selectedView.settings_features?.includes(
                          'reusable_model_providers'
                        ) ? (
                        <AgentModelProviderManager
                          agentId={selected.agentId}
                          disabled={false}
                          embedded
                          signedIn={
                            authentication === 'account' ||
                            authentication === 'multiple_unknown'
                          }
                        />
                      ) : undefined
                    }
                    onRunAction={(actionId) => void runAction(actionId)}
                  />
                  <section
                    aria-labelledby="onboarding-preflight-heading"
                    className="settings-surface agent-preflight-surface"
                  >
                    <AgentSectionHeading
                      headingId="onboarding-preflight-heading"
                      title={t('settings:agents.preflightTitle')}
                      expanded
                    />
                    <ul className="agent-preflight-grid">
                      {(preflight
                        ? presentPreflightItems(preflight.items)
                        : []
                      ).map((item) => (
                        <AgentPreflightCard item={item} key={item.id} />
                      ))}
                    </ul>
                  </section>
                  {guidance ? (
                    <InstallGuidance
                      guidance={guidance}
                      onRepair={
                        guidance.repairable
                          ? () => void repair(selected)
                          : undefined
                      }
                    />
                  ) : (
                    <div
                      className="settings-surface onboarding-install-guidance"
                      role="status"
                    >
                      <p>{t('dialogs:onboarding.checking')}</p>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
        <footer className="onboarding-config-footer">
          <div className="onboarding-step-actions onboarding-config-actions">
            <button
              type="button"
              className="onboarding-back-button"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
              {t('dialogs:onboarding.back')}
            </button>
            <button
              type="button"
              className="onboarding-primary-button"
              onClick={requestContinue}
            >
              {t('dialogs:onboarding.continue')}
            </button>
          </div>
        </footer>
      </div>
      {continuePrompt ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setContinuePrompt(null);
          }}
        >
          <DialogContent className="onboarding-continue-dialog">
            <DialogHeader>
              <DialogTitle>{t('dialogs:onboarding.continueTitle')}</DialogTitle>
              <DialogDescription>
                {continuePrompt === 'partial'
                  ? t('dialogs:onboarding.continuePartialBefore')
                  : t('dialogs:onboarding.continueNoneBefore')}
                <strong>{t('dialogs:onboarding.continueEmphasis')}</strong>
                {continuePrompt === 'partial'
                  ? t('dialogs:onboarding.continuePartialAfter')
                  : t('dialogs:onboarding.continueNoneAfter')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setContinuePrompt(null)}
              >
                {t('dialogs:onboarding.continueStay')}
              </Button>
              <Button type="button" onClick={continueDirectly}>
                {t('dialogs:onboarding.continueConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}

function guidanceFor(
  agent: OnboardingAgentOption,
  preflight: AgentPreflightView | undefined,
  loginFailed: boolean,
  installError: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): InstallGuidanceModel | null {
  if (installError) {
    return {
      tone: 'fail',
      message: t('dialogs:onboarding.installRuntimeNotice', {
        target: `${agent.displayName} ACP`,
      }),
      detail: installError,
      repairable: true,
    };
  }
  if (!preflight) return null;
  const described = describeOnboardingPreflight(
    judgedPreflightItems(preflight.items),
    loginFailed
  );
  if (described.kind === 'pending') return null;
  if (described.kind === 'pass') {
    return {
      tone: 'pass',
      message: t('dialogs:onboarding.installReadyNotice'),
      repairable: false,
    };
  }
  if (described.kind === 'runtime') {
    return {
      tone: 'fail',
      message: t('dialogs:onboarding.installRuntimeNotice', {
        target: described.target,
      }),
      repairable: described.repairable,
    };
  }
  if (described.kind === 'login') {
    return {
      tone: 'fail',
      message: t('dialogs:onboarding.installLoginNotice'),
      repairable: false,
    };
  }
  if (described.kind === 'auth') {
    return {
      tone: 'fail',
      message: t('dialogs:onboarding.installAuthNotice'),
      repairable: false,
    };
  }
  return {
    tone: 'fail',
    message: t('dialogs:onboarding.installOtherNotice'),
    repairable: described.repairable,
  };
}

type InstallGuidanceModel = {
  tone: 'pass' | 'fail';
  message: string;
  detail?: string;
  repairable: boolean;
};

function InstallGuidance({
  guidance,
  onRepair,
}: {
  guidance: InstallGuidanceModel;
  onRepair?: () => void;
}) {
  const { t } = useTranslation('dialogs');
  return (
    <div
      className={`settings-surface onboarding-install-guidance is-${guidance.tone}`}
      role={guidance.tone === 'fail' ? 'alert' : 'status'}
    >
      <div className="onboarding-install-guidance-copy">
        <p>{guidance.message}</p>
        {guidance.detail ? <p>{guidance.detail}</p> : null}
      </div>
      {guidance.repairable && onRepair ? (
        <button
          type="button"
          className="onboarding-repair-button"
          onClick={onRepair}
        >
          {t('onboarding.repairAction')}
        </button>
      ) : null}
    </div>
  );
}

function recordReceipt(
  runtime: OnboardingInstallRuntime,
  receipt: {
    operation_id: string;
    agent_id: AgentId;
    kind: AgentOperationState['kind'];
    status: AgentOperationState['status'];
  }
) {
  const next = beginQueuedOperation(
    {
      agents: [],
      selectedAgentId: null,
      operations: runtime.operations,
      lastEventSequence: runtime.sequence,
      snapshotRevision: 0,
    },
    receipt
  );
  runtime.sequence = next.lastEventSequence;
  runtime.operations = next.operations;
  publish(runtime);
}

async function loadPreflight(
  runtime: OnboardingInstallRuntime,
  agentId: AgentId
) {
  try {
    runtime.preflights[agentId] = await agentManagementApi.preflight(agentId);
    const memberships = await agentManagementApi.bar();
    const observed = memberships.find((view) => view.agent_id === agentId);
    if (observed) {
      runtime.authentication[agentId] = observed.authentication;
    }
  } catch {
    // The last probe stays on screen when the refresh fails.
  }
  publish(runtime);
}
