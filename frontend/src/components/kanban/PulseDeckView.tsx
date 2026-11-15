import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowDefinitionSummary } from 'shared/types';
import { workflowsApi } from '@/features/workflow/workflowApi';
import { usePulseDeckSnapshot } from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type EventEnvelope,
  type EventSourceKind,
  type PulseDryRunReport,
  type PulseEvalMode,
  type PulseObservedCandidateView,
  type PulseRuleSaveInput,
  type PulseRuleSpec,
  type PulseRuleView,
  type PulseSourceTestResult,
  type PulseSourceUpsertInput,
  type PulseSourceView,
  type PulseSubscriptionView,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';
import {
  AutomationHeaderBar,
  EmbeddedWorkflowStudioShell,
} from './automation/AutomationHeaderBar';
import {
  AutomationPendingTab,
  buildCandidateEnvelope,
} from './automation/AutomationPendingTab';
import { AutomationRulesTab } from './automation/AutomationRulesTab';
import { AutomationSourcesTab } from './automation/AutomationSourcesTab';
import { AutomationTasksTab } from './automation/AutomationTasksTab';
import {
  buildDefaultFastTaskSpec,
  buildSampleEnvelopeForRule,
  convertFastTaskToWorkflowDefinition,
  resolveRuleTaskStatus,
  unifyAutomationTasks,
  validateFastTaskForPublish,
  type AutomationPrimaryTab,
  type FastTaskEditorTab,
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

async function invokeSaveRule(input: PulseRuleSaveInput): Promise<PulseRuleView> {
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
  const [capturedEvents, setCapturedEvents] = useState<EventEnvelope[]>([]);
  const [actionError, setActionError] = useState('');

  // Task List & FastTask Editor state
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const [draftRuleId, setDraftRuleId] = useState<string | null>(null);
  const [draftSpec, setDraftSpec] = useState<PulseRuleSpec>(() =>
    buildDefaultFastTaskSpec(
      t('pulseDeck.workbench.tasks.newFastTaskDefaultName'),
      'claude-code',
      projectId
    )
  );
  const [hasUnsavedDraftEdits, setHasUnsavedDraftEdits] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<FastTaskEditorTab>('event');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [lastTestReport, setLastTestReport] =
    useState<PulseDryRunReport | null>(null);
  const [savingTask, setSavingTask] = useState(false);
  const [testingTaskKey, setTestingTaskKey] = useState<string | null>(null);
  const [publishingTaskKey, setPublishingTaskKey] = useState<string | null>(
    null
  );
  const [convertingToWorkflow, setConvertingToWorkflow] = useState(false);
  const [sourcesInitialAdding, setSourcesInitialAdding] = useState(false);

  // Pending tab candidate dry-run state
  const [inspectedCandidateId, setInspectedCandidateId] = useState<
    string | null
  >(null);
  const [inspectedReport, setInspectedReport] =
    useState<PulseDryRunReport | null>(null);

  const loadAuxiliaryCatalog = useCallback(async () => {
    const wfPromise =
      typeof workflowsApi?.listDefinitions === 'function'
        ? workflowsApi.listDefinitions(100).catch(() => [])
        : Promise.resolve([]);
    const evtPromise =
      typeof pulseApi?.listCapturedEvents === 'function'
        ? pulseApi.listCapturedEvents(25).catch(() => [])
        : Promise.resolve([]);
    const [wfList, evtList] = await Promise.all([wfPromise, evtPromise]);
    if (Array.isArray(wfList)) {
      setWorkflowDefinitions(wfList);
    }
    if (Array.isArray(evtList)) {
      setCapturedEvents(evtList);
    }
  }, []);

  useEffect(() => {
    void loadAuxiliaryCatalog();
  }, [loadAuxiliaryCatalog]);

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
  }, [snapshot?.sources, t, i18n.language]);

  const dirtyTaskKeys = useMemo(() => {
    const set = new Set<string>();
    if (hasUnsavedDraftEdits && draftRuleId) {
      set.add(`fast:${draftRuleId}`);
    }
    return set;
  }, [draftRuleId, hasUnsavedDraftEdits]);

  const unifiedTasks = useMemo(
    () =>
      unifyAutomationTasks(snapshot?.rules ?? [], workflowDefinitions, {
        busyRuleIds: snapshot?.busyRuleIds,
        testingTaskKey,
        publishingTaskKey,
        dirtyTaskKeys,
      }),
    [
      dirtyTaskKeys,
      publishingTaskKey,
      snapshot?.busyRuleIds,
      snapshot?.rules,
      testingTaskKey,
      workflowDefinitions,
    ]
  );

  // Auto-select first FastTask when snapshot loads and nothing is selected yet
  useEffect(() => {
    if (selectedTaskKey !== null) return;
    const firstFast = unifiedTasks.find((item) => item.kind === 'fast_task');
    if (firstFast && firstFast.kind === 'fast_task') {
      setSelectedTaskKey(firstFast.key);
      setDraftRuleId(firstFast.rule.id);
      setDraftSpec(firstFast.rule.spec);
      setHasUnsavedDraftEdits(false);
      return;
    }
    const firstWf = unifiedTasks.find((item) => item.kind === 'workflow');
    if (firstWf) {
      setSelectedTaskKey(firstWf.key);
    }
  }, [selectedTaskKey, unifiedTasks]);

  const selectedWorkflowTask = useMemo(() => {
    const found = unifiedTasks.find((item) => item.key === selectedTaskKey);
    return found?.kind === 'workflow' ? found : null;
  }, [selectedTaskKey, unifiedTasks]);

  const existingDraftRule = useMemo(
    () => (snapshot?.rules ?? []).find((r) => r.id === draftRuleId) ?? null,
    [draftRuleId, snapshot?.rules]
  );

  const currentEditorTaskKey = draftRuleId ? `fast:${draftRuleId}` : 'fast:new';
  const editorStatus = resolveRuleTaskStatus(existingDraftRule, {
    busyRuleIds: snapshot?.busyRuleIds,
    testingTaskKey,
    publishingTaskKey,
    hasUnsavedChanges: hasUnsavedDraftEdits,
    taskKey: currentEditorTaskKey,
  });

  const pendingEventsCount =
    (snapshot?.pendingInteractions?.length ?? 0) +
    (snapshot?.observedCandidates?.filter((c) => !c.promoted).length ?? 0);
  const connectedSourcesCount = (snapshot?.sources ?? []).filter(
    (s) => s.enabled
  ).length;
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

  const handleStartNewFastTask = () => {
    setActiveTab('tasks');
    setSelectedTaskKey('fast:new');
    setDraftRuleId(null);
    setDraftSpec(
      buildDefaultFastTaskSpec(
        t('pulseDeck.workbench.tasks.newFastTaskDefaultName'),
        'claude-code',
        projectId
      )
    );
    setHasUnsavedDraftEdits(true);
    setActiveSubTab('event');
    setValidationErrors([]);
    setLastTestReport(null);
  };

  const handleOpenStudio = (definitionId?: string | null) => {
    requestOpenWorkflowStudio({ definitionId: definitionId ?? null });
  };

  const handleSelectFastTask = (
    rule: PulseRuleView,
    subTab?: FastTaskEditorTab
  ) => {
    setSelectedTaskKey(`fast:${rule.id}`);
    setDraftRuleId(rule.id);
    setDraftSpec(rule.spec);
    setHasUnsavedDraftEdits(false);
    setValidationErrors([]);
    setLastTestReport(null);
    if (subTab) {
      setActiveSubTab(subTab);
    }
  };

  const handleSaveFastTaskDraft = async () => {
    if (savingTask) return;
    setSavingTask(true);
    setActionError('');
    setValidationErrors([]);
    try {
      const nextSpec: PulseRuleSpec = {
        ...draftSpec,
        projectId: draftSpec.projectId ?? projectId ?? null,
        taskMeta: {
          ...draftSpec.taskMeta,
          taskKind: 'fast_task',
          lifecycleState: 'pending_test',
        },
      };
      const saved = await invokeSaveRule({
        id: draftRuleId,
        enabled: existingDraftRule?.enabled ?? false,
        draftOnly: false,
        spec: nextSpec,
      });
      upsertRuleIntoSnapshot(saved);
      setDraftRuleId(saved.id);
      setDraftSpec(saved.spec);
      setSelectedTaskKey(`fast:${saved.id}`);
      setHasUnsavedDraftEdits(false);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
      );
    } finally {
      setSavingTask(false);
    }
  };

  const runTestForRule = async (
    targetRuleId: string | null,
    specToTest: PulseRuleSpec
  ) => {
    const taskKey = targetRuleId ? `fast:${targetRuleId}` : 'fast:new';
    setTestingTaskKey(taskKey);
    setActionError('');
    setValidationErrors([]);
    const sample = buildSampleEnvelopeForRule(specToTest);
    let report = evaluatePulseRuleLocally(specToTest, sample);
    try {
      if (typeof pulseApi.dryRunRule === 'function') {
        report = await pulseApi.dryRunRule(specToTest, sample);
      }
      setLastTestReport(report);
      const testedSpec: PulseRuleSpec = {
        ...specToTest,
        projectId: specToTest.projectId ?? projectId ?? null,
        taskMeta: {
          ...specToTest.taskMeta,
          taskKind: 'fast_task',
          lifecycleState:
            specToTest.taskMeta?.lifecycleState === 'published'
              ? 'published'
              : 'pending_test',
          lastTestedAt: new Date().toISOString(),
          lastTestPassed: report.valid && report.matched,
        },
      };
      setDraftSpec(testedSpec);
      if (targetRuleId) {
        const saved = await invokeSaveRule({
          id: targetRuleId,
          enabled: existingDraftRule?.enabled ?? false,
          draftOnly: false,
          spec: testedSpec,
        });
        upsertRuleIntoSnapshot(saved);
        setHasUnsavedDraftEdits(false);
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
      );
    } finally {
      setTestingTaskKey(null);
    }
  };

  const publishSpec = async (
    targetRuleId: string | null,
    specToPublish: PulseRuleSpec
  ) => {
    const errors = validateFastTaskForPublish(specToPublish, t);
    setValidationErrors(errors);
    if (errors.length > 0) {
      return;
    }
    const taskKey = targetRuleId ? `fast:${targetRuleId}` : 'fast:new';
    setPublishingTaskKey(taskKey);
    setActionError('');
    try {
      const publishedSpec: PulseRuleSpec = {
        ...specToPublish,
        projectId: specToPublish.projectId ?? projectId ?? null,
        evalMode: 'auto',
        taskMeta: {
          ...specToPublish.taskMeta,
          taskKind: 'fast_task',
          lifecycleState: 'published',
        },
      };
      const saved = await invokeSaveRule({
        id: targetRuleId,
        enabled: true,
        draftOnly: false,
        spec: publishedSpec,
      });
      upsertRuleIntoSnapshot(saved);
      setDraftRuleId(saved.id);
      setDraftSpec(saved.spec);
      setSelectedTaskKey(`fast:${saved.id}`);
      setHasUnsavedDraftEdits(false);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
      );
    } finally {
      setPublishingTaskKey(null);
    }
  };

  const handleConvertToWorkflow = async () => {
    if (convertingToWorkflow) return;
    setConvertingToWorkflow(true);
    setActionError('');
    try {
      const backendDef = convertFastTaskToWorkflowDefinition(
        draftSpec,
        i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
      );
      let createdDefId: string | null = null;
      if (typeof workflowsApi?.publish === 'function') {
        const published = await workflowsApi.publish(backendDef);
        createdDefId = published?.definitionId ?? null;
      }
      await loadAuxiliaryCatalog();
      handleOpenStudio(createdDefId);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
      );
    } finally {
      setConvertingToWorkflow(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    setActionError('');
    try {
      if (typeof pulseApi.deleteRule === 'function') {
        await pulseApi.deleteRule(ruleId);
      }
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.filter((item) => item.id !== ruleId),
            }
          : null
      );
      if (draftRuleId === ruleId) {
        setDraftRuleId(null);
        setSelectedTaskKey(null);
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
      );
    }
  };

  const handleToggleTaskEnabled = async (task: UnifiedAutomationTask) => {
    setActionError('');
    try {
      if (task.kind === 'fast_task') {
        const updated = await pulseApi.setRuleEnabled(task.id, !task.enabled);
        upsertRuleIntoSnapshot(updated);
        return;
      }
      if (task.triggerRule) {
        const updated = await pulseApi.setRuleEnabled(
          task.triggerRule.id,
          !task.triggerRule.enabled
        );
        upsertRuleIntoSnapshot(updated);
      } else {
        const createdTrigger = await invokeSaveRule({
          enabled: !task.enabled,
          draftOnly: false,
          spec: {
            name: task.name,
            projectId: projectId ?? null,
            evalMode: !task.enabled ? 'auto' : 'off',
            filter: {
              sourceKinds: ['webhook_standard'],
              sourceInstanceIds: [],
              eventTypes: ['workflow.trigger'],
              allowedActors: [],
              conditions: [],
            },
            targets: [
              {
                kind: 'workflow',
                workflowId: task.workflowId,
                pinnedVersion: Number(task.versionLabel ?? 1) || 1,
              },
            ],
            taskMeta: {
              taskKind: 'workflow_trigger',
              lifecycleState: 'published',
            },
          },
        });
        upsertRuleIntoSnapshot(createdTrigger);
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errToggleRule')
      );
    }
  };

  if (embeddedStudio !== null) {
    return (
      <EmbeddedWorkflowStudioShell
        embeddedStudio={embeddedStudio}
        workflowDefinitions={workflowDefinitions}
        className={className}
        onBackToTaskList={() => {
          stashPendingWorkflowStudioOpen(null);
          setEmbeddedStudio(null);
          void loadAuxiliaryCatalog();
          void refetch();
        }}
      />
    );
  }

  return (
    <div
      data-testid="pulse-deck-view"
      className={cn(
        'flex h-full min-h-0 flex-col bg-[var(--surface-panel)] text-foreground',
        className
      )}
    >
      <AutomationHeaderBar
        engineActive={snapshot?.engineActive !== false}
        totalTasksCount={unifiedTasks.length}
        pendingEventsCount={pendingEventsCount}
        connectedSourcesCount={connectedSourcesCount}
        activeTab={activeTab}
        isRefreshing={isLoading || isFetching}
        errorMessage={errorMessage}
        onSelectTab={(tab) => {
          setSourcesInitialAdding(false);
          setActiveTab(tab);
        }}
        onNewFastTask={handleStartNewFastTask}
        onNewWorkflow={() => handleOpenStudio(null)}
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

      {/* Active Tab Master-Detail Body */}
      {activeTab === 'tasks' ? (
        <AutomationTasksTab
          tasks={unifiedTasks}
          selectedTaskKey={selectedTaskKey}
          onSelectFastTask={handleSelectFastTask}
          onSelectWorkflowTask={(wfTask) => setSelectedTaskKey(wfTask.key)}
          onStartNewFastTask={handleStartNewFastTask}
          onOpenWorkflowStudio={handleOpenStudio}
          onToggleTaskEnabled={(task) => void handleToggleTaskEnabled(task)}
          onQuickTestFastTask={(rule) => {
            handleSelectFastTask(rule);
            void runTestForRule(rule.id, rule.spec);
          }}
          onQuickPublishFastTask={(rule) => {
            handleSelectFastTask(rule);
            void publishSpec(rule.id, rule.spec);
          }}
          onQuickDeleteFastTask={(rule) => void handleDeleteRule(rule.id)}
          selectedWorkflowTask={selectedWorkflowTask}
          draftRuleId={draftRuleId}
          draftSpec={draftSpec}
          existingRule={existingDraftRule}
          editorStatus={editorStatus}
          activeSubTab={activeSubTab}
          onSubTabChange={setActiveSubTab}
          onSpecChange={(nextSpec) => {
            setDraftSpec(nextSpec);
            setHasUnsavedDraftEdits(true);
            setValidationErrors([]);
          }}
          sources={snapshot?.sources ?? []}
          allRules={snapshot?.rules ?? []}
          capturedEvents={capturedEvents}
          recentOutbox={snapshot?.recentOutbox ?? []}
          validationErrors={validationErrors}
          lastTestReport={lastTestReport}
          saving={savingTask}
          testing={testingTaskKey === currentEditorTaskKey}
          publishing={publishingTaskKey === currentEditorTaskKey}
          converting={convertingToWorkflow}
          onSaveDraft={() => void handleSaveFastTaskDraft()}
          onTestTask={() => void runTestForRule(draftRuleId, draftSpec)}
          onEmitLiveSample={() => {
            if (typeof pulseApi.emitCustomEvent === 'function') {
              const sample = buildSampleEnvelopeForRule(draftSpec);
              void pulseApi
                .emitCustomEvent({
                  eventType: sample.eventType,
                  threadKey: sample.threadKey,
                  payload: sample.payload,
                })
                .then(() => loadAuxiliaryCatalog())
                .catch(() => undefined);
            }
          }}
          onPublishTask={() => void publishSpec(draftRuleId, draftSpec)}
          onConvertToWorkflow={() => void handleConvertToWorkflow()}
          onDeleteTask={() => {
            if (draftRuleId) {
              void handleDeleteRule(draftRuleId);
            }
          }}
          onJumpCreateSource={() => {
            setSourcesInitialAdding(true);
            setActiveTab('sources');
          }}
        />
      ) : null}

      {activeTab === 'pending' ? (
        <AutomationPendingTab
          pendingInteractions={snapshot?.pendingInteractions ?? []}
          observedCandidates={snapshot?.observedCandidates ?? []}
          inspectedCandidateId={inspectedCandidateId}
          inspectedReport={inspectedReport}
          onInspectCandidateDryRun={(candidate) => {
            const envelope = buildCandidateEnvelope(candidate);
            const matchingRule = snapshot?.rules.find(
              (r) => r.id === candidate.ruleId
            );
            setInspectedCandidateId(candidate.id);
            if (!matchingRule) {
              setInspectedReport({
                valid: true,
                matched: true,
                violations: [],
                unmatchedConditions: [],
                renderedPreviews: [candidate.summary],
              });
              return;
            }
            const local = evaluatePulseRuleLocally(matchingRule.spec, envelope);
            setInspectedReport(local);
            if (typeof pulseApi.dryRunRule === 'function') {
              void pulseApi
                .dryRunRule(matchingRule.spec, envelope)
                .then((remote) => setInspectedReport(remote))
                .catch(() => undefined);
            }
          }}
          onPromoteCandidate={(candidate: PulseObservedCandidateView) => {
            setActionError('');
            void pulseApi
              .promoteObservedCandidate(candidate.id)
              .then(() => {
                setSnapshotData((prev) =>
                  prev
                    ? {
                        ...prev,
                        observedCandidates: prev.observedCandidates.map((c) =>
                          c.id === candidate.id ? { ...c, promoted: true } : c
                        ),
                        rules: prev.rules.map((r) =>
                          r.id === candidate.ruleId
                            ? { ...r, spec: { ...r.spec, evalMode: 'auto' } }
                            : r
                        ),
                      }
                    : null
                );
              })
              .catch((err) =>
                setActionError(
                  err instanceof Error
                    ? err.message
                    : t('pulseDeck.errPromote')
                )
              );
          }}
          onPromoteAndEditTask={(candidate) => {
            const matchingRule = snapshot?.rules.find(
              (r) => r.id === candidate.ruleId
            );
            if (matchingRule) {
              handleSelectFastTask(matchingRule);
              setActiveTab('tasks');
              return;
            }
            setDraftRuleId(null);
            setDraftSpec({
              ...buildDefaultFastTaskSpec(
                candidate.ruleName || candidate.eventType,
                'claude-code',
                projectId
              ),
              filter: {
                sourceKinds: [candidate.sourceKind],
                sourceInstanceIds: [],
                eventTypes: [candidate.eventType],
                allowedActors: [],
                conditions: [],
              },
            });
            setSelectedTaskKey('fast:new');
            setHasUnsavedDraftEdits(true);
            setActiveTab('tasks');
          }}
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

      {activeTab === 'rules' ? (
        <AutomationRulesTab
          projectId={projectId}
          rules={snapshot?.rules ?? []}
          capturedEvents={capturedEvents}
          onSetRuleMode={(rule: PulseRuleView, mode: PulseEvalMode) => {
            setActionError('');
            void pulseApi
              .setRuleMode(rule.id, mode)
              .then((updated) => upsertRuleIntoSnapshot(updated))
              .catch((err) =>
                setActionError(
                  err instanceof Error
                    ? err.message
                    : t('pulseDeck.errUpdateMode')
                )
              );
          }}
          onSaveRule={async (ruleId, spec, enabled) => {
            setActionError('');
            try {
              const saved = await invokeSaveRule({
                id: ruleId,
                enabled,
                draftOnly: false,
                spec: {
                  ...spec,
                  projectId: spec.projectId ?? projectId ?? null,
                },
              });
              upsertRuleIntoSnapshot(saved);
              return saved;
            } catch (err) {
              setActionError(
                err instanceof Error ? err.message : t('pulseDeck.errSaveRule')
              );
              return null;
            }
          }}
          onDeleteRule={(ruleId) => void handleDeleteRule(ruleId)}
          onCreateFastTaskFromRule={(ruleSpec, templateId) => {
            setSelectedTaskKey('fast:new');
            setDraftRuleId(null);
            setDraftSpec({
              ...buildDefaultFastTaskSpec(
                ruleSpec.name ||
                  t('pulseDeck.workbench.tasks.newFastTaskDefaultName'),
                'claude-code',
                projectId
              ),
              filter: ruleSpec.filter,
              taskMeta: {
                taskKind: 'fast_task',
                lifecycleState: 'editing',
                boundRuleTemplateId: templateId ?? null,
              },
            });
            setHasUnsavedDraftEdits(true);
            setActiveSubTab('target');
            setActiveTab('tasks');
          }}
        />
      ) : null}

      {activeTab === 'sources' ? (
        <AutomationSourcesTab
          sources={displayedSources}
          subscriptions={snapshot?.subscriptions ?? []}
          workflows={workflowDefinitions}
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
          onSubscribeThread={async (threadKey, kind, subscriberId) => {
            setActionError('');
            try {
              const created: PulseSubscriptionView =
                await pulseApi.subscribeThread(threadKey, kind, subscriberId);
              setSnapshotData((prev) =>
                prev
                  ? {
                      ...prev,
                      subscriptions: [
                        created,
                        ...prev.subscriptions.filter(
                          (item) => item.id !== created.id
                        ),
                      ],
                    }
                  : null
              );
            } catch (err) {
              setActionError(
                err instanceof Error
                  ? err.message
                  : t('pulseDeck.errSubscribe')
              );
            }
          }}
          onUnsubscribeThread={async (subscriptionId) => {
            setActionError('');
            try {
              await pulseApi.unsubscribeThread(subscriptionId);
              setSnapshotData((prev) =>
                prev
                  ? {
                      ...prev,
                      subscriptions: prev.subscriptions.filter(
                        (item) => item.id !== subscriptionId
                      ),
                    }
                  : null
              );
            } catch (err) {
              setActionError(
                err instanceof Error
                  ? err.message
                  : t('pulseDeck.errUnsubscribe')
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}
