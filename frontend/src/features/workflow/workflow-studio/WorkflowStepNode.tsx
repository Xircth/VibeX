import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Bell, Check, GitFork, ListTree } from 'lucide-react';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { cn } from '@/lib/utils';

import { StudioAgentIcon } from './StudioAgentIcon';
import type { StudioNode } from './types';
import {
  flameSpans,
  previewMarkdown,
  statusClass,
  statusDotClass,
} from './workflowStepPresentation';

export function WorkflowStepNode({ data }: NodeProps<StudioNode>) {
  const { t } = useTranslation('workflow');
  const [logView, setLogView] = useState<'log' | 'preview'>('log');
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
          <span className="min-w-0 text-[11px] font-medium">
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
  const agentStep = data.step.kind === 'agent' ? data.step : null;
  const notifyStep = data.step.kind === 'notify' ? data.step : null;
  const status = data.stepRun?.awaitingAcceptance
    ? 'awaiting_acceptance'
    : data.stepRun?.awaitingInput
      ? 'awaiting_input'
      : data.stepRun?.status;
  const statusLabel = status
    ? t(`status.${status}`, { defaultValue: status })
    : t('studio.standby');
  let agentLabel: string;
  if (data.step.kind === 'agent') {
    const agentId = data.step.agentId;
    agentLabel =
      data.agentOptions.find((agent) => agent.value === agentId)?.label ??
      agentId;
  } else if (data.step.kind === 'notify') {
    agentLabel = data.step.title.trim() || t('studio.notify');
  } else {
    agentLabel = data.step.title;
  }
  const logEvents = data.events.filter(
    (event) =>
      event.payloadJson.includes(`"step_id":"${data.step.id}"`) ||
      event.payloadJson.includes(`"stepId":"${data.step.id}"`)
  );
  const logSpans = flameSpans(logEvents);
  return (
    <article
      className={cn(
        'workflow-studio-node group relative w-[248px] rounded-lg border bg-card text-left outline-none transition-[border-color,box-shadow,transform]',
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
        className="block !h-auto !min-h-[62px] w-full rounded-t-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        onClick={() => data.onSelect(data.step.id)}
        aria-pressed={data.selected}
        aria-label={`${data.step.id} ${
          data.step.kind === 'agent' ? data.step.agentId : data.step.title
        }`}
      >
        <span className="flex items-start gap-3 p-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/45 text-muted-foreground">
            {agentStep ? (
              <StudioAgentIcon
                agentId={agentStep.agentId}
                agentOptions={data.agentOptions}
                className="size-4"
              />
            ) : notifyStep ? (
              <Bell className="size-4" />
            ) : (
              <GitFork className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-foreground">
              {data.step.id}
            </span>
            <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {agentStep ? (
                <StudioAgentIcon
                  agentId={agentStep.agentId}
                  agentOptions={data.agentOptions}
                  className="size-3"
                />
              ) : notifyStep ? (
                <Bell className="size-3" />
              ) : null}
              <span className="truncate">{agentLabel}</span>
            </span>
          </span>
          {data.stepRun?.status === 'completed' ? (
            <Check className="mt-1 size-3.5 text-emerald-600" />
          ) : null}
        </span>
      </button>
      <div className="flex min-h-8 items-center border-t px-2.5">
        <button
          type="button"
          className="nodrag inline-flex !h-6 items-center gap-1.5 rounded-full bg-muted/70 px-2 text-[10px] font-medium text-foreground hover:bg-muted"
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
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
            <ListTree className="size-3.5" />
            {data.stepRun?.status === 'completed' ? (
              <div className="flex flex-1 items-center rounded-md bg-muted/65 p-0.5">
                {(['log', 'preview'] as const).map((view) => (
                  <button
                    type="button"
                    key={view}
                    className={cn(
                      'flex !h-6 flex-1 items-center justify-center rounded-md px-2 text-[10px] font-medium',
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
            <div className="space-y-2 text-[11px]">
              {data.predecessorRuns.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
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
                    <pre className="max-h-32 overflow-auto border-t p-2 text-[10px] leading-4">
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
              className="max-h-48 overflow-auto text-[11px] leading-5"
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
                <p className="text-[10px] text-muted-foreground">
                  {t('studio.noPreviewResult')}
                </p>
              )}
            </div>
          ) : logEvents.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
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
                      background: `hsl(${28 - Math.min(index, 8) * 3} 86% ${62 - Math.min(index, 8) * 4}%)`,
                    }}
                    title={`#${span.event.sequence.toString()} ${span.event.eventKind}`}
                  />
                ))}
              </div>
              <ol className="max-h-32 space-y-1 overflow-auto font-mono text-[10px]">
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
}

export const nodeTypes = { workflowStep: WorkflowStepNode };
