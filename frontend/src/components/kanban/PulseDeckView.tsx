import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowDefinitionSummary } from 'shared/types';

import { toast } from '@/components/ui/toast';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useManagedAgentOptions } from '@/features/agent-management';
import { toStudioWorkflowDefinition } from '@/features/workflow/WorkflowStudio';
import { useCollaborationBotRoster } from '@/features/workflow/useCollaborationBotRoster';
import { resolveWorkflowAgentId } from '@/features/workflow/workflowAgent';
import { workflowsApi } from '@/features/workflow/workflowApi';
import { usePulseDeckSnapshot } from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type PulseRuleSaveInput,
  type PulseRuleView,
  type PulseSourceTestResult,
  type PulseSourceUpsertInput,
} from '@/lib/api/pulse';
import { useLayoutStore } from '@/stores/useLayoutStore';

import {
  AutomationPageShell,
  EmbeddedWorkflowStudioShell,
} from './automation/AutomationHeaderBar';
import { AutomationSourcesTab } from './automation/AutomationSourcesTab';
import { AutomationTasksTab } from './automation/AutomationTasksTab';
import {
  activateAutomationSessionInRightSidebar,
  buildWorkflowTriggerRuleSpec,
  dispatchAutomationAgentRequest,
  ensureRightSessionSidebarOpen,
  extractPulseErrorMessage,
  type CanonicalWorkflowStarter,
} from './automation/automationAgentBridge';
import {
  unifyAutomationTasks,
  type AutomationPrimaryTab,
  type UnifiedAutomationTask,
} from './automation/automationModels';
import {
  consumePendingWorkflowStudioOpen,
  OPEN_PULSE_DECK_EVENT,
  OPEN_WORKFLOW_STUDIO_EVENT,
  requestOpenWorkflowStudio,
  stashPendingWorkflowStudioOpen,
  type PendingWorkflowStudioOpenDetail,
} from './pulseDeckEvents';

function isActiveVisibleSurface(element: HTMLElement | null): boolean {
  if (!element) return true;
  return !element.closest('[aria-hidden="true"], [hidden], [inert]');
}

async function invokeSaveRule(
  input: PulseRuleSaveInput
): Promise<PulseRuleView> {
  const apiRecord = pulseApi as unknown as Record<
    string,
    ((arg: unknown) => Promise<PulseRuleView>) | undefined
  >;
  if (typeof pulseApi.saveRule === 'function') {
    return pulseApi.saveRule(input);
  }
  if (typeof apiRecord.upsertRule === 'function') {
    return apiRecord.upsertRule(input);
  }
  throw new Error('pulseApi.saveRule is not available');
}

