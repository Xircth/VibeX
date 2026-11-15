import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
} from 'lucide-react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useTranslation } from 'react-i18next';
import type {
  WorkflowDefinition,
  WorkflowDefinitionSummary,
  WorkflowVersionView,
} from 'shared/types';

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
  type PulseRuleSpec,
} from '@/lib/api/pulse';
import {
  configuredBackendTransport,
  useBackendTransport,
} from '@/lib/transport';

import {
  WORKFLOW_PRESET_TEMPLATES,
  WorkflowStudio,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
  validateStudioWorkflowExhaustively,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
} from './WorkflowStudio';
import { resolveWorkflowAgentId } from './workflowAgent';
import { createWorkflowApi, workflowsApi } from './workflowApi';

type StudioTriggerStep = Extract<StudioWorkflowStep, { kind: 'trigger' }>;

function serializeStudioDefinition(definition: StudioWorkflowDefinition): string {
  return JSON.stringify(definition, (_key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  );
}

function formatReleaseVersion(version: bigint | number | null | undefined): string {
  if (version == null) return '0.1';
  const numeric = typeof version === 'bigint' ? Number(version) : version;
  return (Math.max(1, numeric) / 10).toFixed(1);
}

function createStarterWorkflow(defaultAgentId: string): StudioWorkflowDefinition {
  const preset = WORKFLOW_PRESET_TEMPLATES[0].build(defaultAgentId);
  return {
    ...preset,
    name: 'New Workflow',
    orchestratorPreset: preset.orchestratorPreset ?? 'direct_reflex',
  };
}

function buildTriggerRuleSpec(
  definition: StudioWorkflowDefinition,
  trigger: StudioTriggerStep,
  published: WorkflowVersionView
): PulseRuleSpec {
  const pinnedVersion = Math.max(1, Number(published.version));
  return {
    name: trigger.title.trim() || `${definition.name} (${trigger.id})`,
    description: definition.description,
    evalMode: trigger.evalMode,
    orchestrator: definition.orchestratorPreset ?? undefined,
    filter: trigger.filter,
    temporal: trigger.temporal,
    targets: [
      {
        kind: 'workflow',
        workflowId: published.definitionId,
        pinnedVersion,
        inputMapping: {},
      },
    ],
  };
}

export function WorkflowStudioDockPanel(_props?: Partial<IDockviewPanelProps>) {
  const { t } = useTranslation('workflow');
  const transport = useBackendTransport();
  const { config } = useOptionalUserSystem() ?? {};
  const agentOptions = useManagedAgentOptions(undefined, true);
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

  const [definitions, setDefinitions] = useState<WorkflowDefinitionSummary[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(
    null
  );
  const [activeVersion, setActiveVersion] = useState<WorkflowVersionView | null>(
    null
  );
  const [definition, setDefinition] = useState<StudioWorkflowDefinition>(() =>
    createStarterWorkflow(defaultAgentId)
  );
  const [savedDefinition, setSavedDefinition] =
    useState<StudioWorkflowDefinition>(definition);
  const [undoStack, setUndoStack] = useState<StudioWorkflowDefinition[]>([]);
  const [capturedEvents, setCapturedEvents] = useState<EventEnvelope[]>(() => [
    ...BUILT_IN_SAMPLE_EVENTS,
  ]);
  const [usingFallbackEvents, setUsingFallbackEvents] = useState(false);

  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingWorkflow, setLoadingWorkflow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [savingTriggerRule, setSavingTriggerRule] = useState(false);
  const [syncTriggerOnSave, setSyncTriggerOnSave] = useState(false);
  const [savedRuleIds, setSavedRuleIds] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const hasUserEditedRef = useRef(false);

  const dirty = useMemo(
    () =>
      serializeStudioDefinition(definition) !==
      serializeStudioDefinition(savedDefinition),
    [definition, savedDefinition]
  );

  const validationIssues = useMemo(
    () => validateStudioWorkflowExhaustively(definition),
    [definition]
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
        const fresh = {
          ...createStarterWorkflow(defaultAgentId),
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
        const versionView = await workflowClient.version(summary.latestVersionId);
        const parsed = JSON.parse(
          versionView.normalizedJson
        ) as WorkflowDefinition;
        const hydrated = toStudioWorkflowDefinition(parsed);
        const nextDefinition: StudioWorkflowDefinition = {
          ...hydrated,
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
    [defaultAgentId, workflowClient]
  );

  const loadWorkspaceData = useCallback(
    async (preserveCurrentSelection = false) => {
      setLoadingCatalog(true);
      setErrorMessage(null);

      const [definitionsResult, eventsResult] = await Promise.allSettled([
        workflowClient.listDefinitions(100),
        pulseClient.listCapturedEvents(25),
      ]);

      if (eventsResult.status === 'fulfilled' && eventsResult.value.length > 0) {
        setCapturedEvents(eventsResult.value);
        setUsingFallbackEvents(false);
      } else {
        setCapturedEvents([...BUILT_IN_SAMPLE_EVENTS]);
        setUsingFallbackEvents(eventsResult.status === 'rejected');
      }

      if (definitionsResult.status === 'rejected') {
        const reason = definitionsResult.reason;
        setErrorMessage(
          reason instanceof Error ? reason.message : String(reason)
        );
        setLoadingCatalog(false);
        return;
      }

      const list = definitionsResult.value;
      setDefinitions(list);
      setLoadingCatalog(false);

      if (
        !preserveCurrentSelection &&
        !hasUserEditedRef.current &&
        list.length > 0
      ) {
        await loadWorkflowSelection(list[0]);
      }
    },
    [loadWorkflowSelection, pulseClient, workflowClient]
  );

  useEffect(() => {
    void loadWorkspaceData(false);
  }, [loadWorkspaceData]);

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

  const handleNewWorkflow = useCallback(() => {
    hasUserEditedRef.current = true;
    const starter = createStarterWorkflow(defaultAgentId);
    setSelectedDefinitionId(null);
    setActiveVersion(null);
    setSavedRuleIds({});
    setDefinition(starter);
    setSavedDefinition(starter);
    setUndoStack([]);
    setErrorMessage(null);
    setStatusMessage(null);
  }, [defaultAgentId]);

  const syncTriggersToPulse = useCallback(
    async (published: WorkflowVersionView) => {
      if (triggerSteps.length === 0) return 0;
      const updatedRuleIds: Record<string, string> = {};
      for (const trigger of triggerSteps) {
        const savedRule = await pulseClient.saveRule({
          id: savedRuleIds[trigger.id] ?? null,
          enabled: trigger.evalMode !== 'off',
          spec: buildTriggerRuleSpec(definition, trigger, published),
        });
        updatedRuleIds[trigger.id] = savedRule.id;
      }
      setSavedRuleIds((current) => ({ ...current, ...updatedRuleIds }));
      return triggerSteps.length;
    },
    [definition, pulseClient, savedRuleIds, triggerSteps]
  );

  const persistWorkflow = useCallback(
    async (options: { isPublish: boolean; forceSyncTrigger?: boolean }) => {
      const issues = validateStudioWorkflowExhaustively(definition);
      if (issues.length > 0) {
        const summary = t('studio.validationBlockedSave', {
          count: issues.length,
          first: issues[0].message,
          defaultValue: `Fix ${issues.length} validation issue(s) before saving (${issues[0].message})`,
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
        if ((options.forceSyncTrigger || syncTriggerOnSave) && triggerSteps.length > 0) {
          setSavingTriggerRule(true);
          try {
            syncedCount = await syncTriggersToPulse(published);
          } finally {
            setSavingTriggerRule(false);
          }
        }

        const nextList = await workflowClient
          .listDefinitions(100)
          .catch(() => null);
        if (nextList) {
          setDefinitions(nextList);
        }

        const versionLabel = formatReleaseVersion(published.version);
        const savedLabel =
          syncedCount > 0
            ? t('studio.savedWithTriggers', {
                version: versionLabel,
                count: syncedCount,
                defaultValue: `Saved v${versionLabel} · ${syncedCount} Pulse trigger rule(s) synced`,
              })
            : t('studio.savedVersionLabel', {
                version: versionLabel,
                defaultValue: `Saved v${versionLabel}`,
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
      syncTriggerOnSave,
      syncTriggersToPulse,
      t,
      triggerSteps.length,
      workflowClient,
    ]
  );

  const handleSaveTriggerRule = useCallback(async () => {
    if (triggerSteps.length === 0) return;
    if (!activeVersion || dirty) {
      await persistWorkflow({ isPublish: false, forceSyncTrigger: true });
      return;
    }
    setErrorMessage(null);
    setSavingTriggerRule(true);
    try {
      const count = await syncTriggersToPulse(activeVersion);
      const label = t('studio.triggerRulesSaved', {
        count,
        defaultValue: `Synced ${count} Pulse trigger rule(s)`,
      });
      setStatusMessage(label);
      toast.success(label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setSavingTriggerRule(false);
    }
  }, [activeVersion, dirty, persistWorkflow, syncTriggersToPulse, t, triggerSteps.length]);

  const loadAgentSessionControls = useCallback(
    (agentId: string) => loadAgentSessionControlsCatalog(agentId),
    []
  );

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-testid="workflow-studio-dock-panel"
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--surface-panel)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label={t('studio.selectWorkflow', {
              defaultValue: 'Select workflow',
            })}
            value={selectedDefinitionId ?? '__draft__'}
            disabled={loadingCatalog || loadingWorkflow}
            onChange={(event) => {
              const nextId = event.target.value;
              if (nextId === '__draft__') {
                handleNewWorkflow();
                return;
              }
              const match = definitions.find((item) => item.id === nextId);
              if (match) {
                hasUserEditedRef.current = true;
                void loadWorkflowSelection(match);
              }
            }}
            className="h-7 max-w-[220px] truncate rounded-md border border-border bg-[var(--surface-control)] px-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="__draft__">
              {selectedDefinitionId == null
                ? `${definition.name} (${t('studio.draftBadge', { defaultValue: 'Draft' })})`
                : t('studio.unsavedDraftOption', { defaultValue: 'New Draft…' })}
            </option>
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
            onClick={handleNewWorkflow}
          >
            <Plus className="mr-1 size-3.5" />
            {t('studio.newWorkflow', { defaultValue: 'New Workflow' })}
          </Button>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={loadingCatalog || loadingWorkflow}
            onClick={() => void loadWorkspaceData(true)}
            title={t('studio.refreshCatalog', {
              defaultValue: 'Refresh workflows and captured events',
            })}
            aria-label={t('studio.refreshCatalog', {
              defaultValue: 'Refresh workflows and captured events',
            })}
          >
            <RefreshCw
              className={`size-3.5 ${loadingCatalog || loadingWorkflow ? 'animate-spin' : ''}`}
            />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          <span
            className="rounded border border-border bg-[var(--surface-control)] px-2 py-0.5 text-muted-foreground tabular-nums"
            title={
              usingFallbackEvents
                ? t('studio.offlineSampleEventsHint', {
                    defaultValue:
                      'Live Pulse capture unavailable; using built-in sample events',
                  })
                : undefined
            }
          >
            {usingFallbackEvents
              ? t('studio.builtInSamplesCount', {
                  count: capturedEvents.length,
                  defaultValue: `${capturedEvents.length} built-in samples`,
                })
              : t('studio.capturedEventsCount', {
                  count: capturedEvents.length,
                  defaultValue: `${capturedEvents.length} sample events`,
                })}
          </span>

          {triggerSteps.length > 0 ? (
            <>
              <label className="flex cursor-pointer items-center gap-1.5 rounded border border-border bg-[var(--surface-control)] px-2 py-0.5 text-muted-foreground select-none">
                <input
                  type="checkbox"
                  checked={syncTriggerOnSave}
                  onChange={(event) =>
                    setSyncTriggerOnSave(event.target.checked)
                  }
                  className="size-3 accent-primary"
                />
                <span>
                  {t('studio.syncTriggerOnSave', {
                    defaultValue: 'Sync Trigger Rule',
                  })}
                </span>
              </label>

              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={
                  savingTriggerRule ||
                  saving ||
                  publishing ||
                  validationIssues.length > 0
                }
                onClick={() => void handleSaveTriggerRule()}
              >
                {savingTriggerRule ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <Radio className="mr-1 size-3" />
                )}
                {t('studio.saveTriggerRule', {
                  defaultValue: 'Save Trigger Rule',
                })}
              </Button>
            </>
          ) : null}

          {loadingCatalog || loadingWorkflow ? (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              {t('studio.loadingWorkspace', { defaultValue: 'Loading…' })}
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
              {t('studio.unsavedChanges', { defaultValue: 'Unsaved changes' })}
            </span>
          ) : null}
        </div>
      </div>

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
            {t('studio.retryLoad', { defaultValue: 'Retry' })}
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
          loadAgentSessionControls={loadAgentSessionControls}
          capturedEvents={capturedEvents}
        />
      </div>
    </div>
  );
}

export default WorkflowStudioDockPanel;
