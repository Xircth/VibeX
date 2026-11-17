import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, RotateCw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowReviewDecision,
  WorkflowRunView,
  WorkflowStepView,
  WorkflowVersionView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { WorkflowStudio } from '@/features/workflow/WorkflowStudio';
import { createWorkflowApi } from '@/features/workflow/workflowApi';
import { useBackendTransport } from '@/lib/transport';
import { useAppContextMenu } from '@/components/context-menu';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isWorkflowTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

type InspectorData = {
  run: WorkflowRunView;
  version: WorkflowVersionView;
  definition: WorkflowDefinition;
  steps: WorkflowStepView[];
  events: WorkflowEventRecord[];
};

type WorkflowInspectorViewProps = InspectorData & {
  onBack?: () => void;
  onPauseRun: () => void;
  onResumeRun: () => void;
  onTestNode: (stepId: string) => void;
  onRerunFromNode: (stepId: string) => void;
  onAcceptCandidate: (stepId: string) => void;
  onPauseStep: (stepId: string) => void;
  onSubmitStepInput: (stepId: string, text: string) => Promise<void>;
  onDecideApproval: (stepId: string, decision: JsonValue) => Promise<void>;
  onReview: (decision: WorkflowReviewDecision) => Promise<void>;
};

type BackendStepKind = WorkflowDefinition['steps'][number]['kind'];

const STEP_KIND_BADGE_LABELS: Record<BackendStepKind, string> = {
  session: 'Session',
  bot: 'Bot',
  group_stage: 'Group Stage',
  user_gate: 'User Gate',
  condition_branch: 'Condition Branch',
  bounded_loop: 'Bounded Loop',
  wait_for_event: 'Wait For Event',
  outbox_action: 'Outbox Action',
  agent: 'Agent',
  approval: 'Approval',
  notify: 'Notify',
};

export function formatWorkflowStepKindBadge(kind: BackendStepKind): string {
  return STEP_KIND_BADGE_LABELS[kind] ?? kind;
}