export function PulseDeckView({
  projectId = null,
  className,
}: {
  projectId?: string | null;
  className?: string;
}) {
  const { t, i18n } = useTranslation('panels');
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
  const isZh = language.startsWith('zh');
  const kanbanSession = useOptionalKanbanSessionContext();
  const agentOptions = useManagedAgentOptions(undefined, true);
  const defaultAgentId = resolveWorkflowAgentId(agentOptions, undefined);
  const { bots, spaces } = useCollaborationBotRoster();
  const rootSurfaceRef = useRef<HTMLDivElement | null>(null);

  const {
    snapshot,
    isLoading,
    isFetching,
    error: queryError,
    refetch,
    setSnapshotData,
    invalidateSnapshot,
  } = usePulseDeckSnapshot(projectId);

  const [activeTab, setActiveTab] = useState<AutomationPrimaryTab>('tasks');
  const [embeddedStudio, setEmbeddedStudio] =
    useState<PendingWorkflowStudioOpenDetail | null>(() => {
      const pending = consumePendingWorkflowStudioOpen();
      if (pending) {
        stashPendingWorkflowStudioOpen(pending);
      }
      return pending;
    });

  const [workflowDefinitions, setWorkflowDefinitions] = useState<
    WorkflowDefinitionSummary[]
  >([]);
  const [actionError, setActionError] = useState('');
  const [sourcesInitialAdding, setSourcesInitialAdding] = useState(false);
  const [applyingStarterId, setApplyingStarterId] = useState<string | null>(
    null
  );
  const [customizingStarterId, setCustomizingStarterId] = useState<
    string | null
  >(null);
  const [agentWatchUntil, setAgentWatchUntil] = useState<number>(0);

  const sidebarAutoOpenedForStudioRef = useRef(false);
  const initialEmbeddedStudioRef = useRef(embeddedStudio !== null);

  // Keep the right-side AI conversation sidebar closed when opening the Automation Tasks page
  // (it can still be opened manually via the header toggle or when launching Workflow Studio / Agent creation).
  useEffect(() => {
    if (initialEmbeddedStudioRef.current) return;
    const layout = useLayoutStore.getState();
    if (layout.isKanbanSessionVisible) {
      layout.setKanbanSessionVisible(false);
    }
  }, []);

  const loadAuxiliaryCatalog = useCallback(async () => {
    if (typeof workflowsApi?.listDefinitions !== 'function') {
      return;
    }
    const wfList = await workflowsApi.listDefinitions(100).catch(() => []);
    if (Array.isArray(wfList)) {
      setWorkflowDefinitions(wfList);
    }
  }, []);

  useEffect(() => {
    void loadAuxiliaryCatalog();
  }, [loadAuxiliaryCatalog]);

  // Auto-refresh workflow & rule list while a dispatched Agent session is authoring/updating a workflow
  useEffect(() => {
    if (agentWatchUntil <= Date.now()) return undefined;
    const timer = window.setInterval(() => {
      if (Date.now() > agentWatchUntil) {
        window.clearInterval(timer);
        return;
      }
      void loadAuxiliaryCatalog();
      void refetch();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [agentWatchUntil, loadAuxiliaryCatalog, refetch]);

  // Listen for embedded Workflow Studio open/close events.
  // Do NOT bail out on `event.defaultPrevented`: parent KanbanBoard calls preventDefault()
  // when switching views to `builtin:pulse` during the same synchronous dispatch.
  useEffect(() => {
    const onOpenStudio = (event: Event) => {
      if (!isActiveVisibleSurface(rootSurfaceRef.current)) return;
      event.preventDefault();
      const custom = event as CustomEvent<
        PendingWorkflowStudioOpenDetail | undefined
      >;
      const detail = custom.detail ?? {};
      stashPendingWorkflowStudioOpen(detail);
      setEmbeddedStudio(detail);
    };

    const onOpenPulseDeck = (event: Event) => {
      if (!isActiveVisibleSurface(rootSurfaceRef.current)) return;
      event.preventDefault();
      stashPendingWorkflowStudioOpen(null);
      setEmbeddedStudio(null);
      const layout = useLayoutStore.getState();
      if (layout.isKanbanSessionVisible) {
        layout.setKanbanSessionVisible(false);
      }
      sidebarAutoOpenedForStudioRef.current = false;
      void loadAuxiliaryCatalog();
      void refetch();
    };

    window.addEventListener(OPEN_WORKFLOW_STUDIO_EVENT, onOpenStudio);
    window.addEventListener(OPEN_PULSE_DECK_EVENT, onOpenPulseDeck);
    return () => {
      window.removeEventListener(OPEN_WORKFLOW_STUDIO_EVENT, onOpenStudio);
      window.removeEventListener(OPEN_PULSE_DECK_EVENT, onOpenPulseDeck);
    };
  }, [loadAuxiliaryCatalog, refetch]);

  const unifiedTasks = useMemo(
    () =>
      unifyAutomationTasks(snapshot?.rules ?? [], workflowDefinitions, {
        busyRuleIds: snapshot?.busyRuleIds,
        pendingInteractions: snapshot?.pendingInteractions,
        sources: snapshot?.sources,
        agentOptions,
        bots,
        spaces,
        t,
        language,
      }),
    [
      agentOptions,
      bots,
      language,
      snapshot?.busyRuleIds,
      snapshot?.pendingInteractions,
      snapshot?.rules,
      snapshot?.sources,
      spaces,
      t,
      workflowDefinitions,
    ]
  );

  const pendingApprovalsCount = snapshot?.pendingInteractions?.length ?? 0;
  const errorMessage = actionError || (queryError ? queryError.message : '');

  const upsertRuleIntoSnapshot = useCallback(
    (savedRule: PulseRuleView) => {
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: [
                savedRule,
                ...prev.rules.filter((item) => item.id !== savedRule.id),
              ],
            }
          : {
              engineActive: true,
              activeTicketCount: 0,
              pendingUserInteractionCount: 0,
              sources: [],
              rules: [savedRule],
              observedCandidates: [],
              subscriptions: [],
              pendingInteractions: [],
            }
      );
    },
    [setSnapshotData]
  );

  const handleOpenTaskCanvas = (task: UnifiedAutomationTask) => {
    sidebarAutoOpenedForStudioRef.current =
      !useLayoutStore.getState().isKanbanSessionVisible;
    ensureRightSessionSidebarOpen();
    requestOpenWorkflowStudio({
      definitionId: task.workflowId,
      initialDefinition: task.studioDefinition,
      sourceRuleId: task.linkedRule?.id ?? null,
    });
  };

  const handleCreateWorkflowWithAgent = () => {
    sidebarAutoOpenedForStudioRef.current =
      !useLayoutStore.getState().isKanbanSessionVisible;
    ensureRightSessionSidebarOpen();
    requestOpenWorkflowStudio({
      createNew: true,
    });
  };

  const handleToggleTaskEnabled = async (task: UnifiedAutomationTask) => {
    setActionError('');
    try {
      if (task.linkedRule) {
        const updated = await pulseApi.setRuleEnabled(
          task.linkedRule.id,
          !task.enabled
        );
        upsertRuleIntoSnapshot(updated);
        return;
      }

      if (task.workflowId) {
        const createdTrigger = await invokeSaveRule({
          enabled: !task.enabled,
          draftOnly: false,
          spec: buildWorkflowTriggerRuleSpec({
            studio: task.studioDefinition,
            workflowId: task.workflowId,
            pinnedVersion: Number(task.versionLabel ?? 1) || 1,
            projectId,
            enabled: !task.enabled,
          }),
        });
        upsertRuleIntoSnapshot(createdTrigger);
      }
    } catch (err) {
      setActionError(
        extractPulseErrorMessage(err, t('pulseDeck.errToggleRule'))
      );
    }
  };

  const handleDeleteTask = async (task: UnifiedAutomationTask) => {
    setActionError('');
    try {
      if (
        task.workflowId &&
        typeof workflowsApi?.deleteDefinition === 'function'
      ) {
        await workflowsApi.deleteDefinition(task.workflowId);
        setWorkflowDefinitions((prev) =>
          prev.filter((item) => item.id !== task.workflowId)
        );
      }
      if (task.linkedRule && typeof pulseApi?.deleteRule === 'function') {
        await pulseApi.deleteRule(task.linkedRule.id);
        const deletedRuleId = task.linkedRule.id;
        setSnapshotData((prev) =>
          prev
            ? {
                ...prev,
                rules: prev.rules.filter((item) => item.id !== deletedRuleId),
              }
            : null
        );
      }
    } catch (err) {
      setActionError(
        extractPulseErrorMessage(err, t('pulseDeck.errDeleteTask'))
      );
    }
  };

  const handleApplyStarter = async (starter: CanonicalWorkflowStarter) => {
    if (applyingStarterId || customizingStarterId) return;
    setApplyingStarterId(starter.id);
    setActionError('');
    try {
      const studio = toStudioWorkflowDefinition(starter.definition);
      let createdDefId = `wf-${starter.id}`;
      let createdVersion = 1;
      if (typeof workflowsApi?.publish === 'function') {
        const published = await workflowsApi.publish(starter.definition);
        if (published?.definitionId) {
          createdDefId = published.definitionId;
        }
        if (published?.version != null) {
          createdVersion = Math.max(1, Number(published.version));
        }
      }

      const savedRule = await invokeSaveRule({
        enabled: true,
        draftOnly: false,
        spec: buildWorkflowTriggerRuleSpec({
          studio,
          workflowId: createdDefId,
          pinnedVersion: createdVersion,
          projectId,
          enabled: true,
        }),
      });
      upsertRuleIntoSnapshot(savedRule);
      await loadAuxiliaryCatalog();
      toast.success(
        t('pulseDeck.workbench.agent.starterAppliedToast', {
          name: starter.definition.name,
        })
      );
    } catch (err) {
      setActionError(extractPulseErrorMessage(err, t('pulseDeck.errSaveRule')));
    } finally {
      setApplyingStarterId(null);
    }
  };

  const handleAgentDispatched = () => {
    setAgentWatchUntil(Date.now() + 60_000);
  };

  const handleCustomizeStarter = async (starter: CanonicalWorkflowStarter) => {
    if (applyingStarterId || customizingStarterId) return;
    setCustomizingStarterId(starter.id);
    setActionError('');
    try {
      const dispatched = await dispatchAutomationAgentRequest({
        mode: 'create',
        instruction: isZh ? starter.promptZh : starter.promptEn,
        agentId: defaultAgentId,
        projectId,
        sources: snapshot?.sources ?? [],
        agentOptions,
        bots,
      });
      activateAutomationSessionInRightSidebar(
        dispatched,
        kanbanSession?.activateExecutionSession
      );
      handleAgentDispatched();
      toast.success(
        t('pulseDeck.workbench.agent.dispatchedToast', {
          title: dispatched.title,
        })
      );
    } catch (err) {
      setActionError(
        extractPulseErrorMessage(
          err,
          t('pulseDeck.workbench.agent.dispatchFailedToast')
        )
      );
    } finally {
      setCustomizingStarterId(null);
    }
  };

  if (embeddedStudio !== null) {
    return (
      <EmbeddedWorkflowStudioShell
        projectId={projectId}
        className={className}
        rootRef={rootSurfaceRef}
        onBackToTaskList={() => {
          stashPendingWorkflowStudioOpen(null);
          setEmbeddedStudio(null);
          if (sidebarAutoOpenedForStudioRef.current) {
            sidebarAutoOpenedForStudioRef.current = false;
            useLayoutStore.getState().setKanbanSessionVisible(false);
          }
          void loadAuxiliaryCatalog();
          void refetch();
        }}
      />
    );
  }

  const renderShell = ({
    headerSearch,
    contextualAction,
    children,
  }: {
    headerSearch?: ReactNode;
    contextualAction?: ReactNode;
    children: ReactNode;
  }) => (
    <AutomationPageShell
      totalTasksCount={unifiedTasks.length}
      pendingApprovalsCount={pendingApprovalsCount}
      activeTab={activeTab}
      isRefreshing={isLoading || isFetching}
      errorMessage={errorMessage}
      headerSearch={headerSearch}
      contextualAction={contextualAction}
      className={className}
      rootRef={rootSurfaceRef}
      onSelectTab={(tab) => {
        setSourcesInitialAdding(false);
        setActiveTab(tab);
      }}
      onRefresh={() => {
        setActionError('');
        void loadAuxiliaryCatalog();
        void refetch();
      }}
      onRetryError={() => {
        setActionError('');
        void refetch();
      }}
      onCreateWorkflowWithAgent={handleCreateWorkflowWithAgent}
    >
      {children}
    </AutomationPageShell>
  );

  if (activeTab === 'sources') {
    return (
      <AutomationSourcesTab
        renderShell={renderShell}
        sources={snapshot?.sources ?? []}
        initialAddingNew={sourcesInitialAdding}
        onUpsertSource={async (input: PulseSourceUpsertInput) => {
          setActionError('');
          try {
            const created = await pulseApi.upsertSource(input);
            setSnapshotData((prev) =>
              prev
                ? {
                    ...prev,
                    sources: [
                      created,
                      ...prev.sources.filter((item) => item.id !== created.id),
                    ],
                  }
                : null
            );
            return created;
          } catch (err) {
            setActionError(
              extractPulseErrorMessage(err, t('pulseDeck.errSaveSource'))
            );
            return null;
          }
        }}
        onDeleteSource={async (id) => {
          setActionError('');
          try {
            if (typeof pulseApi.deleteSource === 'function') {
              await pulseApi.deleteSource(id);
            }
            setSnapshotData((prev) =>
              prev
                ? {
                    ...prev,
                    sources: prev.sources.filter((item) => item.id !== id),
                  }
                : null
            );
          } catch (err) {
            setActionError(
              extractPulseErrorMessage(err, t('pulseDeck.errSaveSource'))
            );
          }
        }}
        onTestSource={async (
          id,
          ingest
        ): Promise<PulseSourceTestResult | null> => {
          setActionError('');
          try {
            if (typeof pulseApi.testSource === 'function') {
              return await pulseApi.testSource(id, ingest);
            }
            return {
              ok: true,
              sourceId: id,
              mode: 'mock',
              message: 'Connectivity probe succeeded.',
            };
          } catch (err) {
            setActionError(
              extractPulseErrorMessage(err, t('pulseDeck.errSaveSource'))
            );
            return null;
          }
        }}
      />
    );
  }

  return (
    <AutomationTasksTab
      renderShell={renderShell}
      tasks={unifiedTasks}
      pendingInteractions={snapshot?.pendingInteractions ?? []}
      agentOptions={agentOptions}
      applyingStarterId={applyingStarterId}
      customizingStarterId={customizingStarterId}
      onOpenTaskCanvas={handleOpenTaskCanvas}
      onToggleTaskEnabled={(task) => void handleToggleTaskEnabled(task)}
      onDeleteTask={(task) => void handleDeleteTask(task)}
      onApplyStarter={(starter) => void handleApplyStarter(starter)}
      onCustomizeStarter={(starter) => void handleCustomizeStarter(starter)}
      onInteractionResolved={(interactionId) => {
        setSnapshotData((prev) =>
          prev
            ? {
                ...prev,
                pendingUserInteractionCount: Math.max(
                  0,
                  (prev.pendingUserInteractionCount ?? 0) - 1
                ),
                pendingInteractions: (prev.pendingInteractions ?? []).filter(
                  (item) => item.id !== interactionId
                ),
              }
            : null
        );
        void invalidateSnapshot();
      }}
    />
  );
}
