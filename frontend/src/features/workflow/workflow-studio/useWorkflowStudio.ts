import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SoundFile,
  type AgentSessionControlsSnapshot,
  type JsonValue,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { deliverDesktopNotification } from '@/components/layout/sessionCompletionNotification';
import { configApi } from '@/lib/api/config';
import type {
  EventEnvelope,
  PresetOrchestratorKind,
  PulseEvalMode,
} from '@/lib/api/pulse';
import { showDesktopToast } from '@/lib/desktopToast';

import { resolveWorkflowAgentId } from '../workflowAgent';
import { WORKFLOW_PRESET_TEMPLATES } from './presetTemplates';
import {
  EMPTY_AGENT_OPTIONS,
  EMPTY_EVENTS,
  EMPTY_STEPS,
  type StudioAddableStepKind,
  type StudioInspectorTier,
  type StudioMode,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
  type WorkflowStudioDefinitionInput,
  type WorkflowStudioProps,
} from './types';
import { useWorkflowStudioGraph } from './useWorkflowStudioGraph';
import { withoutStepOutputBindings } from './workflowGraph';
import {
  createDefaultStepForKind,
  isStudioOnlyDefinition,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
} from './workflowStepPresentation';
import { validateStudioWorkflowExhaustively } from './workflowValidation';

export function useWorkflowStudio<
  TDef extends WorkflowStudioDefinitionInput = StudioWorkflowDefinition,
