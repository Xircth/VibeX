import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useTranslation } from 'react-i18next';
import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowDefinitionSummary,
  WorkflowEventRecord,
  WorkflowRunView,
  WorkflowStepView,
  WorkflowVersionView,
} from 'shared/types';

import { buildWorkflowTriggerRuleSpec } from '@/components/kanban/automation/automationAgentBridge';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import {
  AstryxSelect,
  type AstryxSelectOption,
} from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useManagedAgentOptions } from '@/features/agent-management';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
import { BUILT_IN_SAMPLE_EVENTS } from '@/features/pulse';
import { PULSE_DECK_CHANGED_EVENT } from '@/hooks/usePulseDeckSnapshot';
import { projectsApi } from '@/lib/api/projects';
import {
  createPulseApi,
  pulseApi,
  type EventEnvelope,
  type PulseOutboxEntryView,
  type PulseSourceView,
} from '@/lib/api/pulse';
import { sessionsApi } from '@/lib/api/sessions';
import { backendListen } from '@/lib/backendTransport';
import {
  configuredBackendTransport,
  useBackendTransport,
} from '@/lib/transport';

import { useCollaborationBotRoster } from './useCollaborationBotRoster';
import { useGuardedWorkflowRunPolling } from './useGuardedWorkflowRunPolling';
import {
  WorkflowStudio,
  getWorkflowPresetTemplates,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
  validateStudioWorkflowExhaustively,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
  type WorkflowTranslateFn,
} from './WorkflowStudio';
import { resolveWorkflowAgentId } from './workflowAgent';
import { createWorkflowApi, workflowsApi } from './workflowApi';

type StudioTriggerStep = Extract<StudioWorkflowStep, { kind: 'trigger' }>;

export type WorkflowStudioOpenDetail = {
  definitionId?: string | null;
  presetId?: string | null;
  initialDefinition?: StudioWorkflowDefinition | null;
  sourceRuleId?: string | null;
  createNew?: boolean;
};

type WorkflowStudioWindow = Window & {
  __VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__?: WorkflowStudioOpenDetail | null;
};

export type WorkflowStudioDockPanelProps = Partial<IDockviewPanelProps> & {
  embedded?: boolean;
  projectId?: string | null;
  onBack?: () => void;
  rightToolbarSlot?: ReactNode;
};

