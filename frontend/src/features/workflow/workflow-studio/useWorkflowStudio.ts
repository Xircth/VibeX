import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SoundFile,
  type AgentSessionControlsSnapshot,
  type JsonValue,
  type WorkflowStep,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { deliverDesktopNotification } from '@/components/layout/sessionCompletionNotification';
import { configApi } from '@/lib/api/config';
import { showDesktopToast } from '@/lib/desktopToast';

import { resolveWorkflowAgentId } from '../workflowAgent';
import {
  DEFAULT_OUTPUT_SCHEMA,
  EMPTY_AGENT_OPTIONS,
  EMPTY_EVENTS,
  EMPTY_STEPS,
  type StudioMode,
  type WorkflowStudioProps,
} from './types';
import { useWorkflowStudioGraph } from './useWorkflowStudioGraph';
import { withoutStepOutputBindings } from './workflowGraph';

export function useWorkflowStudio({
  definition,
  onDefinitionChange,
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
  className,
}: WorkflowStudioProps) {
  const { t, i18n } = useTranslation('workflow');
  const mode: StudioMode = onDefinitionChange ? 'edit' : 'run';
  const [inspectorTab, setInspectorTab] = useState<'info' | 'conversation'>(
    'info'
  );
  const [outputTab, setOutputTab] = useState<'brief' | 'strict'>('strict');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
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
  const graph = useWorkflowStudioGraph({
    definition,
    onDefinitionChange,
    steps,
    events,
    agentOptions,
    mode,
  });
  const { selectedStepId, setSelectedStepId, latest } = graph;
  const notifiedRuns = useRef(new Set<string>());
  const { config } = useOptionalUserSystem() ?? {};
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
    selectedStep?.kind === 'agent' ? selectedStep.agentId : null;
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
      step?.kind === 'agent' && step.outputDescription ? 'brief' : 'strict'
    );
  }, [definition.steps, selectedStepId]);

  const updateStep = useCallback(
    (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => {
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

  const nextStepId = () => {
    let ordinal = definition.steps.length + 1;
    while (definition.steps.some((step) => step.id === `step-${ordinal}`))
      ordinal += 1;
    return `step-${ordinal}`;
  };

  const addStep = (kind: 'agent' | 'notify', dependsOn: string[] = []) => {
    if (!onDefinitionChange) return;
    const common = {
      id: nextStepId(),
      dependsOn:
        dependsOn.length > 0
          ? dependsOn
          : selectedStepId
            ? [selectedStepId]
            : [],
      phase: null,
      inputBindings: {},
    };
    const step: WorkflowStep =
      kind === 'agent'
        ? {
            ...common,
            kind: 'agent',
            agentId: resolveWorkflowAgentId(
              agentOptions,
              config?.executor_profile?.executor
            ),
            prompt: '',
            executorProfileId: null,
            modeOverride: null,
            configOverrides: {},
            outputLanguage: i18n.resolvedLanguage ?? i18n.language,
            outputDescription: null,
            outputSchema: DEFAULT_OUTPUT_SCHEMA,
            workspaceAccess: 'native',
            sideEffectClass: 'mutating_unknown',
            allowOneRepair: false,
            allowSkipOnReview: false,
            completionPolicy: 'automatic',
          }
        : {
            ...common,
            kind: 'notify',
            title: t('studio.newNotify'),
          };
    onDefinitionChange({ ...definition, steps: [...definition.steps, step] });
    setUnsavedStepIds((current) => new Set(current).add(step.id));
    setSelectedStepId(step.id);
    setInspectorTab('info');
  };

  const copySelected = (stepId: string) => {
    if (!onDefinitionChange) return;
    const source = definition.steps.find((step) => step.id === stepId);
    if (!source || source.kind === 'approval') return;
    const copy: WorkflowStep = { ...source, id: nextStepId() };
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
    className,
    t,
    config,
    ...graph,
    inspectorTab,
    setInspectorTab,
    outputTab,
    setOutputTab,
    workspaceOpen,
    setWorkspaceOpen,
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
    addStep,
    copySelected,
    removeStep,
    removeSelected,
  };
}

export type WorkflowStudioView = ReturnType<typeof useWorkflowStudio>;
