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
import { attemptsApi } from '@/lib/api/attempts';
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
import {
  CANONICAL_UNNAMED_WORKFLOW_PATH,
  isUnnamedWorkflowName,
  publishCanvasFocus,
  sourcePathForWorkflowName,
  writeWorkflowSourceFile,
} from './canvasDraft';
import { UnnamedTaskNameDialog } from './UnnamedTaskNameDialog';
import { resolveWorkflowAgentId } from './workflowAgent';
import { createWorkflowApi, workflowsApi } from './workflowApi';
import { createWorkflowSourceApi } from './workflowSourceApi';

type StudioTriggerStep = Extract<StudioWorkflowStep, { kind: 'trigger' }>;

type UnnamedTaskPrompt =
  | { intent: 'leave' }
  | { intent: 'create' }
  | { intent: 'switch'; definitionId: string }
  | { intent: 'save'; isPublish: boolean };

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

async function readWorkflowSourceDocument(
  api: ReturnType<typeof createWorkflowSourceApi>,
  path: string
): Promise<{ definition: WorkflowDefinition; revision: string } | null> {
  try {
    const existing = await api.read(path);
    if (
      !existing ||
      typeof existing.content !== 'string' ||
      !existing.content.trim()
    ) {
      return null;
    }
    return {
      definition: JSON.parse(existing.content) as WorkflowDefinition,
      revision: existing.revision,
    };
  } catch {
    return null;
  }
}

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
  const sourceApi = useMemo(
    () => createWorkflowSourceApi(transport),
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
  const [redoStack, setRedoStack] = useState<StudioWorkflowDefinition[]>([]);
  const [fullTesting, setFullTesting] = useState(false);
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
  const [sourcePath, setSourcePath] = useState(CANONICAL_UNNAMED_WORKFLOW_PATH);
  const [namePrompt, setNamePrompt] = useState<UnnamedTaskPrompt | null>(null);
  const [promptName, setPromptName] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);

  const hasUserEditedRef = useRef(false);
  const sourceRevisionRef = useRef<string | null>(null);
  const applyingRemoteRef = useRef(false);
  const bindingSourceRef = useRef(false);
  const openSequenceRef = useRef(0);
  const definitionsRef = useRef<WorkflowDefinitionSummary[]>([]);
  const loadingCatalogRef = useRef(true);
  const agentPollTimerRef = useRef<number | null>(null);
  const defaultAgentIdRef = useRef(defaultAgentId);
  defaultAgentIdRef.current = defaultAgentId;
  const tRef = useRef(t);
  tRef.current = t;

  const dirty = useMemo(
    () =>
      serializeStudioDefinition(definition) !==
      serializeStudioDefinition(savedDefinition),
    [definition, savedDefinition]
  );
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const sourcePathRef = useRef(sourcePath);
  sourcePathRef.current = sourcePath;

  const focusViewedWorkflow = useCallback(
    (path: string, name: string, definitionId: string | null) => {
      void publishCanvasFocus(transport, {
        path,
        name,
        definitionId,
        viewing: true,
      }).catch(() => undefined);
    },
    [transport]
  );

  const writeCanvasSource = useCallback(
    async (
      next: StudioWorkflowDefinition,
      definitionId: string | null,
      targetPath: string
    ) => {
      const requestId = ++openSequenceRef.current;
      bindingSourceRef.current = true;
      setSourcePath(targetPath);
      sourceRevisionRef.current = null;
      try {
        const revision = await writeWorkflowSourceFile(
          sourceApi,
          targetPath,
          toBackendWorkflowDefinition(next),
          null
        );
        if (openSequenceRef.current === requestId) {
          sourceRevisionRef.current = revision;
        }
      } catch {
        if (openSequenceRef.current === requestId) {
          sourceRevisionRef.current = null;
        }
      } finally {
        if (openSequenceRef.current === requestId) {
          bindingSourceRef.current = false;
          focusViewedWorkflow(targetPath, next.name, definitionId);
        }
      }
    },
    [focusViewedWorkflow, sourceApi]
  );

  const bindCanvasSource = useCallback(
    async (
      next: StudioWorkflowDefinition,
      definitionId: string | null,
      preferredPath?: string | null
    ) => {
      const trimmedPreferred = preferredPath?.trim() || null;
      const safePreferred =
        !isUnnamedWorkflowName(next.name) &&
        trimmedPreferred === CANONICAL_UNNAMED_WORKFLOW_PATH
          ? null
          : trimmedPreferred;
      const path = safePreferred || sourcePathForWorkflowName(next.name);
      const requestId = ++openSequenceRef.current;
      bindingSourceRef.current = true;
      setSourcePath(path);
      sourceRevisionRef.current = null;
      try {
        if (!isUnnamedWorkflowName(next.name)) {
          const existing = await readWorkflowSourceDocument(sourceApi, path);
          if (openSequenceRef.current !== requestId) return;
          if (existing) {
            const fromFile = toStudioWorkflowDefinition(existing.definition);
            const hydrated: StudioWorkflowDefinition = {
              ...fromFile,
              name: next.name || fromFile.name,
              orchestratorPreset:
                fromFile.orchestratorPreset ?? next.orchestratorPreset ?? null,
            };
            setDefinition(hydrated);
            setSavedDefinition(hydrated);
            setUndoStack([]);
            setRedoStack([]);
            setSourcePath(path);
            sourceRevisionRef.current = existing.revision;
            focusViewedWorkflow(path, hydrated.name, definitionId);
            return;
          }
        }
        try {
          const revision = await writeWorkflowSourceFile(
            sourceApi,
            path,
            toBackendWorkflowDefinition(next),
            null
          );
          if (openSequenceRef.current === requestId) {
            sourceRevisionRef.current = revision;
          }
        } catch {
          if (openSequenceRef.current === requestId) {
            sourceRevisionRef.current = null;
          }
        }
        if (openSequenceRef.current === requestId) {
          setSourcePath(path);
          focusViewedWorkflow(path, next.name, definitionId);
        }
      } finally {
        if (openSequenceRef.current === requestId) {
          bindingSourceRef.current = false;
        }
      }
    },
    [focusViewedWorkflow, sourceApi]
  );

  const refreshUnnamedDraftFile = useCallback(async () => {
    const starter = createStarterWorkflow(
      defaultAgentIdRef.current,
      tRef.current
    );
    try {
      await writeWorkflowSourceFile(
        sourceApi,
        CANONICAL_UNNAMED_WORKFLOW_PATH,
        toBackendWorkflowDefinition(starter),
        null
      );
    } catch {
      // The in-memory starter still opens when the source directory is unavailable.
    }
    return starter;
  }, [sourceApi]);

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
            setRedoStack([]);
            await bindCanvasSource(hydrated, summary.id);
            return;
          } catch {
            // fall through to starter
          }
        }
        const fresh = {
          ...createStarterWorkflow(defaultAgentIdRef.current, tRef.current),
          name: summary.name,
        };
        setActiveVersion(null);
        setDefinition(fresh);
        setSavedDefinition(fresh);
        setUndoStack([]);
        setRedoStack([]);
        await bindCanvasSource(fresh, summary.id);
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
        setRedoStack([]);
        await bindCanvasSource(
          nextDefinition,
          summary.id,
          versionView.sourcePath
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
      } finally {
        setLoadingWorkflow(false);
      }
    },
    [bindCanvasSource, workflowClient]
  );

  const applyPresetTemplateById = useCallback(
    (presetId: string): boolean => {
      const template = getWorkflowPresetTemplates(tRef.current).find(
        (item) => item.id === presetId
      );
      if (!template) return false;
      hasUserEditedRef.current = true;
      const nextDefinition = template.build(defaultAgentIdRef.current);
      setSelectedDefinitionId(null);
      setSourceRuleId(null);
      setActiveVersion(null);
      setSavedRuleIds({});
      setDefinition(nextDefinition);
      setSavedDefinition(nextDefinition);
      setUndoStack([]);
      setRedoStack([]);
      setErrorMessage(null);
      setStatusMessage(null);
      void writeCanvasSource(
        nextDefinition,
        null,
        sourcePathForWorkflowName(nextDefinition.name)
      );
      return true;
    },
    [writeCanvasSource]
  );

  const startNewWorkflowDraft = useCallback(async () => {
    openSequenceRef.current += 1;
    bindingSourceRef.current = false;
    hasUserEditedRef.current = true;
    const fresh = await refreshUnnamedDraftFile();
    setSelectedDefinitionId(null);
    setSourceRuleId(null);
    setActiveVersion(null);
    setSavedRuleIds({});
    setDefinition(fresh);
    setSavedDefinition(fresh);
    setUndoStack([]);
    setRedoStack([]);
    setErrorMessage(null);
    setStatusMessage(null);
    setSourcePath(CANONICAL_UNNAMED_WORKFLOW_PATH);
    sourceRevisionRef.current = null;
    focusViewedWorkflow(CANONICAL_UNNAMED_WORKFLOW_PATH, fresh.name, null);
  }, [focusViewedWorkflow, refreshUnnamedDraftFile]);

  const handleOpenRequest = useCallback(
    async (
      detail: WorkflowStudioOpenDetail | null | undefined,
      availableDefinitions: WorkflowDefinitionSummary[],
      allowCatalogRefresh = false
    ): Promise<boolean> => {
      if (!detail) return false;
      setSourceRuleId(detail.sourceRuleId ?? null);

      if (detail.createNew) {
        await startNewWorkflowDraft();
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
        const initialDef = detail.initialDefinition;
        hasUserEditedRef.current = true;
        setSelectedDefinitionId(targetDefinitionId || null);
        setActiveVersion(null);
        setSavedRuleIds({});
        setDefinition(initialDef);
        setSavedDefinition(initialDef);
        setUndoStack([]);
        setRedoStack([]);
        setErrorMessage(null);
        setStatusMessage(null);
        await writeCanvasSource(
          initialDef,
          targetDefinitionId || null,
          sourcePathForWorkflowName(initialDef.name)
        );
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
      writeCanvasSource,
    ]
  );

  const loadWorkspaceData = useCallback(
    async (preserveCurrentSelection = false) => {
      loadingCatalogRef.current = true;
      setLoadingCatalog(true);
      setErrorMessage(null);
      const win = window as unknown as WorkflowStudioWindow;
      const pendingAtStart = win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__;
      if (
        !preserveCurrentSelection &&
        (!pendingAtStart || pendingAtStart.createNew)
      ) {
        await refreshUnnamedDraftFile();
      }

      const [definitionsResult, eventsResult, sourcesResult] =
        await Promise.allSettled([
          workflowClient.listDefinitions(100),
          pulseClient.listCapturedEvents(25),
          pulseClient.listSources(),
        ]);

      if (
        eventsResult.status === 'fulfilled' &&
        eventsResult.value.length > 0
      ) {
        setCapturedEvents(eventsResult.value);
      } else {
        setCapturedEvents([...BUILT_IN_SAMPLE_EVENTS]);
      }

      if (sourcesResult.status === 'fulfilled') {
        setSources(sourcesResult.value);
      }

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
    [
      handleOpenRequest,
      loadWorkflowSelection,
      pulseClient,
      refreshUnnamedDraftFile,
      workflowClient,
    ]
  );

  useEffect(() => {
    void loadWorkspaceData(false);
    return () => {
      if (agentPollTimerRef.current != null) {
        window.clearInterval(agentPollTimerRef.current);
      }
      void publishCanvasFocus(transport, { viewing: false }).catch(
        () => undefined
      );
    };
  }, [loadWorkspaceData, transport]);

  useEffect(() => {
    if (applyingRemoteRef.current || bindingSourceRef.current) return;
    const path = sourcePath;
    const handle = window.setTimeout(() => {
      if (bindingSourceRef.current || sourcePathRef.current !== path) return;
      const current = definitionRef.current;
      void (async () => {
        const existing = await readWorkflowSourceDocument(sourceApi, path);
        if (
          existing &&
          existing.revision !== sourceRevisionRef.current &&
          !dirtyRef.current
        ) {
          return;
        }
        const revision = await writeWorkflowSourceFile(
          sourceApi,
          path,
          toBackendWorkflowDefinition(current),
          sourceRevisionRef.current
        );
        if (sourcePathRef.current === path) {
          sourceRevisionRef.current = revision;
          focusViewedWorkflow(path, current.name, selectedDefinitionId);
        }
      })().catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(handle);
  }, [
    definition,
    focusViewedWorkflow,
    selectedDefinitionId,
    sourceApi,
    sourcePath,
  ]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (bindingSourceRef.current) return;
      const path = sourcePathRef.current;
      void readWorkflowSourceDocument(sourceApi, path).then((existing) => {
        if (cancelled || !existing) return;
        if (bindingSourceRef.current || sourcePathRef.current !== path) return;
        if (existing.revision === sourceRevisionRef.current) return;
        if (dirtyRef.current) return;
        applyingRemoteRef.current = true;
        const hydrated = toStudioWorkflowDefinition(existing.definition);
        setDefinition(hydrated);
        setSavedDefinition(hydrated);
        setUndoStack([]);
        setRedoStack([]);
        sourceRevisionRef.current = existing.revision;
        window.setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 0);
      });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sourceApi]);

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

  const applyDefinitionChange = useCallback(
    (next: StudioWorkflowDefinition) => {
      hasUserEditedRef.current = true;
      setStatusMessage(null);
      setDefinition((current) => {
        if (
          serializeStudioDefinition(current) === serializeStudioDefinition(next)
        ) {
          return current;
        }
        setUndoStack((stack) => [...stack.slice(-39), current]);
        setRedoStack([]);
        return next;
      });
    },
    []
  );

  const handleUndo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) return stack;
      setDefinition((current) => {
        setRedoStack((redo) => [...redo.slice(-39), current]);
        return previous;
      });
      setStatusMessage(null);
      return stack.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((stack) => {
      const next = stack.at(-1);
      if (!next) return stack;
      setDefinition((current) => {
        setUndoStack((undo) => [...undo.slice(-39), current]);
        return next;
      });
      setStatusMessage(null);
      return stack.slice(0, -1);
    });
  }, []);

  const handleFullTest = useCallback(async () => {
    const issues = validateStudioWorkflowExhaustively(definition, t);
    if (issues.length > 0) {
      const summary = t('studio.validationBlockedSave', {
        count: issues.length,
        first: issues[0].message,
      });
      setErrorMessage(summary);
      toast.error(summary);
      return;
    }
    const executableIds = new Set(
      definition.steps
        .filter((step) => step.kind === 'session' || step.kind === 'agent')
        .map((step) => step.id)
    );
    const entry = definition.steps.find(
      (step) =>
        executableIds.has(step.id) &&
        !step.dependsOn.some((dependency) => executableIds.has(dependency))
    );
    if (!entry) {
      toast.error(t('studio.fullTestNeedsStep'));
      return;
    }
    setFullTesting(true);
    setErrorMessage(null);
    try {
      const backendDefinition = toBackendWorkflowDefinition(definition);
      await workflowClient.validate(backendDefinition);
      let workspaceId: string | undefined;
      if (projectId) {
        const projectWorkspaces = await attemptsApi
          .getProjectWorkspaces(projectId)
          .catch(() => []);
        workspaceId = projectWorkspaces[0]?.id;
      }
      if (!workspaceId) {
        const workspaces = await attemptsApi.getAllWorkspaces().catch(() => []);
        workspaceId = workspaces[0]?.id;
      }
      if (!workspaceId) {
        toast.error(t('studio.fullTestNeedsWorkspace'));
        return;
      }
      const run = await workflowClient.debug(backendDefinition, entry.id, {
        definitionId: selectedDefinitionId ?? undefined,
        workspaceId,
        input: {},
        scope: 'downstream',
      });
      setSelectedRunId(run.id);
      setRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      await refreshRunDetails(run.id);
      toast.success(t('studio.fullTestStarted'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setFullTesting(false);
    }
  }, [
    definition,
    projectId,
    refreshRunDetails,
    selectedDefinitionId,
    t,
    workflowClient,
  ]);

  const handleOpenPulseDeck = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('vibex:open-pulse-deck', {
        bubbles: true,
        cancelable: true,
      })
    );
  }, []);

  const syncTriggersToPulse = useCallback(
    async (
      published: WorkflowVersionView,
      studio: StudioWorkflowDefinition
    ) => {
      const triggers = studio.steps.filter(
        (step): step is StudioTriggerStep => step.kind === 'trigger'
      );
      if (triggers.length === 0) return 0;
      const updatedRuleIds: Record<string, string> = {};
      for (let index = 0; index < triggers.length; index += 1) {
        const trigger = triggers[index]!;
        const existingRuleId =
          savedRuleIds[trigger.id] ?? (index === 0 ? sourceRuleId : null);
        const savedRule = await pulseClient.saveRule({
          id: existingRuleId ?? null,
          enabled: trigger.evalMode !== 'off',
          spec: buildWorkflowTriggerRuleSpec({
            studio: {
              ...studio,
              steps: [
                trigger,
                ...studio.steps.filter((s) => s.id !== trigger.id),
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
      if (updatedRuleIds[triggers[0]!.id]) {
        setSourceRuleId(updatedRuleIds[triggers[0]!.id]!);
      }
      return triggers.length;
    },
    [projectId, pulseClient, savedRuleIds, sourceRuleId]
  );

  const persistWorkflow = useCallback(
    async (options: {
      isPublish: boolean;
      nextDefinition?: StudioWorkflowDefinition;
    }) => {
      const target = options.nextDefinition ?? definition;
      const issues = validateStudioWorkflowExhaustively(target, t);
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
        const backendDefinition = toBackendWorkflowDefinition(target);
        const persistedPath = sourcePathForWorkflowName(target.name);
        try {
          const revision = await writeWorkflowSourceFile(
            sourceApi,
            persistedPath,
            backendDefinition,
            sourcePathRef.current === persistedPath
              ? sourceRevisionRef.current
              : null
          );
          setSourcePath(persistedPath);
          sourceRevisionRef.current = revision;
          focusViewedWorkflow(persistedPath, target.name, selectedDefinitionId);
        } catch {
          // Publishing still records the definition when the source file is unavailable.
        }
        await workflowClient.validate(backendDefinition);
        const published = await workflowClient.publish(
          backendDefinition,
          selectedDefinitionId ?? activeVersion?.definitionId ?? undefined,
          undefined,
          persistedPath
        );
        setActiveVersion(published);
        setSelectedDefinitionId(published.definitionId);
        setSavedDefinition(target);

        let syncedCount = 0;
        if (target.steps.some((step) => step.kind === 'trigger')) {
          syncedCount = await syncTriggersToPulse(published, target).catch(
            () => 0
          );
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
      focusViewedWorkflow,
      selectedDefinitionId,
      sourceApi,
      syncTriggersToPulse,
      t,
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
  }, [
    activeVersion?.id,
    loadWorkflowSelection,
    selectedDefinitionId,
    workflowClient,
  ]);

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
      if (!target || (target.kind !== 'session' && target.kind !== 'agent')) {
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
    [
      defaultAgentId,
      definition.name,
      definition.steps,
      projectId,
      selectedDefinitionId,
      t,
    ]
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

  const openNamePrompt = (prompt: UnnamedTaskPrompt) => {
    setPromptName('');
    setPromptError(null);
    setNamePrompt(prompt);
  };

  const editedUnnamedTask = () =>
    isUnnamedWorkflowName(definitionRef.current.name) && dirtyRef.current;

  const discardUnnamedEdits = async () => {
    await refreshUnnamedDraftFile();
    setSourcePath(CANONICAL_UNNAMED_WORKFLOW_PATH);
    sourceRevisionRef.current = null;
  };

  const continueNamePrompt = async (prompt: UnnamedTaskPrompt) => {
    if (prompt.intent === 'leave') {
      props?.onBack?.();
      return;
    }
    if (prompt.intent === 'create') {
      await startNewWorkflowDraft();
      return;
    }
    if (prompt.intent === 'switch') {
      const match = definitionsRef.current.find(
        (item) => item.id === prompt.definitionId
      );
      if (match) {
        hasUserEditedRef.current = true;
        await loadWorkflowSelection(match);
      }
    }
  };

  const handleDiscardUnnamed = () => {
    const prompt = namePrompt;
    setNamePrompt(null);
    if (!prompt || prompt.intent === 'save') return;
    void discardUnnamedEdits().finally(() => {
      void continueNamePrompt(prompt);
    });
  };

  const handleRenameUnnamed = () => {
    const nextName = promptName.trim();
    if (!nextName || isUnnamedWorkflowName(nextName)) {
      setPromptError(t('studio.unnamedNameRequired'));
      return;
    }
    const prompt = namePrompt;
    const named: StudioWorkflowDefinition = {
      ...definitionRef.current,
      name: nextName,
    };
    setNamePrompt(null);
    setPromptError(null);
    setDefinition(named);
    setSavedDefinition(named);
    setUndoStack([]);
    setRedoStack([]);
    const path = sourcePathForWorkflowName(nextName);
    void (async () => {
      try {
        const revision = await writeWorkflowSourceFile(
          sourceApi,
          path,
          toBackendWorkflowDefinition(named),
          null
        );
        setSourcePath(path);
        sourceRevisionRef.current = revision;
        focusViewedWorkflow(path, nextName, selectedDefinitionId);
        await refreshUnnamedDraftFile();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        toast.error(message);
      }
      if (prompt?.intent === 'save') {
        await persistWorkflow({
          isPublish: prompt.isPublish,
          nextDefinition: named,
        });
      }
    })();
  };

  const requestLeaveCanvas = () => {
    if (editedUnnamedTask()) {
      openNamePrompt({ intent: 'leave' });
      return;
    }
    props?.onBack?.();
  };

  const requestPersistWorkflow = (isPublish: boolean) => {
    if (editedUnnamedTask()) {
      openNamePrompt({ intent: 'save', isPublish });
      return;
    }
    void persistWorkflow({ isPublish });
  };

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
          onBack={props?.onBack ? requestLeaveCanvas : undefined}
          editorName={definition.name}
          onEditorNameChange={(nextName) =>
            applyDefinitionChange({ ...definition, name: nextName })
          }
          taskCatalog={definitions}
          selectedDefinitionId={selectedDefinitionId}
          onSelectTask={(nextId) => {
            if (editedUnnamedTask()) {
              openNamePrompt({ intent: 'switch', definitionId: nextId });
              return;
            }
            const match = definitions.find((item) => item.id === nextId);
            if (match) {
              hasUserEditedRef.current = true;
              void loadWorkflowSelection(match);
            }
          }}
          onCreateNewTask={() => {
            if (editedUnnamedTask()) {
              openNamePrompt({ intent: 'create' });
              return;
            }
            void startNewWorkflowDraft();
          }}
          rightToolbarSlot={props?.rightToolbarSlot}
          dirty={dirty}
          saving={saving}
          publishing={publishing}
          onSave={() => requestPersistWorkflow(false)}
          onPublish={() => requestPersistWorkflow(true)}
          onFullTest={() => void handleFullTest()}
          fullTesting={fullTesting}
          releaseVersion={formatReleaseVersion(activeVersion?.version)}
          canUndo={undoStack.length > 0}
          onUndo={handleUndo}
          canRedo={redoStack.length > 0}
          onRedo={handleRedo}
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
        <UnnamedTaskNameDialog
          open={namePrompt !== null}
          name={promptName}
          error={promptError}
          showDiscard={namePrompt?.intent !== 'save'}
          onNameChange={(next) => {
            setPromptName(next);
            if (promptError) setPromptError(null);
          }}
          onDiscard={handleDiscardUnnamed}
          onRename={handleRenameUnnamed}
          onCancel={() => setNamePrompt(null)}
        />
      </div>
    </div>
  );
}

export default WorkflowStudioDockPanel;
