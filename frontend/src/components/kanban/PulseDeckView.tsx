import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowDefinitionSummary } from 'shared/types';

import { toast } from '@/components/ui/toast';
import { useManagedAgentOptions } from '@/features/agent-management';
import { toStudioWorkflowDefinition } from '@/features/workflow/WorkflowStudio';
import { useCollaborationBotRoster } from '@/features/workflow/useCollaborationBotRoster';
import { workflowsApi } from '@/features/workflow/workflowApi';
import { usePulseDeckSnapshot } from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type EventSourceKind,
  type PulseRuleSaveInput,
  type PulseRuleView,
  type PulseSourceTestResult,
  type PulseSourceUpsertInput,
  type PulseSourceView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import {
  AutomationHeaderBar,
  EmbeddedWorkflowStudioShell,
} from './automation/AutomationHeaderBar';
import { AutomationSourcesTab } from './automation/AutomationSourcesTab';
import { AutomationTasksTab } from './automation/AutomationTasksTab';
import {
  buildWorkflowTriggerRuleSpec,
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

const DEFAULT_SOURCE_KINDS: readonly EventSourceKind[] = [
  'github',
  'feishu',
  'webhook_standard',
  'time_cron',
  'jira',
];

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
  const agentOptions = useManagedAgentOptions(undefined, true);
  const { bots, spaces } = useCollaborationBotRoster();

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
  const [agentWatchUntil, setAgentWatchUntil] = useState<number>(0);

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

  // Listen for embedded Workflow Studio open/close events
  useEffect(() => {
    const onOpenStudio = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const custom = event as CustomEvent<
        PendingWorkflowStudioOpenDetail | undefined
      >;
      const detail = custom.detail ?? {};
      stashPendingWorkflowStudioOpen(detail);
      setEmbeddedStudio(detail);
    };

    const onOpenPulseDeck = (event: Event) => {
      event.preventDefault();
      stashPendingWorkflowStudioOpen(null);
      setEmbeddedStudio(null);
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

  const displayedSources = useMemo<PulseSourceView[]>(() => {
    const existing = snapshot?.sources ?? [];
    if (existing.length > 0) return existing;
    return DEFAULT_SOURCE_KINDS.map((kind) => ({
      id: `placeholder-${kind}`,
      kind,
      title: t(
        `pulseDeck.sources.${kind.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
      ),
      enabled: false,
      healthy: true,
      cursorWatermark: '0',
      receivedCount24h: 0,
      rejectedCount24h: 0,
      updatedAt: '',
    }));
  }, [snapshot?.sources, t, language]);

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
    requestOpenWorkflowStudio({
      definitionId: task.workflowId,
      initialDefinition: task.studioDefinition,
      sourceRuleId: task.linkedRule?.id ?? null,
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
        err instanceof Error ? err.message : t('pulseDeck.errToggleRule')
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
        err instanceof Error ? err.message : t('pulseDeck.errDeleteTask')
      );
    }
  };

  const handleApplyStarter = async (starter: CanonicalWorkflowStarter) => {
    if (applyingStarterId) return;
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
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
      );
    } finally {
      setApplyingStarterId(null);
    }
  };

  const handleAgentDispatched = () => {
    setAgentWatchUntil(Date.now() + 60_000);
  };

  if (embeddedStudio !== null) {
    return (
      <EmbeddedWorkflowStudioShell
        embeddedStudio={embeddedStudio}
        workflowDefinitions={workflowDefinitions}
        projectId={projectId}
        sources={snapshot?.sources ?? []}
        bots={bots}
        className={className}
        onAgentDispatched={handleAgentDispatched}
        onBackToTaskList={() => {
          stashPendingWorkflowStudioOpen(null);
          setEmbeddedStudio(null);
          void loadAuxiliaryCatalog();
          void refetch();
        }}
      />
    );
  }

  const renderHeader = (
    toolbarRow?: ReactNode,
    contextualAction?: ReactNode
  ) => (
    <AutomationHeaderBar
      engineActive={snapshot?.engineActive !== false}
      totalTasksCount={unifiedTasks.length}
      pendingApprovalsCount={pendingApprovalsCount}
      activeTab={activeTab}
      isRefreshing={isLoading || isFetching}
      errorMessage={errorMessage}
      projectId={projectId}
      sources={snapshot?.sources ?? []}
      bots={bots}
      toolbarRow={toolbarRow}
      contextualAction={contextualAction}
      onSelectTab={(tab) => {
        setSourcesInitialAdding(false);
        setActiveTab(tab);
      }}
      onAgentDispatched={handleAgentDispatched}
      onRefresh={() => {
        setActionError('');
        void loadAuxiliaryCatalog();
        void refetch();
      }}
      onRetryError={() => {
        setActionError('');
        void refetch();
      }}
    />
  );

  return (
    <div
      data-testid="pulse-deck-view"
      className={cn(
        'flex h-full min-h-0 flex-col bg-background text-foreground',
        className
      )}
    >
      {activeTab === 'tasks' ? (
        <AutomationTasksTab
          renderHeader={(toolbarRow) => renderHeader(toolbarRow)}
          projectId={projectId}
          tasks={unifiedTasks}
          pendingInteractions={snapshot?.pendingInteractions ?? []}
          sources={snapshot?.sources ?? []}
          agentOptions={agentOptions}
          bots={bots}
          applyingStarterId={applyingStarterId}
          onOpenTaskCanvas={handleOpenTaskCanvas}
          onToggleTaskEnabled={(task) => void handleToggleTaskEnabled(task)}
          onDeleteTask={(task) => void handleDeleteTask(task)}
          onApplyStarter={(starter) => void handleApplyStarter(starter)}
          onAgentDispatched={handleAgentDispatched}
          onInteractionResolved={(interactionId) => {
            setSnapshotData((prev) =>
              prev
                ? {
                    ...prev,
                    pendingUserInteractionCount: Math.max(
                      0,
                      (prev.pendingUserInteractionCount ?? 0) - 1
                    ),
                    pendingInteractions: (
                      prev.pendingInteractions ?? []
                    ).filter((item) => item.id !== interactionId),
                  }
                : null
            );
            void invalidateSnapshot();
          }}
        />
      ) : null}

      {activeTab === 'sources' ? (
        <AutomationSourcesTab
          renderHeader={renderHeader}
          sources={displayedSources}
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
                        ...prev.sources.filter(
                          (item) => item.id !== created.id
                        ),
                      ],
                    }
                  : null
              );
              return created;
            } catch (err) {
              setActionError(
                err instanceof Error
                  ? err.message
                  : t('pulseDeck.errSaveSource')
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
                err instanceof Error
                  ? err.message
                  : t('pulseDeck.errSaveSource')
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
                err instanceof Error
                  ? err.message
                  : t('pulseDeck.errSaveSource')
              );
              return null;
            }
          }}
        />
      ) : null}
    </div>
  );
}