export function WorkflowInspectorView({
  run,
  definition,
  steps,
  events,
  onBack,
  onPauseRun,
  onResumeRun,
  onTestNode,
  onRerunFromNode,
  onAcceptCandidate,
  onPauseStep,
  onSubmitStepInput,
  onDecideApproval,
  onReview,
}: WorkflowInspectorViewProps) {
  const { t } = useTranslation(['common', 'workflow']);
  const { openSurfaceMenu } = useAppContextMenu();
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>(
    {}
  );
  const [customJsonOpenByStep, setCustomJsonOpenByStep] = useState<
    Record<string, boolean>
  >({});
  const [customJsonByStep, setCustomJsonByStep] = useState<
    Record<string, string>
  >({});
  const [customJsonErrorByStep, setCustomJsonErrorByStep] = useState<
    Record<string, string | null>
  >({});
  const [submittingStepId, setSubmittingStepId] = useState<string | null>(null);

  const stepStatusById = useMemo(
    () => new Map(steps.map((stepRun) => [stepRun.stepId, stepRun])),
    [steps]
  );

  const waitingApprovalSteps = useMemo(
    () => steps.filter((stepRun) => stepRun.status === 'waiting_approval'),
    [steps]
  );

  const submitQuickDecision = useCallback(
    async (stepId: string, approved: boolean) => {
      const trimmedNote = (approvalNotes[stepId] ?? '').trim();
      const decision: JsonValue = {
        approved,
        optionId: approved ? 'approve' : 'reject',
        ...(trimmedNote ? { note: trimmedNote } : {}),
      };
      setSubmittingStepId(stepId);
      try {
        await onDecideApproval(stepId, decision);
        setApprovalNotes((current) => ({ ...current, [stepId]: '' }));
      } finally {
        setSubmittingStepId(null);
      }
    },
    [approvalNotes, onDecideApproval]
  );

  const submitCustomJsonDecision = useCallback(
    async (stepId: string) => {
      const raw = customJsonByStep[stepId] ?? '{}';
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(raw) as JsonValue;
      } catch {
        setCustomJsonErrorByStep((current) => ({
          ...current,
          [stepId]: t('workflow:invalidDecision', {
            defaultValue: 'Invalid JSON decision payload.',
          }),
        }));
        return;
      }
      setCustomJsonErrorByStep((current) => ({ ...current, [stepId]: null }));
      setSubmittingStepId(stepId);
      try {
        await onDecideApproval(stepId, parsed);
      } finally {
        setSubmittingStepId(null);
      }
    },
    [customJsonByStep, onDecideApproval, t]
  );

  return (
    <main
      className="flex h-full min-h-[680px] flex-col bg-background"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'copy-run',
            label: t('common:contextMenu.copyRunId'),
            onSelect: () => {
              void writeClipboardViaBridge(run.id);
            },
          },
        ]);
      }}
    >
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-3 border-b bg-card px-3.5 py-1.5">
        {onBack ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onBack}
          >
            <ArrowLeft className="size-3.5" />
            <span className="sr-only">Back</span>
          </Button>
        ) : null}
        <div className="min-w-0 shrink-0">
          <span className="text-xs font-medium text-muted-foreground">
            {i18n.t('panels:ui.workflow.workflowRun')}
          </span>
          <span className="ml-2 font-mono text-[10px] text-muted-foreground tabular-nums">
            {run.id.slice(0, 8)} · {run.status}
          </span>
        </div>

        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          data-testid="workflow-inspector-step-badges"
        >
          {definition.steps.map((step) => {
            const stepRun = stepStatusById.get(step.id);
            return (
              <span
                key={step.id}
                data-step-id={step.id}
                data-step-kind={step.kind}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-[var(--surface-control)] px-2 py-0.5 text-[11px] text-foreground"
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  {step.id}
                </span>
                <span className="font-medium">
                  {t(`workflow:inspector.stepKinds.${step.kind}`, {
                    defaultValue: formatWorkflowStepKindBadge(step.kind),
                  })}
                </span>
                {stepRun ? (
                  <span className="rounded bg-muted px-1 py-0.2 font-mono text-[10px] text-muted-foreground">
                    {stepRun.status}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>

      {waitingApprovalSteps.map((waitingStep) => {
        const stepDef = definition.steps.find(
          (candidate) => candidate.id === waitingStep.stepId
        );
        const noteValue = approvalNotes[waitingStep.stepId] ?? '';
        const customOpen = Boolean(customJsonOpenByStep[waitingStep.stepId]);
        const customJson = customJsonByStep[waitingStep.stepId] ?? '{}';
        const customError = customJsonErrorByStep[waitingStep.stepId];
        const isSubmitting = submittingStepId === waitingStep.stepId;

        return (
          <div
            key={waitingStep.stepId}
            data-testid={`waiting-approval-banner-${waitingStep.stepId}`}
            className="flex shrink-0 flex-col gap-2 border-b border-warning/35 bg-[var(--surface-panel)] px-3.5 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded border border-warning/40 bg-warning/15 px-1.5 py-0.5 font-semibold text-foreground">
                  {t('workflow:inspector.waitingApprovalBadge', {
                    defaultValue: 'Awaiting Approval',
                  })}
                </span>
                <span className="font-mono font-medium text-foreground">
                  {waitingStep.stepId}
                </span>
                {stepDef ? (
                  <span className="rounded border border-border bg-[var(--surface-control)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t(`workflow:inspector.stepKinds.${stepDef.kind}`, {
                      defaultValue: formatWorkflowStepKindBadge(stepDef.kind),
                    })}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                <input
                  type="text"
                  value={noteValue}
                  onChange={(event) =>
                    setApprovalNotes((current) => ({
                      ...current,
                      [waitingStep.stepId]: event.target.value,
                    }))
                  }
                  aria-label={t('workflow:inspector.approvalNoteLabel', {
                    defaultValue: 'Approval note',
                  })}
                  placeholder={t('workflow:inspector.approvalNotePlaceholder', {
                    defaultValue: 'Add optional decision note…',
                  })}
                  className="h-7 min-w-[200px] flex-1 max-w-xs rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={isSubmitting}
                  onClick={() =>
                    void submitQuickDecision(waitingStep.stepId, true)
                  }
                >
                  {t('workflow:inspector.approve', { defaultValue: 'Approve' })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2.5 text-xs"
                  disabled={isSubmitting}
                  onClick={() =>
                    void submitQuickDecision(waitingStep.stepId, false)
                  }
                >
                  {t('workflow:inspector.reject', { defaultValue: 'Reject' })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setCustomJsonOpenByStep((current) => ({
                      ...current,
                      [waitingStep.stepId]: !current[waitingStep.stepId],
                    }))
                  }
                >
                  {t('workflow:inspector.customJsonDecision', {
                    defaultValue: 'Custom JSON',
                  })}
                </Button>
              </div>
            </div>

            {customOpen ? (
              <div className="flex flex-col gap-1.5 pt-1">
                <div className="flex items-start gap-2">
                  <textarea
                    aria-label={t('workflow:studio.decisionJson', {
                      defaultValue: 'Decision JSON',
                    })}
                    value={customJson}
                    onChange={(event) =>
                      setCustomJsonByStep((current) => ({
                        ...current,
                        [waitingStep.stepId]: event.target.value,
                      }))
                    }
                    className="min-h-16 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs"
                    disabled={isSubmitting}
                    onClick={() =>
                      void submitCustomJsonDecision(waitingStep.stepId)
                    }
                  >
                    {t('workflow:submitDecision', {
                      defaultValue: 'Submit Decision',
                    })}
                  </Button>
                </div>
                {customError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {customError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <WorkflowStudio
        definition={definition}
        run={run}
        steps={steps}
        events={events}
        onPauseRun={onPauseRun}
        onResumeRun={onResumeRun}
        onTestNode={onTestNode}
        onRerunFromNode={onRerunFromNode}
        onAcceptCandidate={onAcceptCandidate}
        onPauseStep={onPauseStep}
        onSubmitStepInput={onSubmitStepInput}
        onDecideApproval={onDecideApproval}
        onReview={onReview}
      />
    </main>
  );
}

async function loadAllEvents(
  api: ReturnType<typeof createWorkflowApi>,
  runId: string,
  afterSequence = 0n
): Promise<WorkflowEventRecord[]> {
  const records: WorkflowEventRecord[] = [];
  let cursor = afterSequence;
  for (;;) {
    const page = await api.events(runId, Number(cursor), 500);
    records.push(...page);
    if (page.length < 500) return records;
    const next = page.at(-1)?.sequence ?? cursor;
    if (next <= cursor) return records;
    cursor = next;
  }
}

export function WorkflowInspector() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const transport = useBackendTransport();
  const api = useMemo(() => createWorkflowApi(transport), [transport]);
  const [data, setData] = useState<InspectorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eventCursor = useRef(0n);
  const parsedDefinitionsRef = useRef<Map<string, WorkflowDefinition>>(
    new Map()
  );
  const isRunTerminal = data ? isWorkflowTerminal(data.run.status) : false;

  const load = useCallback(
    async (includeHistory = false) => {
      if (!runId) return;
      const run = await api.show(runId);
      const [version, steps, newEvents] = await Promise.all([
        api.version(run.definitionVersionId),
        api.steps(runId),
        loadAllEvents(api, runId, includeHistory ? 0n : eventCursor.current),
      ]);
      let definition = parsedDefinitionsRef.current.get(version.id);
      if (!definition) {
        definition = JSON.parse(version.normalizedJson) as WorkflowDefinition;
        if (parsedDefinitionsRef.current.size >= 16) {
          parsedDefinitionsRef.current.clear();
        }
        parsedDefinitionsRef.current.set(version.id, definition);
      }
      eventCursor.current = newEvents.at(-1)?.sequence ?? eventCursor.current;
      setData((current) => ({
        run,
        version,
        definition,
        steps,
        events: includeHistory
          ? newEvents
          : [
              ...(current?.events ?? []),
              ...newEvents.filter(
                (event) =>
                  !(current?.events ?? []).some(
                    (existing) => existing.sequence === event.sequence
                  )
              ),
            ],
      }));
      setError(null);
    },
    [api, runId]
  );

  useEffect(() => {
    let active = true;
    eventCursor.current = 0n;
    void load(true).catch((loadError) => {
      if (active) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      }
    });
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (!runId || !transport.subscribe || isRunTerminal) return;
    let active = true;
    const subscribe = transport.subscribe.bind(transport);
    const consume = async () => {
      try {
        for await (const _event of subscribe({
          subscription_id: crypto.randomUUID(),
          resource: 'workflow_run',
          run_id: runId,
          after_sequence: eventCursor.current,
        })) {
          if (!active) return;
          await load(false);
        }
      } catch (subscriptionError) {
        if (active) {
          setError(
            subscriptionError instanceof Error
              ? subscriptionError.message
              : String(subscriptionError)
          );
        }
      }
    };
    void consume();
    return () => {
      active = false;
    };
  }, [isRunTerminal, load, runId, transport]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>) => {
      try {
        await operation();
        await load(false);
      } catch (mutationError) {
        toast.error(
          mutationError instanceof Error
            ? mutationError.message
            : String(mutationError)
        );
        throw mutationError;
      }
    },
    [load]
  );

  const openDerived = useCallback(
    async (stepId: string, scope: 'node' | 'downstream') => {
      if (!data) return;
      try {
        const derived = await api.fork(
          data.run.id,
          data.version.id,
          stepId,
          scope
        );
        navigate(`/workflows/${derived.id}`);
      } catch (forkError) {
        toast.error(
          forkError instanceof Error ? forkError.message : String(forkError)
        );
      }
    },
    [api, data, navigate]
  );

  if (!data && !error) {
    return (
      <div className="grid min-h-[60vh] place-items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <RotateCw className="size-4 animate-spin" /> Loading Workflow…
        </span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-5 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-3 size-5 text-destructive" />
          <h1 className="text-base font-semibold">Could not load Workflow</h1>
          <p className="mt-1 max-w-lg text-xs text-muted-foreground">{error}</p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void load(true)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <WorkflowInspectorView
      {...data}
      onBack={() => navigate(-1)}
      onPauseRun={() =>
        void mutate(() => api.pause(data.run.id, 'paused from Studio'))
      }
      onResumeRun={() => void mutate(() => api.resumeRun(data.run.id))}
      onTestNode={(stepId) => void openDerived(stepId, 'node')}
      onRerunFromNode={(stepId) => void openDerived(stepId, 'downstream')}
      onAcceptCandidate={(stepId) =>
        void mutate(() => api.acceptCandidate(data.run.id, stepId))
      }
      onPauseStep={(stepId) =>
        void mutate(() =>
          api.pauseStep(data.run.id, stepId, 'paused in node Conversation')
        )
      }
      onSubmitStepInput={(stepId, text) =>
        mutate(() => api.submitStepInput(data.run.id, stepId, text))
      }
      onDecideApproval={(stepId, decision) =>
        mutate(() => api.decide(data.run.id, stepId, decision))
      }
      onReview={(decision) => mutate(() => api.resume(data.run.id, decision))}
    />
  );
}
