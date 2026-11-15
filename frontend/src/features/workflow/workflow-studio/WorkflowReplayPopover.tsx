import { useEffect, useMemo, useState } from 'react';
import { Radio, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { BUILT_IN_SAMPLE_EVENTS } from '@/features/pulse';
import { pulseApi, type EventEnvelope } from '@/lib/api/pulse';
import {
  evaluatePulseRuleLocally,
  renderPulseTemplate,
} from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';

import { DEFAULT_GATE_FILTER, type StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { formatWorkflowEventSource } from './workflowStepPresentation';

function extractStepTemplate(step: StudioWorkflowStep): string | null {
  switch (step.kind) {
    case 'session':
    case 'agent':
    case 'bot':
    case 'group_stage':
      return step.prompt.trim() ? step.prompt : null;
    case 'user_gate':
      return step.bodyTemplate.trim() ? step.bodyTemplate : step.title;
    case 'outbox_action':
      return step.payloadTemplate.trim() ? step.payloadTemplate : null;
    default:
      return null;
  }
}

export function WorkflowReplayPopover({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const { t, definition, capturedEvents, replayEnvelope, setReplayEnvelope } =
    studio;
  const [open, setOpen] = useState(false);
  const [fetchedEvents, setFetchedEvents] = useState<EventEnvelope[]>([]);
  const [jsonDraft, setJsonDraft] = useState(() =>
    JSON.stringify(BUILT_IN_SAMPLE_EVENTS[0], null, 2)
  );
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || capturedEvents) return;
    let active = true;
    void pulseApi
      .listCapturedEvents(15)
      .then((list) => {
        if (active && Array.isArray(list)) {
          setFetchedEvents(list);
        }
      })
      .catch(() => {
        if (active) setFetchedEvents([]);
      });
    return () => {
      active = false;
    };
  }, [capturedEvents, open]);

  const eventOptions = useMemo(() => {
    const live = capturedEvents ?? fetchedEvents;
    const seen = new Set<string>();
    const options: Array<{
      key: string;
      label: string;
      badge: string;
      envelope: EventEnvelope;
    }> = [];

    for (const envelope of [...live, ...BUILT_IN_SAMPLE_EVENTS]) {
      if (seen.has(envelope.eventId)) continue;
      seen.add(envelope.eventId);
      const threadSuffix = envelope.threadKey ? ` (${envelope.threadKey})` : '';
      options.push({
        key: envelope.eventId,
        label: `${envelope.eventType}${threadSuffix}`,
        badge: formatWorkflowEventSource(envelope.source.kind, t),
        envelope,
      });
    }

    return options;
  }, [capturedEvents, fetchedEvents, t]);

  const activeEnvelope = replayEnvelope;

  const triggerEvaluations = useMemo(() => {
    if (!activeEnvelope) return [];
    return definition.steps
      .filter(
        (step): step is Extract<StudioWorkflowStep, { kind: 'trigger' }> =>
          step.kind === 'trigger'
      )
      .map((step) => ({
        stepId: step.id,
        title: step.title || step.id,
        result: evaluatePulseRuleLocally(
          {
            name: step.title || step.id,
            evalMode: step.evalMode,
            filter: step.filter ?? DEFAULT_GATE_FILTER,
            temporal: step.temporal ?? null,
            targets: [
              {
                kind: 'session',
                mode: 'ephemeral_fresh',
                agentId: 'codex',
                promptTemplate: '{{event.type}}',
              },
            ],
          },
          activeEnvelope
        ),
      }));
  }, [activeEnvelope, definition.steps]);

  const renderedStepPreviews = useMemo(() => {
    if (!activeEnvelope) return [];
    return definition.steps.flatMap((step) => {
      const template = extractStepTemplate(step);
      if (!template) return [];
      return [
        {
          stepId: step.id,
          kindLabel: t(`inspector.stepKinds.${step.kind}`, {
            defaultValue: step.kind,
          }),
          rendered: renderPulseTemplate(template, activeEnvelope),
        },
      ];
    });
  }, [activeEnvelope, definition.steps, t]);

  const selectSample = (envelope: EventEnvelope) => {
    setReplayEnvelope(envelope);
    setJsonDraft(JSON.stringify(envelope, null, 2));
    setParseError(null);
  };

  const applyCustomDraft = () => {
    try {
      const parsed = JSON.parse(jsonDraft) as EventEnvelope;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.source ||
        typeof parsed.eventType !== 'string' ||
        !parsed.actor ||
        !parsed.trace
      ) {
        setParseError(t('replay.missingRequiredFields'));
        return;
      }
      setParseError(null);
      setReplayEnvelope(parsed);
    } catch (error) {
      setParseError(
        error instanceof Error ? error.message : t('replay.invalidJson')
      );
    }
  };

  const matchedGateCount = triggerEvaluations.filter(
    (item) => item.result.matched
  ).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={activeEnvelope ? 'secondary' : 'ghost'}
          data-testid="workflow-replay-trigger"
        >
          <Radio className="mr-1 size-3.5" />
          {t('replay.triggerButton')}
          {activeEnvelope ? (
            <span className="ml-1.5 inline-block size-1.5 rounded-full bg-success" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[390px] space-y-3 p-3"
        data-testid="workflow-replay-popover"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">
            {t('replay.title')}
          </span>
          {activeEnvelope ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-2xs"
              onClick={() => setReplayEnvelope(null)}
              data-testid="workflow-replay-clear"
            >
              <RotateCcw className="mr-1 size-3" />
              {t('replay.clear')}
            </Button>
          ) : null}
        </div>

        <div
          role="listbox"
          aria-label={t('replay.samplePickerAria')}
          className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/35 p-1.5"
        >
          {eventOptions.map((option) => {
            const isSelected =
              activeEnvelope?.eventId === option.envelope.eventId;
            return (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-testid={`workflow-replay-sample-${option.key}`}
                onClick={() => selectSample(option.envelope)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                  isSelected
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                )}
              >
                <span className="truncate">{option.label}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-foreground">
                  {option.badge}
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-medium text-muted-foreground">
              {t('replay.envelopeJsonLabel')}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-2xs"
              onClick={applyCustomDraft}
              data-testid="workflow-replay-apply-json"
            >
              {t('replay.applyButton')}
            </Button>
          </div>
          <textarea
            aria-label={t('replay.envelopeJsonAria')}
            value={jsonDraft}
            onChange={(event) => setJsonDraft(event.target.value)}
            className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {parseError ? (
            <p role="alert" className="text-2xs text-destructive">
              {parseError}
            </p>
          ) : null}
        </div>

        {activeEnvelope ? (
          <div
            className="space-y-2 border-t border-border pt-2.5"
            data-testid="workflow-replay-results"
          >
            {triggerEvaluations.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-2xs font-medium text-muted-foreground">
                  <span>{t('replay.triggerGates')}</span>
                  <span className="tabular-nums">
                    {t('replay.matchedSummary', {
                      matched: matchedGateCount,
                      total: triggerEvaluations.length,
                    })}
                  </span>
                </div>
                {triggerEvaluations.map((item) => (
                  <div
                    key={item.stepId}
                    className="flex items-center justify-between rounded-md border border-border bg-muted/35 px-2 py-1 text-xs"
                  >
                    <span className="truncate font-mono text-[11px]">
                      {item.stepId}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-2xs font-semibold',
                        item.result.matched
                          ? 'bg-success/15 text-success'
                          : 'bg-warning/15 text-warning'
                      )}
                    >
                      {item.result.matched
                        ? t('replay.matched')
                        : t('replay.filtered')}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {renderedStepPreviews.length > 0 ? (
              <div className="space-y-1.5">
                <span className="text-2xs font-medium text-muted-foreground">
                  {t('replay.renderedPrompts')}
                </span>
                <div className="max-h-36 space-y-1.5 overflow-y-auto">
                  {renderedStepPreviews.map((preview) => (
                    <div
                      key={preview.stepId}
                      data-testid={`workflow-replay-preview-${preview.stepId}`}
                      className="rounded-md border border-border bg-muted/25 p-2"
                    >
                      <div className="mb-0.5 text-2xs font-semibold text-muted-foreground">
                        <span className="font-mono">{preview.stepId}</span> (
                        {preview.kindLabel})
                      </div>
                      <div className="break-words text-xs text-foreground">
                        {preview.rendered}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
