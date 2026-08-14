import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Braces,
  Check,
  CircleDashed,
  Clock3,
  GitBranch,
  ShieldCheck,
  RotateCw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowRunView,
  WorkflowStep,
  WorkflowStepView,
  WorkflowVersionView,
  WorkflowReviewDecision,
} from 'shared/types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { createWorkflowApi } from '@/features/workflow/workflowApi';
import { useOpenProjectSession } from '@/hooks/useOpenProjectSession';
import { attemptsApi } from '@/lib/api/attempts';
import { useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const DONE_STEP_STATUSES = new Set(['completed', 'skipped']);

export function isWorkflowTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function workflowProgress(steps: WorkflowStepView[]) {
  const done = steps.filter((step) =>
    DONE_STEP_STATUSES.has(step.status)
  ).length;
  return {
    done,
    total: steps.length,
    percent: steps.length === 0 ? 0 : Math.round((done / steps.length) * 100),
  };
}

type InspectorData = {
  run: WorkflowRunView;
  version: WorkflowVersionView;
  definition: WorkflowDefinition;
  steps: WorkflowStepView[];
  events: WorkflowEventRecord[];
};

type WorkflowInspectorViewProps = InspectorData & {
  cancelling: boolean;
  decidingStepId: string | null;
  resumingStepId: string | null;
  onCancel: () => void;
  onDecide: (stepId: string, decision: unknown) => Promise<void>;
  onResume: (decision: WorkflowReviewDecision) => Promise<void>;
  onOpenChild: (conversationId: string, workspaceId?: string | null) => void;
};

function statusIcon(status: string) {
  if (status === 'completed') return Check;
  if (status === 'failed') return X;
  if (status === 'cancelled') return Ban;
  if (status === 'needs_review' || status === 'interrupted') {
    return AlertTriangle;
  }
  if (status === 'waiting' || status === 'waiting_approval') return Clock3;
  return CircleDashed;
}

function ReviewActions({
  step,
  busy,
  onResume,
}: {
  step: WorkflowStep;
  busy: boolean;
  onResume: (decision: WorkflowReviewDecision) => Promise<void>;
}) {
  const { t } = useTranslation('workflow');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (step.kind !== 'agent') return null;

  const accept = async () => {
    let output: JsonValue | undefined;
    if (value.trim()) {
      try {
        output = JSON.parse(value) as JsonValue;
      } catch {
        setError(t('invalidDecision'));
        return;
      }
    }
    setError(null);
    await onResume({
      kind: 'accept',
      step_id: step.id,
      output: output ?? null,
    });
  };

  return (
    <div className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
        {t('review')}
      </div>
      {step.outputSchema ? (
        <Textarea
          aria-label={t('evidencePlaceholder')}
          className="mb-2 min-h-20 resize-y font-mono text-xs"
          placeholder={t('evidencePlaceholder')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onResume({ kind: 'retry', step_id: step.id })}
        >
          <RotateCw className="mr-1.5 size-3.5" />
          {t('retryStep')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || Boolean(step.outputSchema && !value.trim())}
          onClick={accept}
        >
          {t('acceptEvidence')}
        </Button>
        {step.allowSkipOnReview ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onResume({ kind: 'skip', step_id: step.id })}
          >
            {t('skipStep')}
          </Button>
        ) : null}
        <span className="text-xs text-destructive">{error}</span>
      </div>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === 'completed') return 'text-emerald-700 dark:text-emerald-400';
  if (status === 'failed' || status === 'cancelled') {
    return 'text-destructive';
  }
  if (status === 'needs_review' || status === 'interrupted') {
    return 'text-amber-700 dark:text-amber-400';
  }
  if (status === 'running' || status === 'ready' || status === 'claimed') {
    return 'text-blue-700 dark:text-blue-400';
  }
  return 'text-muted-foreground';
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function ApprovalDecision({
  step,
  busy,
  onDecide,
}: {
  step: WorkflowStep;
  busy: boolean;
  onDecide: (decision: unknown) => Promise<void>;
}) {
  const { t } = useTranslation('workflow');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    let decision: unknown;
    try {
      decision = JSON.parse(value);
    } catch {
      setError(t('invalidDecision'));
      return;
    }
    setError(null);
    await onDecide(decision);
  };

  return (
    <div className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
          {t('approval')}
        </span>
        <code className="text-[10px] text-muted-foreground">
          {step.kind === 'approval' ? step.approverScope : ''}
        </code>
      </div>
      <Textarea
        aria-label={t('decisionPlaceholder')}
        className="min-h-20 resize-y font-mono text-xs"
        placeholder={t('decisionPlaceholder')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-destructive">{error}</span>
        <Button
          size="sm"
          disabled={busy || value.trim() === ''}
          onClick={submit}
        >
          {t('submitDecision')}
        </Button>
      </div>
    </div>
  );
}

export function WorkflowInspectorView({
  run,
  version,
  definition,
  steps,
  events,
  cancelling,
  decidingStepId,
  resumingStepId,
  onCancel,
  onDecide,
  onResume,
  onOpenChild,
}: WorkflowInspectorViewProps) {
  const { t } = useTranslation('workflow');
  const progress = workflowProgress(steps);
  const byDefinitionId = useMemo(
    () => new Map(definition.steps.map((step) => [step.id, step])),
    [definition.steps]
  );
  const policy = JSON.parse(run.policyJson) as {
    maxConcurrentAgentSteps: number;
    maxAgentCalls: number;
  };
  const canCancel = !isWorkflowTerminal(run.status);

  return (
    <main className="mx-auto w-full max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
      <header className="mb-7 flex flex-col justify-between gap-5 border-b border-border/70 pb-6 md:flex-row md:items-end">
        <div className="min-w-0">
          <p className="mb-2 font-mono text-[11px] font-medium tracking-[0.18em] text-muted-foreground">
            {t('eyebrow')}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
              {definition.name || t('titleFallback')}
            </h1>
            <Badge
              variant="outline"
              className={cn('gap-1.5', statusTone(run.status))}
            >
              {(() => {
                const Icon = statusIcon(run.status);
                return <Icon className="size-3" />;
              })()}
              {t(`status.${run.status}`)}
            </Badge>
          </div>
          {definition.description ? (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              {definition.description}
            </p>
          ) : null}
        </div>
        {canCancel ? (
          <Button variant="outline" disabled={cancelling} onClick={onCancel}>
            <Ban className="mr-2 size-4" />
            {cancelling ? t('cancelling') : t('cancel')}
          </Button>
        ) : null}
      </header>

      <section className="mb-7 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-background p-4">
          <div className="mb-2 text-xs text-muted-foreground">
            {t('progress', progress)}
          </div>
          <Progress value={progress.percent} className="h-1.5" />
        </div>
        <div className="bg-background p-4">
          <div className="text-xs text-muted-foreground">{t('budget')}</div>
          <div className="mt-1 font-mono text-sm font-medium">
            {String(run.agentCallsStarted)} / {policy.maxAgentCalls}
          </div>
        </div>
        <div className="bg-background p-4">
          <div className="text-xs text-muted-foreground">{t('deadline')}</div>
          <div className="mt-1 text-sm font-medium">
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(run.deadlineAt))}
          </div>
        </div>
        <div className="bg-background p-4">
          <div className="text-xs text-muted-foreground">{t('version')}</div>
          <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-sm font-medium">
            v{String(version.version)}
            <span className="truncate text-xs font-normal text-muted-foreground">
              {version.digest.slice(0, 12)}
            </span>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="workflow-steps-heading">
          <div className="mb-3 flex items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" />
            <h2 id="workflow-steps-heading" className="text-sm font-semibold">
              {t('steps')}
            </h2>
          </div>
          <div className="space-y-3">
            {steps.map((stepView) => {
              const step = byDefinitionId.get(stepView.stepId);
              const Icon = statusIcon(stepView.status);
              return (
                <Card
                  key={`${stepView.stepId}:${String(stepView.attempt)}`}
                  className="overflow-hidden shadow-none"
                >
                  <div className="grid md:grid-cols-[7px_minmax(0,1fr)]">
                    <div
                      className={cn(
                        'bg-muted',
                        stepView.status === 'completed' && 'bg-emerald-500',
                        stepView.status === 'running' && 'bg-blue-500',
                        (stepView.status === 'failed' ||
                          stepView.status === 'cancelled') &&
                          'bg-destructive',
                        (stepView.status === 'needs_review' ||
                          stepView.status === 'interrupted') &&
                          'bg-amber-500'
                      )}
                    />
                    <div className="p-4">
                      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Icon
                              className={cn(
                                'size-4',
                                statusTone(stepView.status)
                              )}
                            />
                            <h3 className="font-mono text-sm font-semibold">
                              {stepView.stepId}
                            </h3>
                            <span className="text-xs text-muted-foreground">
                              {t(`status.${stepView.status}`)}
                            </span>
                            {stepView.waitingInteraction ? (
                              <span className="text-xs text-amber-700 dark:text-amber-400">
                                {t('waitingInteraction')}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {t('attempt', {
                                attempt: String(stepView.attempt),
                              })}
                            </span>
                            {stepView.repairCount > 0n ? (
                              <span>
                                {t('repair', {
                                  count: String(stepView.repairCount),
                                })}
                              </span>
                            ) : null}
                            {step?.dependsOn.length ? (
                              <span>← {step.dependsOn.join(', ')}</span>
                            ) : null}
                            {step?.phase ? <span>{step.phase}</span> : null}
                          </div>
                        </div>
                        {stepView.conversationId ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              onOpenChild(
                                stepView.conversationId!,
                                stepView.workspaceId
                              )
                            }
                          >
                            {t('openChild')}
                            <ArrowUpRight className="ml-1.5 size-3.5" />
                          </Button>
                        ) : null}
                      </div>

                      {stepView.outputJson ? (
                        <details className="mt-4 rounded-md border border-border/70 bg-muted/30">
                          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                            <Braces className="mr-2 inline size-3.5 text-muted-foreground" />
                            {t('output')}
                          </summary>
                          <pre className="max-h-80 overflow-auto border-t border-border/70 p-3 text-xs leading-5">
                            {formatJson(stepView.outputJson)}
                          </pre>
                        </details>
                      ) : null}

                      {stepView.resolvedInputJson ? (
                        <details className="mt-3 rounded-md border border-border/70 bg-muted/30">
                          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                            <Braces className="mr-2 inline size-3.5 text-muted-foreground" />
                            {t('resolvedInput')}
                            {stepView.resolvedInputDigest ? (
                              <code className="ml-2 text-[10px] font-normal text-muted-foreground">
                                {stepView.resolvedInputDigest.slice(0, 12)}
                              </code>
                            ) : null}
                          </summary>
                          <pre className="max-h-80 overflow-auto border-t border-border/70 p-3 text-xs leading-5">
                            {formatJson(stepView.resolvedInputJson)}
                          </pre>
                        </details>
                      ) : null}

                      {stepView.executionEvidenceJson ? (
                        <details className="mt-3 rounded-md border border-border/70 bg-muted/30">
                          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                            <ShieldCheck className="mr-2 inline size-3.5 text-muted-foreground" />
                            {t('executionEvidence')}
                          </summary>
                          <div className="border-t border-border/70 p-3">
                            <p className="mb-2 text-xs leading-5 text-muted-foreground">
                              {t('evidenceHonesty')}
                            </p>
                            <pre className="max-h-80 overflow-auto text-xs leading-5">
                              {formatJson(stepView.executionEvidenceJson)}
                            </pre>
                          </div>
                        </details>
                      ) : null}

                      {step?.kind === 'approval' &&
                      stepView.status === 'waiting_approval' ? (
                        <ApprovalDecision
                          step={step}
                          busy={decidingStepId === step.id}
                          onDecide={(decision) => onDecide(step.id, decision)}
                        />
                      ) : null}
                      {step && stepView.status === 'needs_review' ? (
                        <ReviewActions
                          step={step}
                          busy={resumingStepId === step.id}
                          onResume={onResume}
                        />
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>

        <aside
          aria-labelledby="workflow-events-heading"
          className="xl:sticky xl:top-6"
        >
          <div className="mb-3 flex items-center gap-2">
            <Clock3 className="size-4 text-muted-foreground" />
            <h2 id="workflow-events-heading" className="text-sm font-semibold">
              {t('events')}
            </h2>
          </div>
          <Card className="max-h-[calc(100vh-12rem)] overflow-auto p-2 shadow-none">
            {events.length === 0 ? (
              <p className="p-5 text-center text-xs text-muted-foreground">
                {t('noEvents')}
              </p>
            ) : (
              <ol className="relative ml-3 border-l border-border py-1">
                {events
                  .slice()
                  .reverse()
                  .map((event) => (
                    <li key={event.id} className="relative pb-4 pl-5 last:pb-1">
                      <span className="absolute -left-1 top-1.5 size-2 rounded-full bg-muted-foreground/50 ring-4 ring-background" />
                      <div className="flex items-baseline justify-between gap-3">
                        <code className="break-all text-[11px] font-medium">
                          {event.eventKind}
                        </code>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          #{String(event.sequence)}
                        </span>
                      </div>
                      <time className="mt-1 block text-[10px] text-muted-foreground">
                        {new Intl.DateTimeFormat(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        }).format(new Date(event.createdAt))}
                      </time>
                    </li>
                  ))}
              </ol>
            )}
          </Card>
        </aside>
      </div>
    </main>
  );
}

export function WorkflowInspector() {
  const { t } = useTranslation('workflow');
  const { runId } = useParams<{ runId: string }>();
  const transport = useBackendTransport();
  const api = useMemo(() => createWorkflowApi(transport), [transport]);
  const openProjectSession = useOpenProjectSession();
  const [data, setData] = useState<InspectorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [decidingStepId, setDecidingStepId] = useState<string | null>(null);
  const [resumingStepId, setResumingStepId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const run = await api.show(runId);
      const [version, steps, events] = await Promise.all([
        api.version(run.definitionVersionId),
        api.steps(runId),
        api.events(runId),
      ]);
      setData({
        run,
        version,
        definition: JSON.parse(version.normalizedJson) as WorkflowDefinition,
        steps,
        events,
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
    }
  }, [api, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data || isWorkflowTerminal(data.run.status)) return;
    const interval = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(interval);
  }, [data, load]);

  const openChild = useCallback(
    async (conversationId: string, workspaceId?: string | null) => {
      if (!data) return;
      const workspace = await attemptsApi.get(
        workspaceId ?? data.run.workspaceId
      );
      openProjectSession({
        projectId: workspace.project_id,
        workspaceId: workspace.id,
        sessionId: conversationId,
      });
    },
    [data, openProjectSession]
  );

  if (!data && !error) {
    return (
      <div className="grid min-h-[60vh] place-items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <RotateCw className="size-4 animate-spin" />
          {t('loading')}
        </span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-5 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-3 size-5 text-destructive" />
          <h1 className="text-base font-semibold">{t('loadError')}</h1>
          <p className="mt-1 max-w-lg text-xs text-muted-foreground">{error}</p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void load()}
          >
            {t('retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <WorkflowInspectorView
      {...data}
      cancelling={cancelling}
      decidingStepId={decidingStepId}
      resumingStepId={resumingStepId}
      onOpenChild={(conversationId, workspaceId) =>
        void openChild(conversationId, workspaceId)
      }
      onCancel={() => {
        setCancelling(true);
        void api
          .cancel(data.run.id, 'cancelled from workflow inspector')
          .then(load)
          .finally(() => setCancelling(false));
      }}
      onDecide={async (stepId, decision) => {
        setDecidingStepId(stepId);
        try {
          await api.decide(data.run.id, stepId, decision);
          await load();
        } finally {
          setDecidingStepId(null);
        }
      }}
      onResume={async (decision) => {
        const stepId = 'step_id' in decision ? decision.step_id : null;
        setResumingStepId(stepId);
        try {
          await api.resume(data.run.id, decision);
          await load();
        } finally {
          setResumingStepId(null);
        }
      }}
    />
  );
}