function serializeStudioDefinition(
  definition: StudioWorkflowDefinition
): string {
  return JSON.stringify(definition, (_key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  );
}

function formatReleaseVersion(
  version: bigint | number | null | undefined
): string {
  if (version == null) return '0.1';
  const numeric = typeof version === 'bigint' ? Number(version) : version;
  return (Math.max(1, numeric) / 10).toFixed(1);
}

function createStarterWorkflow(
  defaultAgentId: string,
  t: WorkflowTranslateFn
): StudioWorkflowDefinition {
  const preset = getWorkflowPresetTemplates(t)[0].build(defaultAgentId);
  return {
    ...preset,
    name: t('studio.newWorkflowDefaultName'),
    orchestratorPreset: preset.orchestratorPreset ?? 'direct_reflex',
  };
}

export function WorkflowStudioDockPanel(props?: WorkflowStudioDockPanelProps) {
  const embedded = Boolean(props?.embedded);
  const projectId = props?.projectId ?? null;
  const { t, i18n } = useTranslation('workflow');
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
  const transport = useBackendTransport();
  const { config } = useOptionalUserSystem() ?? {};
  const agentOptions = useManagedAgentOptions(undefined, true);
  const { bots, spaces } = useCollaborationBotRoster('default', language);
  const defaultAgentId = useMemo(
    () =>
      resolveWorkflowAgentId(agentOptions, config?.executor_profile?.executor),
    [agentOptions, config?.executor_profile?.executor]
  );

  const workflowClient = useMemo(
    () =>
      transport === configuredBackendTransport
        ? workflowsApi
        : createWorkflowApi(transport),
    [transport]
  );
  const pulseClient = useMemo(
    () =>
      transport === configuredBackendTransport
        ? pulseApi
        : createPulseApi(transport),
    [transport]
  );

  const [definitions, setDefinitions] = useState<WorkflowDefinitionSummary[]>(
    []
  );
  const [sources, setSources] = useState<PulseSourceView[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<
    string | null
  >(null);
  const [sourceRuleId, setSourceRuleId] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] =
    useState<WorkflowVersionView | null>(null);
  const [definition, setDefinition] = useState<StudioWorkflowDefinition>(() =>
    createStarterWorkflow(defaultAgentId, t)
  );
  const [savedDefinition, setSavedDefinition] =
    useState<StudioWorkflowDefinition>(definition);
  const [undoStack, setUndoStack] = useState<StudioWorkflowDefinition[]>([]);
  const [capturedEvents, setCapturedEvents] = useState<EventEnvelope[]>(() => [
    ...BUILT_IN_SAMPLE_EVENTS,
  ]);

  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingWorkflow, setLoadingWorkflow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [savedRuleIds, setSavedRuleIds] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<WorkflowRunView | null>(null);
  const [runSteps, setRunSteps] = useState<WorkflowStepView[]>([]);
  const [runEvents, setRunEvents] = useState<WorkflowEventRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [outboxEntries, setOutboxEntries] = useState<PulseOutboxEntryView[]>(
    []
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const hasUserEditedRef = useRef(false);
  const definitionsRef = useRef<WorkflowDefinitionSummary[]>([]);
  const loadingCatalogRef = useRef(true);
  const agentPollTimerRef = useRef<number | null>(null);

  const dirty = useMemo(
    () =>
      serializeStudioDefinition(definition) !==
      serializeStudioDefinition(savedDefinition),
    [definition, savedDefinition]
  );

  const triggerSteps = useMemo(
    () =>
      definition.steps.filter(
        (step): step is StudioTriggerStep => step.kind === 'trigger'
      ),
    [definition.steps]
  );

  const loadWorkflowSelection = useCallback(
    async (summary: WorkflowDefinitionSummary) => {
      setSelectedDefinitionId(summary.id);
      setErrorMessage(null);
      setStatusMessage(null);
      if (!summary.latestVersionId) {
        if (summary.latestNormalizedJson) {
          try {
            const parsed = JSON.parse(
              summary.latestNormalizedJson
            ) as WorkflowDefinition;
            const hydrated = toStudioWorkflowDefinition(parsed);
            setActiveVersion(null);
            setDefinition(hydrated);
            setSavedDefinition(hydrated);
            setUndoStack([]);
            return;
          } catch {
            // fall through to starter
          }
        }
        const fresh = {
          ...createStarterWorkflow(defaultAgentId, t),
          name: summary.name,
        };
        setActiveVersion(null);
        setDefinition(fresh);
        setSavedDefinition(fresh);
        setUndoStack([]);
        return;
      }
      setLoadingWorkflow(true);
      try {
        const versionView = await workflowClient.version(
          summary.latestVersionId
        );
        const parsed = JSON.parse(
          versionView.normalizedJson
        ) as WorkflowDefinition;
        const hydrated = toStudioWorkflowDefinition(parsed);
        const nextDefinition: StudioWorkflowDefinition = {
          ...hydrated,
          name: summary.name || hydrated.name,
          orchestratorPreset: hydrated.orchestratorPreset ?? null,
        };
        setActiveVersion(versionView);
        setDefinition(nextDefinition);
        setSavedDefinition(nextDefinition);
        setUndoStack([]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
      } finally {
        setLoadingWorkflow(false);
      }
    },
    [defaultAgentId, t, workflowClient]
  );

  const applyPresetTemplateById = useCallback(
    (presetId: string): boolean => {
      const template = getWorkflowPresetTemplates(t).find(
        (item) => item.id === presetId
      );
      if (!template) return false;
      hasUserEditedRef.current = true;
      const nextDefinition = template.build(defaultAgentId);
      setSelectedDefinitionId(null);
      setSourceRuleId(null);
      setActiveVersion(null);
      setSavedRuleIds({});
      setDefinition(nextDefinition);
      setSavedDefinition(nextDefinition);
      setUndoStack([]);
      setErrorMessage(null);
      setStatusMessage(null);
      return true;
    },
    [defaultAgentId, t]
  );

  const startNewWorkflowDraft = useCallback(() => {
    hasUserEditedRef.current = true;
    const fresh = createStarterWorkflow(defaultAgentId, t);
    setSelectedDefinitionId(null);
    setSourceRuleId(null);
    setActiveVersion(null);
    setSavedRuleIds({});
    setDefinition(fresh);
    setSavedDefinition(fresh);
    setUndoStack([]);
    setErrorMessage(null);
    setStatusMessage(null);
  }, [defaultAgentId, t]);

  const handleOpenRequest = useCallback(
    async (
      detail: WorkflowStudioOpenDetail | null | undefined,
      availableDefinitions: WorkflowDefinitionSummary[],
      allowCatalogRefresh = false
    ): Promise<boolean> => {
      if (!detail) return false;
      setSourceRuleId(detail.sourceRuleId ?? null);

      if (detail.createNew) {
        startNewWorkflowDraft();
        return true;
      }

      const targetDefinitionId = detail.definitionId?.trim();
      if (targetDefinitionId) {
        const safeInitial = Array.isArray(availableDefinitions)
          ? availableDefinitions
          : [];
        let match = safeInitial.find(
          (item) =>
            item.id === targetDefinitionId || item.name === targetDefinitionId
        );
        if (!match && allowCatalogRefresh) {
          const refreshed = await workflowClient
            .listDefinitions(100)
            .catch(() => null);
          if (Array.isArray(refreshed)) {
            definitionsRef.current = refreshed;
            setDefinitions(refreshed);
            match = refreshed.find(
              (item) =>
                item.id === targetDefinitionId ||
                item.name === targetDefinitionId
            );
          }
        }
        if (match) {
          hasUserEditedRef.current = true;
          await loadWorkflowSelection(match);
          return true;
        }
      }

      if (detail.initialDefinition) {
        hasUserEditedRef.current = true;
        setSelectedDefinitionId(targetDefinitionId || null);
        setActiveVersion(null);
        setSavedRuleIds({});
        setDefinition(detail.initialDefinition);
        setSavedDefinition(detail.initialDefinition);
        setUndoStack([]);
        setErrorMessage(null);
        setStatusMessage(null);
        return true;
      }

      const targetPresetId = detail.presetId?.trim();
      if (targetPresetId && applyPresetTemplateById(targetPresetId)) {
        return true;
      }

      return false;
    },
    [
      applyPresetTemplateById,
      loadWorkflowSelection,
      startNewWorkflowDraft,
      workflowClient,
    ]
  );

  const loadWorkspaceData = useCallback(
    async (preserveCurrentSelection = false) => {
      loadingCatalogRef.current = true;
      setLoadingCatalog(true);
      setErrorMessage(null);

      const [definitionsResult, eventsResult, sourcesResult] =
        await Promise.allSettled([
          workflowClient.listDefinitions(100),
          pulseClient.listCapturedEvents(25),
          pulseClient.listSources(),
        ]);

      if (eventsResult.status === 'fulfilled' && eventsResult.value.length > 0) {
        setCapturedEvents(eventsResult.value);
      } else {
        setCapturedEvents([...BUILT_IN_SAMPLE_EVENTS]);
      }

      if (sourcesResult.status === 'fulfilled') {
        setSources(sourcesResult.value);
      }

      const win = window as unknown as WorkflowStudioWindow;
      const pending = win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__;

      if (definitionsResult.status === 'rejected') {
        const reason = definitionsResult.reason;
        setErrorMessage(
          reason instanceof Error ? reason.message : String(reason)
        );
        loadingCatalogRef.current = false;
        setLoadingCatalog(false);
        if (pending) {
          win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = null;
          await handleOpenRequest(pending, [], false);
        }
        return;
      }

      const list = definitionsResult.value;
      definitionsRef.current = list;
      setDefinitions(list);
      loadingCatalogRef.current = false;
      setLoadingCatalog(false);

      if (pending) {
        win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = null;
        const handled = await handleOpenRequest(pending, list, false);
        if (handled) {
          return;
        }
      }

      if (
        !preserveCurrentSelection &&
        !hasUserEditedRef.current &&
        list.length > 0
      ) {
        await loadWorkflowSelection(list[0]);
      }
    },
    [handleOpenRequest, loadWorkflowSelection, pulseClient, workflowClient]
  );

  useEffect(() => {
    void loadWorkspaceData(false);
    return () => {
      if (agentPollTimerRef.current != null) {
        window.clearInterval(agentPollTimerRef.current);
      }
    };
  }, [loadWorkspaceData]);

  useEffect(() => {
    const onOpenWorkflowStudio = (event: Event) => {
      const customEvent = event as CustomEvent<
        WorkflowStudioOpenDetail | undefined
      >;
      const detail = customEvent.detail;
      if (!detail) return;
      const win = window as unknown as WorkflowStudioWindow;
      win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = null;
      if (loadingCatalogRef.current) {
        win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = detail;
        return;
      }
      void handleOpenRequest(detail, definitionsRef.current, true);
    };

    window.addEventListener('vibex:open-workflow-studio', onOpenWorkflowStudio);
    return () => {
      window.removeEventListener(
        'vibex:open-workflow-studio',
        onOpenWorkflowStudio
      );
    };
  }, [handleOpenRequest]);

  const loadExecutionHistory = useCallback(
    async (definitionIdToLoad: string | null) => {
      const [runsResult, deckResult] = await Promise.allSettled([
        definitionIdToLoad
          ? workflowClient.runs(definitionIdToLoad, 20)
          : Promise.resolve([]),
        pulseClient.deckSnapshot(projectId),
      ]);
      if (
        deckResult.status === 'fulfilled' &&
        deckResult.value &&
        Array.isArray(deckResult.value.recentOutbox)
      ) {
        setOutboxEntries(deckResult.value.recentOutbox);
      } else {
        setOutboxEntries([]);
      }
      const nextRuns =
        runsResult.status === 'fulfilled' && Array.isArray(runsResult.value)
          ? runsResult.value
          : [];
      setRuns(nextRuns);
      setSelectedRunId((current) =>
        current && nextRuns.some((item) => item.id === current)
          ? current
          : (nextRuns[0]?.id ?? null)
      );
    },
    [projectId, pulseClient, workflowClient]
  );

  const refreshRunDetails = useCallback(
    async (runId: string) => {
      const [runResult, stepsResult, eventsResult] = await Promise.allSettled([
        workflowClient.show(runId),
        workflowClient.steps(runId),
        workflowClient.events(runId, 0, 500),
      ]);
      if (runResult.status === 'fulfilled' && runResult.value) {
        const fetchedRun = runResult.value;
        setActiveRun(fetchedRun);
        setRuns((current) =>
          current.map((item) => (item.id === runId ? fetchedRun : item))
        );
      }
      if (stepsResult.status === 'fulfilled') {
        setRunSteps(Array.isArray(stepsResult.value) ? stepsResult.value : []);
      }
      if (eventsResult.status === 'fulfilled') {
        setRunEvents(
          Array.isArray(eventsResult.value) ? eventsResult.value : []
        );
      }
    },
    [workflowClient]
  );

  useEffect(() => {
    let cancelled = false;
    setSelectedRunId(null);
    setActiveRun(null);
    setRunSteps([]);
    setRunEvents([]);
    void Promise.allSettled([
      selectedDefinitionId
        ? workflowClient.runs(selectedDefinitionId, 20)
        : Promise.resolve([]),
      pulseClient.deckSnapshot(projectId),
    ]).then(([runsResult, deckResult]) => {
      if (cancelled) return;
      if (
        deckResult.status === 'fulfilled' &&
        deckResult.value &&
        Array.isArray(deckResult.value.recentOutbox)
      ) {
        setOutboxEntries(deckResult.value.recentOutbox);
      } else {
        setOutboxEntries([]);
      }
      const nextRuns =
        runsResult.status === 'fulfilled' && Array.isArray(runsResult.value)
          ? runsResult.value
          : [];
      setRuns(nextRuns);
      setSelectedRunId(nextRuns[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, pulseClient, selectedDefinitionId, workflowClient]);

  const runsRef = useRef(runs);
  runsRef.current = runs;

  useEffect(() => {
    if (!selectedRunId) {
      setActiveRun(null);
      setRunSteps([]);
      setRunEvents([]);
      setRecordsLoading(false);
      return;
    }
    let cancelled = false;
    setRecordsLoading(true);
    void Promise.allSettled([
      workflowClient.show(selectedRunId),
      workflowClient.steps(selectedRunId),
      workflowClient.events(selectedRunId, 0, 500),
    ])
      .then(([runResult, stepsResult, eventsResult]) => {
        if (cancelled) return;
        const matchedSummary =
          runsRef.current.find((item) => item.id === selectedRunId) ?? null;
        if (runResult.status === 'fulfilled' && runResult.value) {
          setActiveRun(runResult.value);
        } else {
          setActiveRun(matchedSummary);
        }
        setRunSteps(
          stepsResult.status === 'fulfilled' && Array.isArray(stepsResult.value)
            ? stepsResult.value
            : []
        );
        setRunEvents(
          eventsResult.status === 'fulfilled' &&
            Array.isArray(eventsResult.value)
            ? eventsResult.value
            : []
        );
      })
      .finally(() => {
        if (!cancelled) setRecordsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, workflowClient]);

  useGuardedWorkflowRunPolling({
    runId: activeRun?.id ?? null,
    status: activeRun?.status ?? null,
    refresh: refreshRunDetails,
  });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    try {
      void Promise.resolve(
        backendListen(PULSE_DECK_CHANGED_EVENT, () => {
          void Promise.allSettled([
            workflowClient.listDefinitions(100),
            pulseClient.listSources(),
            loadExecutionHistory(selectedDefinitionId),
          ]).then(([defsRes, sourcesRes]) => {
            if (cancelled) return;
            if (sourcesRes.status === 'fulfilled') {
              setSources(sourcesRes.value);
            }
            if (defsRes.status === 'fulfilled') {
              const list = defsRes.value;
              definitionsRef.current = list;
              setDefinitions(list);
              if (!dirty && selectedDefinitionId) {
                const updated = list.find(
                  (item) => item.id === selectedDefinitionId
                );
                if (
                  updated?.latestVersionId &&
                  updated.latestVersionId !== (activeVersion?.id ?? null)
                ) {
                  void loadWorkflowSelection(updated);
                }
              }
            }
          });
        })
      )
        .then((dispose) => {
          if (typeof dispose === 'function') {
            if (cancelled) {
              dispose();
            } else {
              unlisten = dispose;
            }
          }
        })
        .catch(() => undefined);
    } catch {
      // Non-fatal in offline/test environments without push listener support
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    activeVersion?.id,
    dirty,
    loadExecutionHistory,
    loadWorkflowSelection,
    pulseClient,
    selectedDefinitionId,
    workflowClient,
  ]);

  const applyDefinitionChange = useCallback((next: StudioWorkflowDefinition) => {
    hasUserEditedRef.current = true;
    setStatusMessage(null);
    setDefinition((current) => {
      if (
        serializeStudioDefinition(current) === serializeStudioDefinition(next)
      ) {
        return current;
      }
      setUndoStack((stack) => [...stack.slice(-39), current]);
      return next;
    });
  }, []);

  const handleUndo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) return stack;
      setDefinition(previous);
      setStatusMessage(null);
      return stack.slice(0, -1);
    });
  }, []);

  const handleOpenPulseDeck = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('vibex:open-pulse-deck', {
        bubbles: true,
        cancelable: true,
      })
    );
  }, []);

  const syncTriggersToPulse = useCallback(
    async (published: WorkflowVersionView) => {
      if (triggerSteps.length === 0) return 0;
      const updatedRuleIds: Record<string, string> = {};
      for (let index = 0; index < triggerSteps.length; index += 1) {
        const trigger = triggerSteps[index]!;
        const existingRuleId =
          savedRuleIds[trigger.id] ?? (index === 0 ? sourceRuleId : null);
        const savedRule = await pulseClient.saveRule({
          id: existingRuleId ?? null,
          enabled: trigger.evalMode !== 'off',
          spec: buildWorkflowTriggerRuleSpec({
            studio: {
              ...definition,
              steps: [
                trigger,
                ...definition.steps.filter((s) => s.id !== trigger.id),
              ],
            },
            workflowId: published.definitionId,
            pinnedVersion: Math.max(1, Number(published.version)),
            projectId,
            enabled: trigger.evalMode !== 'off',
          }),
        });
        updatedRuleIds[trigger.id] = savedRule.id;
      }
      setSavedRuleIds((current) => ({ ...current, ...updatedRuleIds }));
      if (updatedRuleIds[triggerSteps[0]!.id]) {
        setSourceRuleId(updatedRuleIds[triggerSteps[0]!.id]!);
      }
      return triggerSteps.length;
    },
    [definition, projectId, pulseClient, savedRuleIds, sourceRuleId, triggerSteps]
  );

  const persistWorkflow = useCallback(
    async (options: { isPublish: boolean }) => {
      const issues = validateStudioWorkflowExhaustively(definition, t);
      if (issues.length > 0) {
        const summary = t('studio.validationBlockedSave', {
          count: issues.length,
          first: issues[0].message,
        });
        setErrorMessage(summary);
        toast.error(summary);
        return null;
      }

      setErrorMessage(null);
      if (options.isPublish) {
        setPublishing(true);
      } else {
        setSaving(true);
      }

      try {
        const backendDefinition = toBackendWorkflowDefinition(definition);
        await workflowClient.validate(backendDefinition);
        const published = await workflowClient.publish(
          backendDefinition,
          selectedDefinitionId ?? activeVersion?.definitionId ?? undefined
        );
        setActiveVersion(published);
        setSelectedDefinitionId(published.definitionId);
        setSavedDefinition(definition);

        let syncedCount = 0;
        if (triggerSteps.length > 0) {
          syncedCount = await syncTriggersToPulse(published).catch(() => 0);
        }

        const nextList = await workflowClient
          .listDefinitions(100)
          .catch(() => null);
        if (nextList) {
          definitionsRef.current = nextList;
          setDefinitions(nextList);
        }

        const versionLabel = formatReleaseVersion(published.version);
        const savedLabel =
          syncedCount > 0
            ? t('studio.savedWithTriggers', {
                version: versionLabel,
                count: syncedCount,
              })
            : t('studio.savedVersionLabel', {
                version: versionLabel,
              });
        setStatusMessage(savedLabel);
        toast.success(savedLabel);
        return published;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        toast.error(message);
        return null;
      } finally {
        setSaving(false);
        setPublishing(false);
      }
    },
    [
      activeVersion?.definitionId,
      definition,
      selectedDefinitionId,
      syncTriggersToPulse,
      t,
      triggerSteps.length,
      workflowClient,
    ]
  );

  const handleAgentDispatched = useCallback(() => {
    if (agentPollTimerRef.current != null) {
      window.clearInterval(agentPollTimerRef.current);
    }
    const baselineVersionId = activeVersion?.id ?? null;
    const targetId = selectedDefinitionId;
    let ticks = 0;
    agentPollTimerRef.current = window.setInterval(() => {
      ticks += 1;
      void workflowClient
        .listDefinitions(100)
        .then((list) => {
          definitionsRef.current = list;
          setDefinitions(list);
          if (!targetId) return;
          const updated = list.find((item) => item.id === targetId);
          if (
            updated?.latestVersionId &&
            updated.latestVersionId !== baselineVersionId
          ) {
            if (agentPollTimerRef.current != null) {
              window.clearInterval(agentPollTimerRef.current);
              agentPollTimerRef.current = null;
            }
            void loadWorkflowSelection(updated);
          }
        })
        .catch(() => undefined);
      if (ticks >= 15 && agentPollTimerRef.current != null) {
        window.clearInterval(agentPollTimerRef.current);
        agentPollTimerRef.current = null;
      }
    }, 4000);
  }, [activeVersion?.id, loadWorkflowSelection, selectedDefinitionId, workflowClient]);

  const loadAgentSessionControls = useCallback(
    (agentId: string) => loadAgentSessionControlsCatalog(agentId),
    []
  );

  const [testSteps, setTestSteps] = useState<WorkflowStepView[]>([]);
  useEffect(() => {
    setTestSteps([]);
  }, [selectedDefinitionId]);

  const handleTestNode = useCallback(
    async (stepId: string) => {
      const target = definition.steps.find((item) => item.id === stepId);
      if (
        !target ||
        (target.kind !== 'session' && target.kind !== 'agent')
      ) {
        return;
      }
      try {
        let resolvedProjectId = projectId?.trim() || '';
        if (!resolvedProjectId) {
          const projects = await projectsApi.getAll();
          resolvedProjectId = projects[0]?.id ?? '';
        }
        if (!resolvedProjectId) {
          toast.error(t('studio.needWorkspaceToTest'));
          return;
        }
        const executor = (target.agentId || defaultAgentId || 'claude-code')
          .trim()
          .toUpperCase()
          .replace(/-/g, '_');
        const created = await sessionsApi.createProject({
          project_id: resolvedProjectId,
          workspace_id: null,
          executor,
          name: `${definition.name} · ${stepId}`.slice(0, 60),
          initial_prompt: target.prompt,
        });
        const now = new Date().toISOString();
        const view: WorkflowStepView = {
          id: `test-${stepId}-${Date.now()}`,
          runId: `test-run-${selectedDefinitionId ?? 'draft'}`,
          stepId,
          attempt: 1n,
          status: 'running',
          conversationId: created.id,
          turnId: null,
          outputJson: null,
          outputSchemaDigest: null,
          candidateOutputJson: null,
          candidateSchemaDigest: null,
          awaitingAcceptance: false,
          awaitingInput: false,
          executionMode: 'debug',
          resolvedInputJson: null,
          resolvedInputDigest: null,
          executionEvidenceJson: null,
          workspaceId: created.workspace_id,
          waitingInteraction: false,
          repairCount: 0n,
          claimToken: null,
          claimDeadline: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        setTestSteps((current) => [
          ...current.filter((item) => item.stepId !== stepId),
          view,
        ]);
        toast.success(t('studio.debugStarted', { step: stepId }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [defaultAgentId, definition.name, definition.steps, projectId, selectedDefinitionId, t]
  );

  const mergedSteps = useMemo(() => {
    if (testSteps.length === 0) return runSteps;
    const testedStepIds = new Set(testSteps.map((item) => item.stepId));
    return [
      ...runSteps.filter((item) => !testedStepIds.has(item.stepId)),
      ...testSteps,
    ];
  }, [runSteps, testSteps]);

  const handleDecideApproval = useCallback(
    async (stepId: string, decision: JsonValue) => {
      if (!selectedRunId) return;
      try {
        await workflowClient.decide(selectedRunId, stepId, decision);
        await refreshRunDetails(selectedRunId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshRunDetails, selectedRunId, workflowClient]
  );

  const handleAcceptCandidate = useCallback(
    async (stepId: string) => {
      if (!selectedRunId) return;
      try {
        await workflowClient.acceptCandidate(selectedRunId, stepId);
        await refreshRunDetails(selectedRunId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshRunDetails, selectedRunId, workflowClient]
  );

  const handlePauseStep = useCallback(
    async (stepId: string) => {
      if (!selectedRunId) return;
      try {
        await workflowClient.pauseStep(selectedRunId, stepId);
        await refreshRunDetails(selectedRunId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshRunDetails, selectedRunId, workflowClient]
  );

  const handleSubmitStepInput = useCallback(
    async (stepId: string, text: string) => {
      if (!selectedRunId) return;
      try {
        await workflowClient.submitStepInput(selectedRunId, stepId, text);
        await refreshRunDetails(selectedRunId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshRunDetails, selectedRunId, workflowClient]
  );

  const workflowSelectOptions = useMemo<AstryxSelectOption[]>(() => {
    const base: AstryxSelectOption[] = [];
    if (selectedDefinitionId == null) {
      base.push({
        value: '__draft__',
        label: t('studio.unsavedDraftOption', { name: definition.name }),
      });
    }
    for (const item of definitions) {
      base.push({
        value: item.id,
        label: item.name,
      });
    }
    return base;
  }, [definition.name, definitions, selectedDefinitionId, t]);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-testid="workflow-studio-dock-panel"
    >
      {!embedded ? (
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--surface-panel)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <AstryxSelect
              ariaLabel={t('studio.selectWorkflow')}
              value={selectedDefinitionId ?? '__draft__'}
              options={workflowSelectOptions}
              disabled={loadingCatalog || loadingWorkflow}
              size="compact"
              className="w-[210px] max-w-[240px]"
              onChange={(nextId) => {
                if (nextId === '__draft__') return;
                const match = definitions.find((item) => item.id === nextId);
                if (match) {
                  hasUserEditedRef.current = true;
                  void loadWorkflowSelection(match);
                }
              }}
            />

            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              data-testid="workflow-studio-open-pulse-deck"
              title={t('studio.openPulseDeckTooltip')}
              onClick={handleOpenPulseDeck}
            >
              <Activity className="mr-1 size-3.5" />
              {t('studio.openPulseDeck')}
            </Button>

            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={loadingCatalog || loadingWorkflow}
              onClick={() => void loadWorkspaceData(true)}
              title={t('studio.refreshCatalog')}
              aria-label={t('studio.refreshCatalog')}
            >
              <RefreshCw
                className={`size-3.5 ${loadingCatalog || loadingWorkflow ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>

          <div className="flex shrink-0 items-center gap-2 text-[11px]">
            {loadingCatalog || loadingWorkflow ? (
              <span
                role="status"
                className="inline-flex items-center gap-1 text-muted-foreground"
              >
                <Loader2 className="size-3 animate-spin" />
                {t('studio.loadingWorkspace')}
              </span>
            ) : statusMessage && !dirty ? (
              <span
                data-testid="workflow-studio-save-status"
                className="inline-flex items-center gap-1 text-success tabular-nums"
              >
                <CheckCircle2 className="size-3.5" />
                {statusMessage}
              </span>
            ) : dirty ? (
              <span
                data-testid="workflow-studio-save-status"
                className="text-warning"
              >
                {t('studio.unsavedChanges')}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="truncate">{errorMessage}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => void loadWorkspaceData(true)}
          >
            {t('studio.retryLoad')}
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <WorkflowStudio
          studioMode
          className="h-full min-h-0"
          definition={definition}
          onDefinitionChange={applyDefinitionChange}
          run={activeRun}
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRunId={setSelectedRunId}
          recordsLoading={recordsLoading}
          steps={mergedSteps}
          events={runEvents}
          outboxEntries={outboxEntries}
          onTestNode={(stepId) => void handleTestNode(stepId)}
          onAcceptCandidate={(stepId) => void handleAcceptCandidate(stepId)}
          onPauseStep={(stepId) => void handlePauseStep(stepId)}
          onSubmitStepInput={handleSubmitStepInput}
          onDecideApproval={handleDecideApproval}
          onBack={props?.onBack}
          editorName={definition.name}
          onEditorNameChange={(nextName) =>
            applyDefinitionChange({ ...definition, name: nextName })
          }
          taskCatalog={definitions}
          selectedDefinitionId={selectedDefinitionId}
          onSelectTask={(nextId) => {
            const match = definitions.find((item) => item.id === nextId);
            if (match) {
              hasUserEditedRef.current = true;
              void loadWorkflowSelection(match);
            }
          }}
          onCreateNewTask={startNewWorkflowDraft}
          rightToolbarSlot={props?.rightToolbarSlot}
          dirty={dirty}
          saving={saving}
          publishing={publishing}
          onSave={() => void persistWorkflow({ isPublish: false })}
          onPublish={() => void persistWorkflow({ isPublish: true })}
          releaseVersion={formatReleaseVersion(activeVersion?.version)}
          canUndo={undoStack.length > 0}
          onUndo={handleUndo}
          agentOptions={agentOptions}
          bots={bots}
          spaces={spaces}
          sources={sources}
          projectId={projectId}
          definitionId={selectedDefinitionId}
          sourceRuleId={sourceRuleId}
          onAgentDispatched={handleAgentDispatched}
          loadAgentSessionControls={loadAgentSessionControls}
          capturedEvents={capturedEvents}
        />
      </div>
    </div>
  );
}

export default WorkflowStudioDockPanel;
