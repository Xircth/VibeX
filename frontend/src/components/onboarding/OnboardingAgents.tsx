import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
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
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
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
import {
  ONBOARDING_ROSTER_DROPPABLE_ID,
  OnboardingRoster,
} from './OnboardingRoster';
import {
  canJoinOnboardingRoster,
  onboardingAgentStatus,
} from './onboardingAgentModel';

const pickerCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) return pointerHits;
  return rectIntersection(args);
};

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
    'onInspect' | 'onInstall' | 'rosterIds' | 'onJoinRoster'
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
  const [draggedAgentId, setDraggedAgentId] = useState<AgentId | null>(null);
  const setupRootRef = useRef<HTMLDivElement>(null);
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
  const checksRef = useRef(health.checks);
  checksRef.current = health.checks;
  const rosterIdsRef = useRef(rosterIds);
  rosterIdsRef.current = rosterIds;
  const onRosterChangeRef = useRef(onRosterChange);
  onRosterChangeRef.current = onRosterChange;
  const managementRef = useRef(management.state.agents);
  managementRef.current = management.state.agents;
  const willInstallRef = useRef(onWillInstallAgent);
  willInstallRef.current = onWillInstallAgent;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );

  const joinRoster = useCallback(
    (
      id: AgentId,
      insertIndex?: number,
      checkOverride?: ReturnType<typeof useOnboardingAgentChecks>['checks'][AgentId]
    ) => {
      const option = agentsRef.current.find((item) => item.agentId === id);
      if (!option) return;
      const status = onboardingAgentStatus(
        option,
        checkOverride ?? checksRef.current[id]
      );
      if (!canJoinOnboardingRoster(status)) return;
      const current = rosterIdsRef.current;
      const without = current.filter((candidate) => candidate !== id);
      const next =
        insertIndex !== undefined &&
        insertIndex >= 0 &&
        insertIndex <= without.length
          ? [
              ...without.slice(0, insertIndex),
              id,
              ...without.slice(insertIndex),
            ]
          : [...without, id];
      if (next.join('|') !== current.join('|')) {
        onRosterChangeRef.current(next);
      }
    },
    []
  );

  const handlePickerDragStart = useCallback(({ active }: DragStartEvent) => {
    const id = active.data.current?.agentId as AgentId | undefined;
    if (id) setDraggedAgentId(id);
  }, []);

  const handlePickerDragEnd = useCallback(
    ({ active, over, activatorEvent, delta }: DragEndEvent) => {
      setDraggedAgentId(null);
      if (!over || over.id !== ONBOARDING_ROSTER_DROPPABLE_ID) return;
      const id = active.data.current?.agentId as AgentId | undefined;
      if (!id) return;
      let insertIndex: number | undefined;
      if (
        'clientX' in activatorEvent &&
        typeof activatorEvent.clientX === 'number'
      ) {
        const dropX = activatorEvent.clientX + delta.x;
        const rosterEl =
          setupRootRef.current?.querySelector('.onboarding-roster');
        const items = Array.from(
          rosterEl?.querySelectorAll<HTMLElement>(
            '.agent-management-bar-page:not([inert]) [data-agent-id]'
          ) ?? []
        ).filter((el) => el.dataset.agentId && el.dataset.agentId !== id);
        for (let index = 0; index < items.length; index += 1) {
          const rect = items[index]!.getBoundingClientRect();
          if (rect.width > 0 && dropX < rect.left + rect.width / 2) {
            const targetId = items[index]!.dataset.agentId!;
            const without = rosterIdsRef.current.filter(
              (candidate) => candidate !== id
            );
            const foundIndex = without.indexOf(targetId);
            if (foundIndex !== -1) insertIndex = foundIndex;
            break;
          }
        }
      }
      joinRoster(id, insertIndex);
    },
    [joinRoster]
  );

  const handlePickerDragCancel = useCallback(() => {
    setDraggedAgentId(null);
  }, []);

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
  const draggedOption = draggedAgentId
    ? rows.find((item) => item.agentId === draggedAgentId)
    : undefined;
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
        willInstallRef.current?.(id);
        const initialOption = agentsRef.current.find(
          (item) => item.agentId === id
        );
        const initialStatus = initialOption
          ? onboardingAgentStatus(initialOption, checksRef.current[id])
          : 'uninstalled';
        if (initialStatus === 'ready') {
          joinRoster(id);
          return;
        }
        const report = await check(id);
        const latestOption = agentsRef.current.find(
          (item) => item.agentId === id
        );
        const latestView = managementRef.current.find(
          (item) => item.agent_id === id
        );
        const checkOverride = report ? { report } : undefined;
        const status = latestOption
          ? onboardingAgentStatus(latestOption, checkOverride)
          : 'uninstalled';
        if (canJoinOnboardingRoster(status)) {
          joinRoster(id, undefined, checkOverride);
          return;
        }
        const needsInstall =
          !latestOption?.added ||
          Boolean(latestOption.needsInstallation) ||
          latestView?.lifecycle === 'uninstalled' ||
          latestView?.lifecycle === 'needs_repair' ||
          status === 'uninstalled';
        if (needsInstall) {
          await install(id, { inspect: false });
        }
      })
    );
  }, [pendingAutoEnableIds, onConsumeAutoEnableIds, check, install, joinRoster]);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pickerCollisionDetection}
      onDragStart={handlePickerDragStart}
      onDragEnd={handlePickerDragEnd}
      onDragCancel={handlePickerDragCancel}
    >
      <div className="onboarding-agent-setup" ref={setupRootRef}>
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
              rosterIds={rosterIds}
              onInspect={inspect}
              onJoinRoster={(id) => joinRoster(id)}
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
                    onClick={() => joinRoster(agent.agent_id)}
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
          dropReady={Boolean(draggedOption)}
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
      <DragOverlay>
        {draggedOption ? (
          <div className="onboarding-agent-drag-overlay">
            <AgentManagementIcon
              agent={{
                agent_id: draggedOption.agentId,
                icon_light: draggedOption.iconLight,
                icon_dark: draggedOption.iconDark,
                icon_svg: draggedOption.iconSvg,
              }}
              className="h-5 w-5"
            />
            <span>{draggedOption.displayName}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