>({
  definition: rawDefinition,
  onDefinitionChange: rawOnDefinitionChange,
  run,
  steps = EMPTY_STEPS,
  events = EMPTY_EVENTS,
  dirty,
  saving,
  publishing,
  onSave,
  onPublish,
  releaseVersion,
  canUndo = false,
  onUndo,
  workspaceConfig,
  workspaceSummary,
  onBack,
  editorName,
  onEditorNameChange,
  agentOptions = EMPTY_AGENT_OPTIONS,
  loadAgentSessionControls,
  onStopRun,
  onTerminateRun,
  onReset,
  notifyContext,
  showStopActions = false,
  stopActionsDisabled = false,
  resetDisabled = false,
  onPauseRun,
  onResumeRun,
  onTestNode,
  onRerunFromNode,
  onAcceptCandidate,
  onPauseStep,
  onSubmitStepInput,
  onDecideApproval,
  onReview,
  activeWorktree,
  capturedEvents,
  studioMode: rawStudioMode,
  className,
}: WorkflowStudioProps<TDef>) {
  const { t, i18n } = useTranslation('workflow');
  const studioModeInput = useMemo(
    () => rawStudioMode ?? isStudioOnlyDefinition(rawDefinition),
    [rawDefinition, rawStudioMode]
  );
  const definition = useMemo(
    () => toStudioWorkflowDefinition(rawDefinition),
    [rawDefinition]
  );
  const onDefinitionChange = useMemo(() => {
    if (!rawOnDefinitionChange) return undefined;
    return (next: StudioWorkflowDefinition) => {
      rawOnDefinitionChange(
        (studioModeInput
          ? next
          : toBackendWorkflowDefinition(next)) as unknown as TDef
      );
    };
  }, [rawOnDefinitionChange, studioModeInput]);

  const mode: StudioMode = onDefinitionChange ? 'edit' : 'run';
  const [inspectorTab, setInspectorTab] = useState<'info' | 'conversation'>(
    'info'
  );
  const [inspectorTier, setInspectorTier] =
    useState<StudioInspectorTier>('visual');
  const [outputTab, setOutputTab] = useState<'brief' | 'strict'>('strict');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [replayEnvelope, setReplayEnvelope] = useState<EventEnvelope | null>(
    null
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    kind: 'pane' | 'node';
    stepId?: string;
    confirmation?: boolean;
  } | null>(null);
  const [primaryStopAction, setPrimaryStopAction] = useState<
    'stop' | 'terminate'
  >('stop');
  const [decisionJson, setDecisionJson] = useState('{}');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [unsavedStepIds, setUnsavedStepIds] = useState<Set<string>>(
    () => new Set()
  );
  const [agentControls, setAgentControls] =
    useState<AgentSessionControlsSnapshot | null>(null);
  const [agentControlsLoading, setAgentControlsLoading] = useState(false);
  const [agentControlsError, setAgentControlsError] = useState<unknown>(null);
  const loadAgentSessionControlsRef = useRef(loadAgentSessionControls);
  loadAgentSessionControlsRef.current = loadAgentSessionControls;
  const { config } = useOptionalUserSystem() ?? {};

  const updateStep = useCallback(
    (
      stepId: string,
      update: (step: StudioWorkflowStep) => StudioWorkflowStep
    ) => {
      setUnsavedStepIds((current) => new Set(current).add(stepId));
      onDefinitionChange?.({
        ...definition,
        steps: definition.steps.map((step) =>
          step.id === stepId ? update(step) : step
        ),
      });
    },
    [definition, onDefinitionChange]
  );

  const updateTriggerEvalMode = useCallback(
    (stepId: string, evalMode: PulseEvalMode) => {
      if (!onDefinitionChange) return;
      updateStep(stepId, (step) =>
        step.kind === 'trigger' ? { ...step, evalMode } : step
      );
    },
    [onDefinitionChange, updateStep]
  );

  const graph = useWorkflowStudioGraph({
    definition,
    onDefinitionChange,
    steps,
    events,
    agentOptions,
    mode,
    replayEnvelope,
    onTriggerEvalModeChange: onDefinitionChange
      ? updateTriggerEvalMode
      : undefined,
  });
  const { selectedStepId, setSelectedStepId, latest } = graph;
  const notifiedRuns = useRef(new Set<string>());

  useEffect(() => {
    const notifications = config?.notifications;
    if (!notifications) return;
    for (const step of latest.values()) {
      if (step.status !== 'completed' || notifiedRuns.current.has(step.id))
        continue;
      const spec = definition.steps.find((item) => item.id === step.stepId);
      if (spec?.kind !== 'notify') continue;
      notifiedRuns.current.add(step.id);
      const title = spec.title.trim() || spec.id;
      const predecessor = spec.dependsOn[0] ?? spec.id;
      void deliverDesktopNotification({
        windowFocused: document.hasFocus(),
        notifyWhen: notifications.notify_when ?? 'unfocused',
        soundEnabled: notifications.sound_enabled,
        soundFile: notifications.sound_file ?? SoundFile.ABSTRACT_SOUND1,
        pushEnabled: notifications.push_enabled,
        playSound: configApi.playNotificationSound,
        showPush: () =>
          notifyContext
            ? showDesktopToast({
                projectId: notifyContext.projectId,
                workspaceId: notifyContext.workspaceId,
                sessionId: run?.id ?? step.id,
                title,
                description: `${predecessor} · ${
                  step.completedAt
                    ? new Date(step.completedAt).toLocaleString()
                    : ''
                }`,
                kind: 'success',
                durationMs: 15000,
              })
            : Promise.resolve(),
      });
    }
  }, [config, definition.steps, latest, notifyContext, run?.id]);

  const selectedStep =
    definition.steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedRun = selectedStepId ? latest.get(selectedStepId) : undefined;
  const selectedStepSaved = selectedStepId
    ? !unsavedStepIds.has(selectedStepId)
    : false;
  const selectedSuccessors = selectedStepId
    ? definition.steps
        .filter((step) => step.dependsOn.includes(selectedStepId))
        .map((step) => step.id)
    : [];
  const selectedAgentId =
    selectedStep?.kind === 'agent' || selectedStep?.kind === 'session'
      ? selectedStep.agentId
      : null;
  const canLoadAgentSessionControls = Boolean(loadAgentSessionControls);

  useEffect(() => {
    const loadControls = loadAgentSessionControlsRef.current;
    if (!selectedAgentId || !loadControls) {
      setAgentControls(null);
      setAgentControlsLoading(false);
      setAgentControlsError(null);
      return;
    }
    let active = true;
    setAgentControlsLoading(true);
    setAgentControlsError(null);
    void loadControls(selectedAgentId)
      .then((controls) => {
        if (active) {
          setAgentControls(controls);
          setAgentControlsError(null);
        }
      })
      .catch((error) => {
        if (active) {
          setAgentControls(null);
          setAgentControlsError(error);
        }
      })
      .finally(() => {
        if (active) setAgentControlsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canLoadAgentSessionControls, selectedAgentId]);

  const updateJson = useCallback(
    (value: string, apply: (parsed: JsonValue | null) => void) => {
      try {
        apply(value.trim() ? (JSON.parse(value) as JsonValue) : null);
        setJsonError(null);
      } catch {
        setJsonError(t('studio.invalidJson'));
      }
    },
    [t]
  );

  const previousSelectedStepId = useRef<string | null>(null);
  useEffect(() => {
    if (previousSelectedStepId.current === selectedStepId) return;
    previousSelectedStepId.current = selectedStepId;
    const step = definition.steps.find((item) => item.id === selectedStepId);
    setOutputTab(
      (step?.kind === 'agent' || step?.kind === 'session') &&
        step.outputDescription
        ? 'brief'
        : 'strict'
    );
  }, [definition.steps, selectedStepId]);

  const validationIssues = useMemo(
    () => validateStudioWorkflowExhaustively(definition),
    [definition]
  );

  const defaultAgentId = useMemo(
    () =>
      resolveWorkflowAgentId(agentOptions, config?.executor_profile?.executor),
    [agentOptions, config?.executor_profile?.executor]
  );

  const nextStepId = (prefix = 'step') => {
    let ordinal = definition.steps.length + 1;
    while (definition.steps.some((step) => step.id === `${prefix}-${ordinal}`))
      ordinal += 1;
    return `${prefix}-${ordinal}`;
  };

  const addStep = (kind: StudioAddableStepKind, dependsOn: string[] = []) => {
    if (!onDefinitionChange) return;
    const prefix =
      kind === 'agent' || kind === 'notify' || kind === 'approval'
        ? 'step'
        : kind.replace('_', '-');
    const common = {
      id: nextStepId(prefix),
      dependsOn:
        kind === 'trigger'
          ? []
          : dependsOn.length > 0
            ? dependsOn
            : selectedStepId
              ? [selectedStepId]
              : [],
      phase: null,
      inputBindings: {},
    };
    const step = createDefaultStepForKind(
      kind,
      common,
      defaultAgentId,
      i18n.resolvedLanguage ?? i18n.language ?? 'en',
      t('studio.newNotify')
    );
    onDefinitionChange({ ...definition, steps: [...definition.steps, step] });
    setUnsavedStepIds((current) => new Set(current).add(step.id));
    setSelectedStepId(step.id);
    setInspectorTab('info');
  };

  const applyPreset = (presetId: PresetOrchestratorKind) => {
    if (!onDefinitionChange) return;
    const template = WORKFLOW_PRESET_TEMPLATES.find(
      (item) => item.id === presetId
    );
    if (!template) return;
    const nextDefinition = template.build(defaultAgentId);
    onDefinitionChange(nextDefinition);
    setUnsavedStepIds(new Set());
    setSelectedStepId(nextDefinition.steps[0]?.id ?? null);
    setInspectorTab('info');
    setInspectorTier('visual');
  };

  const copySelected = (stepId: string) => {
    if (!onDefinitionChange) return;
    const source = definition.steps.find((step) => step.id === stepId);
    if (!source || source.kind === 'approval') return;
    const copy: StudioWorkflowStep = { ...source, id: nextStepId('step') };
    onDefinitionChange({
      ...definition,
      steps: [...definition.steps, copy],
    });
    setUnsavedStepIds((current) => new Set(current).add(copy.id));
    setSelectedStepId(copy.id);
  };

  const removeStep = (stepId: string) => {
    if (!onDefinitionChange) return;
    onDefinitionChange({
      ...definition,
      steps: definition.steps
        .filter((step) => step.id !== stepId)
        .map((step) => ({
          ...step,
          dependsOn: step.dependsOn.filter(
            (dependency) => dependency !== stepId
          ),
          inputBindings: withoutStepOutputBindings(
            step.inputBindings,
            new Set([stepId])
          ),
        })),
    });
    setUnsavedStepIds((current) => {
      const next = new Set(current);
      next.delete(stepId);
      return next;
    });
    setSelectedStepId((current) => (current === stepId ? null : current));
  };

  const removeSelected = () => {
    if (selectedStep) removeStep(selectedStep.id);
  };

  return {
    definition,
    onDefinitionChange,
    run,
    events,
    dirty,
    saving,
    publishing,
    onSave,
    onPublish,
    releaseVersion,
    canUndo,
    onUndo,
    workspaceConfig,
    workspaceSummary,
    onBack,
    editorName,
    onEditorNameChange,
    agentOptions,
    defaultAgentId,
    outputLanguage: i18n.resolvedLanguage ?? i18n.language ?? 'en',
    onStopRun,
    onTerminateRun,
    onReset,
    showStopActions,
    stopActionsDisabled,
    resetDisabled,
    onPauseRun,
    onResumeRun,
    onTestNode,
    onRerunFromNode,
    onAcceptCandidate,
    onPauseStep,
    onSubmitStepInput,
    onDecideApproval,
    onReview,
    activeWorktree,
    capturedEvents,
    className,
    t,
    config,
    ...graph,
    inspectorTab,
    setInspectorTab,
    inspectorTier,
    setInspectorTier,
    outputTab,
    setOutputTab,
    workspaceOpen,
    setWorkspaceOpen,
    replayEnvelope,
    setReplayEnvelope,
    validationIssues,
    contextMenu,
    setContextMenu,
    primaryStopAction,
    setPrimaryStopAction,
    decisionJson,
    setDecisionJson,
    decisionError,
    setDecisionError,
    jsonError,
    setJsonError,
    unsavedStepIds,
    setUnsavedStepIds,
    agentControls,
    agentControlsLoading,
    agentControlsError,
    selectedStep,
    selectedRun,
    selectedStepSaved,
    selectedSuccessors,
    updateJson,
    updateStep,
    updateTriggerEvalMode,
    addStep,
    applyPreset,
    copySelected,
    removeStep,
    removeSelected,
  };
}

export type WorkflowStudioView = ReturnType<typeof useWorkflowStudio>;
