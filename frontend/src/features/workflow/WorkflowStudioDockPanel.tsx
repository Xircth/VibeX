import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  WorkflowDefinition,
  WorkflowDefinitionSummary,
  WorkflowVersionView,
} from 'shared/types';

import { buildWorkflowTriggerRuleSpec } from '@/components/kanban/automation/automationAgentBridge';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useManagedAgentOptions } from '@/features/agent-management';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
import { BUILT_IN_SAMPLE_EVENTS } from '@/features/pulse';
import {
  createPulseApi,
  pulseApi,
  type EventEnvelope,
  type PulseSourceView,
} from '@/lib/api/pulse';
import {
  configuredBackendTransport,
  useBackendTransport,
} from '@/lib/transport';

import { useCollaborationBotRoster } from './useCollaborationBotRoster';
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
};

type WorkflowStudioWindow = Window & {
  __VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__?: WorkflowStudioOpenDetail | null;
};

export type WorkflowStudioDockPanelProps = Partial<IDockviewPanelProps> & {
  embedded?: boolean;
  projectId?: string | null;
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

  const handleOpenRequest = useCallback(
    async (
      detail: WorkflowStudioOpenDetail | null | undefined,
      availableDefinitions: WorkflowDefinitionSummary[],
      allowCatalogRefresh = false
    ): Promise<boolean> => {
      if (!detail) return false;
      setSourceRuleId(detail.sourceRuleId ?? null);

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
    [applyPresetTemplateById, loadWorkflowSelection, workflowClient]
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
        if (pending !== undefined) {
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

      if (pending !== undefined) {
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

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-testid="workflow-studio-dock-panel"
    >
      {!embedded ? (
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--surface-panel)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <select
              aria-label={t('studio.selectWorkflow')}
              value={selectedDefinitionId ?? '__draft__'}
              disabled={loadingCatalog || loadingWorkflow}
              onChange={(event) => {
                const nextId = event.target.value;
                if (nextId === '__draft__') return;
                const match = definitions.find((item) => item.id === nextId);
                if (match) {
                  hasUserEditedRef.current = true;
                  void loadWorkflowSelection(match);
                }
              }}
              className="raised-control h-7 max-w-[220px] truncate rounded-md border border-border bg-[var(--surface-control)] px-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {selectedDefinitionId == null ? (
                <option value="__draft__">
                  {t('studio.unsavedDraftOption', { name: definition.name })}
                </option>
              ) : null}
              {definitions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>

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

      <div className="min-h-0 flex-1">
        <WorkflowStudio
          studioMode
          className="h-full min-h-0"
          definition={definition}
          onDefinitionChange={applyDefinitionChange}
          editorName={definition.name}
          onEditorNameChange={(nextName) =>
            applyDefinitionChange({ ...definition, name: nextName })
          }
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
