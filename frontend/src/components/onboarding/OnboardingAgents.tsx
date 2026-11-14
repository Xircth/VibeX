import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type {
  AgentId,
  AgentOperationEvent,
  AgentRegistryView,
  AgentRegistryViewRow,
  UserAgentDefinitionRequest,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import { backendListen } from '@/lib/backendTransport';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  type useAgentManagement,
} from '@/features/agent-management';
import { AgentRegistryViewPanel } from '@/pages/settings/AgentRegistryView';
import { OnboardingAgentDetail } from './OnboardingAgentDetail';
import { AgentSetupPicker } from './AgentSetupPicker';
import type { ComponentProps } from 'react';
import type { useOnboardingAgentChecks } from './useOnboardingAgentChecks';
import { OnboardingRoster } from './OnboardingRoster';
import {
  canJoinOnboardingRoster,
  onboardingAgentStatus,
} from './onboardingAgentModel';

export function OnboardingAgents({
  picker,
  onDirtyChange,
  management,
  health,
  rosterIds,
  onRosterChange,
  pendingAutoEnableIds = [],
  onConsumeAutoEnableIds,
  onWillInstallAgent,
}: {
  picker: Omit<
    ComponentProps<typeof AgentSetupPicker>,
    'onInspect' | 'onInstall'
  >;
  onDirtyChange: (dirty: boolean) => void;
  management: ReturnType<typeof useAgentManagement>;
  health: ReturnType<typeof useOnboardingAgentChecks>;
  rosterIds: AgentId[];
  onRosterChange: (ids: AgentId[]) => void;
  pendingAutoEnableIds?: AgentId[];
  onConsumeAutoEnableIds?: () => void;
  onWillInstallAgent?: (id: AgentId) => void;
}) {
  const { t } = useTranslation('dialogs');
  const [inspectedId, setInspectedId] = useState<AgentId | null>(null);
  const [dirty, setDirty] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registryRef = useRef<HTMLElement>(null);
  const [starting, setStarting] = useState<Set<string>>(() => new Set());
  const installing = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  const { check, installation } = health;
  const refresh = management.refresh;
  const retry = picker.onRetry;
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const agentsRef = useRef(picker.agents);
  agentsRef.current = picker.agents;
  const managementRef = useRef(management.state.agents);
  managementRef.current = management.state.agents;
  const willInstallRef = useRef(onWillInstallAgent);
  willInstallRef.current = onWillInstallAgent;
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void backendListen<AgentOperationEvent>(
      'agent-management-event',
      (event) => {
        if (
          !active ||
          !['succeeded', 'failed', 'canceled', 'interrupted'].includes(
            event.status
          ) ||
          completed.current.has(event.operation_id)
        )
          return;
        completed.current.add(event.operation_id);
        if (event.status === 'failed' || event.status === 'interrupted')
          installation(event.agent_id, true);
        else
          void (async () => {
            await Promise.all([refresh(), check(event.agent_id)]);
            if (!active) return;
            retryRef.current();
          })().catch(() => undefined);
      }
    ).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [check, installation, refresh]);
  useEffect(() => {
    const operationBusy = Object.values(management.state.operations).some(
      (operation) =>
        ['queued', 'running', 'canceling'].includes(operation.status)
    );
    onDirtyChange(dirty || starting.size > 0 || operationBusy);
  }, [dirty, starting, management.state.operations, onDirtyChange]);
  useEffect(() => {
    if (registryOpen && window.matchMedia('(max-width: 760px)').matches)
      registryRef.current?.focus();
  }, [registryOpen]);
  const dirtyChange = useCallback((value: boolean) => {
    setDirty(value);
  }, []);
  const inspect = useCallback(
    (id: AgentId | null) => {
      if (dirty) {
        setError(t('onboarding.unsavedConfiguration'));
        return;
      }
      setError(null);
      setInspectedId(id);
      setRegistryOpen(false);
    },
    [dirty, t]
  );
  const loadRegistry = async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setRegistry(
        await (fresh
          ? agentManagementApi.refreshRegistry()
          : agentManagementApi.registry())
      );
    } catch (cause) {
      setError(agentManagementErrorMessage(cause, t('onboarding.setupFailed')));
    } finally {
      setLoading(false);
    }
  };
  const add = async (
    input: AgentRegistryViewRow | UserAgentDefinitionRequest
  ) => {
    setAdding(input.agent_id);
    setError(null);
    willInstallRef.current?.(input.agent_id);
    try {
      if ('display_name' in input && 'registry_id' in input)
        await management.addAndInstall(input);
      else
        management.beginOperation(
          await agentManagementApi.addUserDefinitionAndInstall(input)
        );
      setRegistryOpen(false);
      setInspectedId(input.agent_id);
      await management.refresh();
      picker.onRetry();
    } catch (cause) {
      setError(agentManagementErrorMessage(cause, t('onboarding.setupFailed')));
    } finally {
      setAdding(null);
    }
  };
  const agent = management.state.agents.find(
    (item) => item.agent_id === inspectedId
  );
  const selectedOption = picker.agents.find(
    (item) => item.agentId === inspectedId
  );
  const checkSelected = useCallback(async () => {
    if (!inspectedId) return;
    await check(inspectedId);
    await refresh();
    retryRef.current();
  }, [inspectedId, check, refresh]);
  const rows = picker.agents
    .filter((item) => item.builtIn || item.added || starting.has(item.agentId))
    .map((item) =>
      starting.has(item.agentId)
        ? { ...item, lifecycle: 'installing' as const }
        : item
    );
  const install = useCallback(
    async (id: AgentId, options?: { inspect?: boolean }) => {
      if (dirty || installing.current.has(id)) return;
      willInstallRef.current?.(id);
      if (options?.inspect !== false) inspect(id);
      installing.current.add(id);
      setStarting((current) => new Set([...current, id]));
      installation(id, false);
      try {
        const view = managementRef.current.find(
          (item) => item.agent_id === id
        );
        const receipt = await (view?.lifecycle === 'needs_repair'
          ? agentManagementApi.repair(id)
          : agentManagementApi.addAndInstall(id));
        if (!completed.current.has(receipt.operation_id))
          management.beginOperation(receipt);
        else await refresh();
        retryRef.current();
      } catch (cause) {
        installation(id, true);
        setError(
          agentManagementErrorMessage(cause, t('onboarding.setupFailed'))
        );
      } finally {
        installing.current.delete(id);
        setStarting((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [dirty, inspect, installation, management, refresh, t]
  );
  useEffect(() => {
    if (!pendingAutoEnableIds.length) return;
    const ids = [...pendingAutoEnableIds];
    onConsumeAutoEnableIds?.();
    void Promise.allSettled(
      ids.map(async (id) => {
        const report = await check(id);
        const latestOption = agentsRef.current.find(
          (item) => item.agentId === id
        );
        const latestView = managementRef.current.find(
          (item) => item.agent_id === id
        );
        const status = latestOption
          ? onboardingAgentStatus(
              latestOption,
              report ? { report } : undefined
            )
          : 'uninstalled';
        const needsInstall =
          !latestOption?.added ||
          Boolean(latestOption.needsInstallation) ||
          latestView?.lifecycle === 'uninstalled' ||
          latestView?.lifecycle === 'needs_repair' ||
          status === 'uninstalled';
        if (!canJoinOnboardingRoster(status) && needsInstall) {
          await install(id, { inspect: false });
        }
      })
    );
  }, [pendingAutoEnableIds, onConsumeAutoEnableIds, check, install]);
  return (
    <div className="onboarding-agent-setup">
      <div
        className={
          inspectedId || registryOpen
            ? 'onboarding-agents-layout has-detail'
            : 'onboarding-agents-layout'
        }
      >
        <section className="onboarding-agents-list-pane">
          <AgentSetupPicker
            {...picker}
            agents={rows}
            onInspect={inspect}
            inspectedAgentId={inspectedId}
            onInstall={(id) => void install(id)}
          />
        </section>
        {registryOpen ? (
          <aside
            className="onboarding-agent-detail settings-page"
            tabIndex={-1}
            ref={registryRef}
          >
            <Button
              className="self-end"
              size="icon"
              variant="ghost"
              aria-label={t('onboarding.closeDetail')}
              onClick={() => setRegistryOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
            <AgentRegistryViewPanel
              view={registry}
              loading={loading}
              addingAgentId={adding}
              onRefresh={() => void loadRegistry(true)}
              onAdd={(row) => void add(row)}
              onAddUserDefinition={(request) => void add(request)}
            />
          </aside>
        ) : agent ? (
          <OnboardingAgentDetail
            key={agent.agent_id}
            agent={agent}
            operation={management.state.operations[agent.agent_id]}
            onRefresh={management.refresh}
            onDirtyChange={dirtyChange}
            onClose={() => inspect(null)}
            onInstall={() => install(agent.agent_id)}
            checkState={health.checks[agent.agent_id]}
            status={
              selectedOption
                ? onboardingAgentStatus(
                    starting.has(agent.agent_id)
                      ? { ...selectedOption, lifecycle: 'installing' }
                      : selectedOption,
                    health.checks[agent.agent_id]
                  )
                : undefined
            }
            onCheck={checkSelected}
            installing={starting.has(agent.agent_id)}
            rosterAction={
              selectedOption &&
              canJoinOnboardingRoster(
                onboardingAgentStatus(
                  selectedOption,
                  health.checks[agent.agent_id]
                )
              ) &&
              !rosterIds.includes(agent.agent_id) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRosterChange([...rosterIds, agent.agent_id])}
                >
                  {t('onboarding.joinRoster')}
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
      <OnboardingRoster
        agents={management.state.agents}
        ids={rosterIds}
        onChange={onRosterChange}
        onInspect={inspect}
      />
      <button
        type="button"
        className="onboarding-registry-entry"
        onClick={() => {
          if (dirty) {
            setError(t('onboarding.unsavedConfiguration'));
            return;
          }
          setRegistryOpen(true);
          setInspectedId(null);
          void loadRegistry();
        }}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        <span>{t('onboarding.registryImport')}</span>
      </button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
