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
  return (
    <main className="flex h-full min-h-[680px] flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b bg-card px-3.5">
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
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-muted-foreground">
            Workflow run
          </span>
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
            {run.id.slice(0, 8)} · {run.status}
          </span>
        </div>
      </div>
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

  const load = useCallback(
    async (includeHistory = false) => {
      if (!runId) return;
      const run = await api.show(runId);
      const [version, steps, newEvents] = await Promise.all([
        api.version(run.definitionVersionId),
        api.steps(runId),
        loadAllEvents(api, runId, includeHistory ? 0n : eventCursor.current),
      ]);
      eventCursor.current = newEvents.at(-1)?.sequence ?? eventCursor.current;
      setData((current) => ({
        run,
        version,
        definition: JSON.parse(version.normalizedJson) as WorkflowDefinition,
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
    if (!runId || !transport.subscribe) return;
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
  }, [load, runId, transport]);

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
