import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Bell,
  Bot,
  Check,
  GitFork,
  ListTree,
  Repeat,
  Send,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { PulseEvalModeControl } from '@/features/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';

import { StudioAgentIcon } from './StudioAgentIcon';
import { DEFAULT_GATE_FILTER, type StudioNode } from './types';
import {
  describeStepPresentation,
  flameSpans,
  previewMarkdown,
  statusClass,
  statusDotClass,
} from './workflowStepPresentation';

export const WorkflowStepNode = memo(function WorkflowStepNode({
  data,
}: NodeProps<StudioNode>) {
  const { t } = useTranslation('workflow');
  const [logView, setLogView] = useState<'log' | 'preview'>('log');
  const logEvents = data.events;
  const logSpans = useMemo(
    () => (data.logExpanded ? flameSpans(logEvents) : []),
    [data.logExpanded, logEvents]
  );

  if (data.confirmationFor) {
    const waiting = data.stepRun?.awaitingAcceptance === true;
    const completed = data.stepRun?.status === 'completed';
    return (
      <article
        className={cn(
          'workflow-confirmation-node flex h-12 w-36 items-center gap-2 rounded-lg border bg-card px-3 text-left shadow-sm',
          data.selected && 'workflow-node-selected',
          waiting && 'workflow-confirmation-waiting',
          completed && 'workflow-node-completed'
        )}
      >
        <Handle
          id="target"
          type="target"
          position={Position.Left}
          isConnectable
          className="!size-3 !border-0"
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => data.onSelect(data.confirmationFor!)}
          aria-label={
            waiting
              ? t('studio.confirmationRequired')
              : t('studio.confirmation')
          }
        >
          <Check className="size-4 shrink-0" />
          <span className="min-w-0 text-xs font-medium">
            {waiting
              ? t('studio.confirmationRequired')
              : completed
                ? t('studio.confirmed')
                : t('studio.confirmation')}
          </span>
        </button>
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          isConnectable
          className="!size-3 !border-0"
        />
      </article>
    );
  }

  const presentation = describeStepPresentation(
    data.step,
    data.agentOptions,
    t('studio.notify')
  );

  const sessionOrAgentStep =
    data.step.kind === 'agent' || data.step.kind === 'session'
      ? data.step
      : null;

  const status = data.stepRun?.awaitingAcceptance
    ? 'awaiting_acceptance'
    : data.stepRun?.awaitingInput
      ? 'awaiting_input'
      : data.stepRun?.status;
  const statusLabel = status
    ? t(`status.${status}`, { defaultValue: status })
    : t('studio.standby');

  const triggerReplayMatched = useMemo(() => {
    if (!data.replayEnvelope || data.step.kind !== 'trigger') return null;
    const report = evaluatePulseRuleLocally(
      {
        name: data.step.title || data.step.id,
        evalMode: data.step.evalMode,
        filter: data.step.filter ?? DEFAULT_GATE_FILTER,
        temporal: data.step.temporal ?? null,
        targets: [
          {
            kind: 'session',
            mode: 'ephemeral_fresh',
            agentId: 'codex',
            promptTemplate: '{{event.type}}',
          },
        ],
      },
      data.replayEnvelope
    );
    return report.matched;
  }, [data.replayEnvelope, data.step]);

  const renderLeadingIcon = () => {
    if (sessionOrAgentStep) {
      return (
        <StudioAgentIcon
          agentId={sessionOrAgentStep.agentId}
          agentOptions={data.agentOptions}
          className="size-4"
        />
      );
    }
    switch (presentation.category) {
      case 'trigger':
        return <Zap className="size-4" />;
      case 'bot':
        return <Bot className="size-4" />;
      case 'group_stage':
        return <Users className="size-4" />;
      case 'user_gate':
        return data.step.kind === 'notify' ||
          (data.step.kind === 'user_gate' &&
            data.step.interactionKind === 'notify') ? (
          <Bell className="size-4" />
        ) : (
          <ShieldCheck className="size-4" />
        );
      case 'control':
        return data.step.kind === 'control' &&
          data.step.controlKind === 'bounded_loop' ? (
          <Repeat className="size-4" />
        ) : (
          <GitFork className="size-4" />
        );
      case 'outbox_action':
        return <Send className="size-4" />;
      case 'session':
        return <GitFork className="size-4" />;
    }
  };

  return (
    <article
      data-testid={`workflow-node-${data.step.id}`}
      data-node-category={presentation.category}
      className={cn(
        'workflow-studio-node group relative w-[260px] rounded-lg border bg-card text-left outline-none transition-[border-color,box-shadow,transform]',
        data.selected && 'workflow-node-selected',
        statusClass(data.stepRun?.status)
      )}
    >
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        isConnectable
        className="!size-3 !border-0"
      />
      <button
        type="button"
        className="block !h-auto !min-h-[68px] w-full rounded-t-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        onClick={() => data.onSelect(data.step.id)}
        aria-pressed={data.selected}
        aria-label={`${data.step.id} ${presentation.accessibleSummary}`}
      >
        <span className="flex items-start gap-2.5 p-3 pb-2">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/45 text-muted-foreground">
            {renderLeadingIcon()}
          </span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block truncate text-md font-semibold text-foreground">
              {data.step.id}
            </span>
            <span
              data-testid={`workflow-node-category-badge-${data.step.id}`}
              className={cn(
                'inline-flex max-w-full items-center rounded-full px-1.5 py-0.5 text-2xs font-medium',
                presentation.category === 'bot'
                  ? 'bg-primary/10 text-foreground'
                  : 'bg-muted/70 text-muted-foreground'
              )}
            >
              <span className="truncate">{presentation.categoryBadge}</span>
            </span>
            <span className="flex flex-wrap items-center gap-1 pt-0.5">
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted/65 px-1.5 py-0.5 text-2xs text-muted-foreground">
                {sessionOrAgentStep ? (
                  <StudioAgentIcon
                    agentId={sessionOrAgentStep.agentId}
                    agentOptions={data.agentOptions}
                    className="size-3"
                  />
                ) : null}
                <span className="truncate">{presentation.primarySubtitle}</span>
              </span>
              {presentation.secondaryBadge ? (
                <span className="inline-flex max-w-full items-center rounded-full border border-border bg-card px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                  <span className="truncate">{presentation.secondaryBadge}</span>
                </span>
              ) : null}
              {presentation.tabularBadge ? (
                <span
                  data-testid={`workflow-node-tabular-badge-${data.step.id}`}
                  className="inline-flex shrink-0 items-center rounded-full bg-warning/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tabular-nums text-warning"
                >
                  {presentation.tabularBadge}
                </span>
              ) : null}
            </span>
          </span>
          {data.stepRun?.status === 'completed' ? (
            <Check className="mt-1 size-3.5 shrink-0 text-success" />
          ) : null}
        </span>
      </button>

      {data.step.kind === 'trigger' ? (
        <div className="nodrag flex items-center justify-between gap-1.5 px-2.5 pb-2">
          <PulseEvalModeControl
            size="sm"
            value={data.step.evalMode}
            ariaLabel={`Trigger ${data.step.id} evaluation mode`}
            onChange={
              data.onTriggerEvalModeChange
                ? (nextMode) =>
                    data.onTriggerEvalModeChange?.(data.step.id, nextMode)
                : undefined
            }
          />
          {triggerReplayMatched !== null ? (
            <span
              data-testid={`workflow-trigger-replay-${data.step.id}`}
              className={cn(
                'rounded-full px-1.5 py-0.5 text-2xs font-semibold',
                triggerReplayMatched
                  ? 'bg-success/15 text-success'
                  : 'bg-warning/15 text-warning'
              )}
            >
              {triggerReplayMatched ? 'Matched' : 'Filtered'}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-8 items-center border-t border-border px-2.5">
        <button
          type="button"
          className="nodrag inline-flex !h-6 items-center gap-1.5 rounded-md bg-muted/70 px-2 text-2xs font-medium text-foreground hover:bg-muted"
          aria-expanded={data.logExpanded}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleLog(data.step.id);
          }}
        >
          <span
            className={cn('workflow-node-status-dot', statusDotClass(status))}
          />
          {statusLabel}
        </button>
      </div>

      {data.logExpanded ? (
        <div
          className="nodrag nowheel workflow-node-log absolute left-0 top-[calc(100%+8px)] z-30 w-[320px] rounded-lg border bg-card p-2.5 shadow-lg"
          data-testid={`workflow-node-log-${data.step.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
            <ListTree className="size-3.5" />
            {data.stepRun?.status === 'completed' ? (
              <div className="flex flex-1 items-center rounded-md bg-muted/65 p-0.5">
                {(['log', 'preview'] as const).map((view) => (
                  <button
                    type="button"
                    key={view}
                    className={cn(
                      'flex !h-6 flex-1 items-center justify-center rounded-md px-2 text-2xs font-medium',
                      logView === view
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    )}
                    onClick={() => setLogView(view)}
                  >
                    {view === 'log'
                      ? t('studio.executionLog')
                      : t('studio.previewResult')}
                  </button>
                ))}
              </div>
            ) : (
              t('studio.executionLog')
            )}
          </div>
          {data.step.kind === 'notify' ? (
            <div className="space-y-2 text-xs">
              {data.predecessorRuns.length === 0 ? (
                <p className="text-2xs text-muted-foreground">
                  {t('studio.noNotifyRecords')}
                </p>
              ) : (
                data.predecessorRuns.map((run) => (
                  <details
                    key={run.id}
                    className="rounded-md border bg-muted/20"
                    open
                  >
                    <summary className="cursor-pointer px-2 py-1.5 font-medium">
                      {t('studio.notifyRecord', {
                        step: run.stepId,
                        time: run.completedAt
                          ? new Date(run.completedAt).toLocaleString()
                          : t('studio.standby'),
                      })}
                    </summary>
                    <pre className="max-h-32 overflow-auto border-t p-2 text-2xs leading-4">
                      {run.candidateOutputJson ??
                        run.outputJson ??
                        t('studio.noPreviewResult')}
                    </pre>
                  </details>
                ))
              )}
            </div>
          ) : data.stepRun?.status === 'completed' && logView === 'preview' ? (
            <div
              className="max-h-48 overflow-auto text-xs leading-5"
              data-testid={`workflow-node-preview-${data.step.id}`}
            >
              {data.stepRun.candidateOutputJson || data.stepRun.outputJson ? (
                <AstryxMarkdown
                  value={previewMarkdown(
                    data.stepRun.candidateOutputJson ??
                      data.stepRun.outputJson ??
                      ''
                  )}
                />
              ) : (
                <p className="text-2xs text-muted-foreground">
                  {t('studio.noPreviewResult')}
                </p>
              )}
            </div>
          ) : logEvents.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              {t('studio.noExecutionLog')}
            </p>
          ) : (
            <div className="space-y-2">
              <div
                className="workflow-flame"
                data-testid={`workflow-node-flame-${data.step.id}`}
                role="img"
                aria-label={t('studio.executionLog')}
              >
                {logSpans.map((span, index) => (
                  <div
                    key={span.event.id}
                    className="workflow-flame-span"
                    style={{
                      flexGrow: span.durationMs,
                      background: `color-mix(in srgb, hsl(var(--warning)) ${100 - Math.min(index, 8) * 9}%, hsl(var(--primary)))`,
                    }}
                    title={`#${span.event.sequence.toString()} ${span.event.eventKind}`}
                  />
                ))}
              </div>
              <ol className="max-h-32 space-y-1 overflow-auto font-mono text-2xs tabular-nums">
                {logSpans.map((span) => (
                  <li key={span.event.id} className="flex gap-2">
                    <span className="text-muted-foreground">
                      #{span.event.sequence.toString()}
                    </span>
                    <span className="truncate">{span.event.eventKind}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      ) : null}

      <Handle
        id="source"
        type="source"
        position={Position.Right}
        isConnectable
        className="!size-3 !border-0"
      />
    </article>
  );
});

export const nodeTypes = { workflowStep: WorkflowStepNode };
