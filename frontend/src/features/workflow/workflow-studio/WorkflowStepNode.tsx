import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Handle,
  Position,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  Bell,
  Check,
  Clock,
  GitFork,
  ListTree,
  MoreHorizontal,
  Repeat,
  Send,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import { cn } from '@/lib/utils';

import { StudioAgentIcon } from './StudioAgentIcon';
import {
  CONFIRMATION_NODE_HEIGHT,
  CONFIRMATION_NODE_WIDTH,
  WORKFLOW_NODE_WIDTH,
  type StudioNode,
} from './types';
import { getStepOutputPorts, type StudioPortAccent } from './workflowPorts';
import {
  describeStepPresentation,
  flameSpans,
  previewMarkdown,
  statusClass,
  statusDotClass,
} from './workflowStepPresentation';

function portPillClass(accent: StudioPortAccent): string {
  switch (accent) {
    case 'success':
      return 'border-success/30 bg-success/12 text-success';
    case 'warning':
      return 'border-warning/35 bg-warning/15 text-warning';
    case 'destructive':
      return 'border-destructive/30 bg-destructive/12 text-destructive';
    case 'primary':
      return 'border-primary/30 bg-primary/12 text-primary';
    case 'default':
      return 'border-border bg-card text-muted-foreground';
  }
}

export const WorkflowStepNode = memo(function WorkflowStepNode({
  id,
  data,
}: NodeProps<StudioNode>) {
  const { t, i18n } = useTranslation('workflow');
  const articleRef = useRef<HTMLElement | null>(null);
  const prevPortSignatureRef = useRef<string | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const storeApi = useStoreApi();
  const [logView, setLogView] = useState<'log' | 'preview'>('log');

  const outputPorts = useMemo(
    () => getStepOutputPorts(data.step, t),
    [data.step, t]
  );
  const isMultiPort = !data.confirmationFor && outputPorts.length > 1;
  const hasTargetPort =
    Boolean(data.confirmationFor) || data.step.kind !== 'trigger';
  const portSignature = data.confirmationFor
    ? 'confirm:target|source'
    : `${hasTargetPort ? 'target' : 'none'}|${outputPorts
        .map((port) => port.id)
        .join(',')}`;

  const needsHeadlessBounds = useStore(
    useCallback(
      (s) => {
        const node = s.nodeLookup.get(id);
        return Boolean(node && !node.internals.handleBounds);
      },
      [id]
    )
  );

  useEffect(() => {
    const element = articleRef.current;
    if (!element) return;

    if (element.offsetWidth > 0 || element.offsetHeight > 0) {
      if (prevPortSignatureRef.current !== portSignature) {
        prevPortSignatureRef.current = portSignature;
        updateNodeInternals(id);
      }
      return;
    }

    const state = storeApi.getState();
    const internal = state.nodeLookup.get(id);
    if (!internal) return;
    if (
      internal.internals.handleBounds &&
      prevPortSignatureRef.current === portSignature
    ) {
      return;
    }
    prevPortSignatureRef.current = portSignature;

    const width =
      internal.initialWidth ??
      (data.confirmationFor ? CONFIRMATION_NODE_WIDTH : WORKFLOW_NODE_WIDTH);
    const height =
      internal.initialHeight ??
      (data.confirmationFor ? CONFIRMATION_NODE_HEIGHT : 124);
    const source: Array<{
      id: string | null;
      type: 'source';
      nodeId: string;
      position: Position;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const target: Array<{
      id: string | null;
      type: 'target';
      nodeId: string;
      position: Position;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    let sourceIndex = 0;
    element
      .querySelectorAll<HTMLElement>('.react-flow__handle')
      .forEach((handleEl) => {
        const handleId = handleEl.getAttribute('data-handleid');
        const positionAttr = handleEl.getAttribute(
          'data-handlepos'
        ) as Position | null;
        if (handleEl.classList.contains('source')) {
          source.push({
            id: handleId,
            type: 'source',
            nodeId: id,
            position: positionAttr ?? Position.Right,
            x: width - 8,
            y: data.confirmationFor
              ? 18
              : isMultiPort
                ? 96 + sourceIndex * 28
                : 38,
            width: 8,
            height: 8,
          });
          sourceIndex += 1;
        } else {
          target.push({
            id: handleId,
            type: 'target',
            nodeId: id,
            position: positionAttr ?? Position.Left,
            x: 0,
            y: data.confirmationFor ? 18 : 38,
            width: 8,
            height: 8,
          });
        }
      });

    const userNodeMeasured = Boolean(
      internal.internals.userNode.measured?.width &&
        internal.internals.userNode.measured?.height
    );
    const nextLookup = new Map(state.nodeLookup);
    nextLookup.set(id, {
      ...internal,
      measured: { width, height },
      internals: {
        ...internal.internals,
        handleBounds: { source, target },
      },
    });
    storeApi.setState({ nodeLookup: nextLookup });
    if (!userNodeMeasured) {
      state.triggerNodeChanges([
        { id, type: 'dimensions', dimensions: { width, height } },
      ]);
    }
  }, [
    data.confirmationFor,
    id,
    isMultiPort,
    needsHeadlessBounds,
    portSignature,
    storeApi,
    updateNodeInternals,
  ]);

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
        ref={articleRef}
        className={cn(
          'workflow-confirmation-node relative flex h-11 w-[148px] items-center gap-2 px-3 text-left',
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
          title={t('ports.targetInputTooltip')}
          aria-label={t('ports.targetInputTooltip')}
          onClick={(event) => event.stopPropagation()}
          className="nodrag nopan workflow-port-handle"
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
          onClick={() => data.onSelect(data.confirmationFor!)}
          aria-label={
            waiting
              ? t('studio.confirmationRequired')
              : t('studio.confirmation')
          }
        >
          <span
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-[6px]',
              completed
                ? 'workflow-node-kind-outbox_action'
                : waiting
                  ? 'workflow-node-kind-user_gate'
                  : 'workflow-node-tag'
            )}
          >
            <Check className="size-3" />
          </span>
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
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
          title={t('ports.sourceOutputTooltip')}
          aria-label={t('ports.sourceOutputTooltip')}
          onClick={(event) => event.stopPropagation()}
          className="nodrag nopan workflow-port-handle"
        />
      </article>
    );
  }

  const presentation = describeStepPresentation(
    data.step,
    data.agentOptions,
    t('studio.notify'),
    t,
    {
      bots: data.bots,
      spaces: data.spaces,
      language: i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN',
    }
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

  const fanInCount = data.step.dependsOn.length;
  const joinMode = data.step.joinMode ?? 'all';
  const totalOutgoing = data.totalOutgoingCount ?? 0;

  const renderKindGlyph = () => {
    switch (presentation.category) {
      case 'trigger':
        return data.step.kind === 'trigger' &&
          data.step.triggerKind === 'temporal' ? (
          <Clock className="size-3" />
        ) : (
          <Zap className="size-3" />
        );
      case 'group_stage':
        return <Users className="size-3" />;
      case 'user_gate':
        return data.step.kind === 'notify' ||
          (data.step.kind === 'user_gate' &&
            data.step.interactionKind === 'notify') ? (
          <Bell className="size-3" />
        ) : (
          <ShieldCheck className="size-3" />
        );
      case 'control':
        return data.step.kind === 'control' &&
          data.step.controlKind === 'bounded_loop' ? (
          <Repeat className="size-3" />
        ) : data.step.kind === 'control' &&
          data.step.controlKind === 'wait_for_event' ? (
          <Clock className="size-3" />
        ) : (
          <GitFork className="size-3" />
        );
      case 'outbox_action':
        return <Send className="size-3" />;
      case 'bot':
      case 'session':
        return null;
    }
  };

  return (
    <article
      ref={articleRef}
      data-testid={`workflow-node-${data.step.id}`}
      data-node-category={presentation.category}
      className={cn(
        'workflow-studio-node group relative w-[280px] text-left outline-none',
        data.selected && 'workflow-node-selected',
        statusClass(data.stepRun?.status)
      )}
    >
      {hasTargetPort ? (
        <Handle
          id="target"
          type="target"
          position={Position.Left}
          isConnectable
          title={t('ports.targetInputTooltip')}
          aria-label={`${presentation.headline} ${t('ports.targetInputTooltip')}`}
          data-testid={`workflow-port-${data.step.id}-target`}
          onClick={(event) => event.stopPropagation()}
          className="nodrag nopan workflow-port-handle workflow-port-deck-anchor"
        />
      ) : null}

      <button
        type="button"
        data-testid={`workflow-node-deck-${data.step.id}`}
        className="workflow-node-deck block !h-auto w-full px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        onClick={() => data.onSelect(data.step.id)}
        aria-pressed={data.selected}
        aria-label={presentation.accessibleSummary}
      >
        <span className="flex min-h-5 items-center gap-1.5">
          {sessionOrAgentStep ? (
            <span
              data-testid={`workflow-node-category-badge-${data.step.id}`}
              className="workflow-node-chip inline-flex h-5 max-w-[188px] items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] font-medium leading-none text-foreground"
            >
              <StudioAgentIcon
                agentId={sessionOrAgentStep.agentId}
                agentOptions={data.agentOptions}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{presentation.identityBadge}</span>
            </span>
          ) : presentation.category === 'bot' && presentation.botAvatar ? (
            <span
              data-testid={`workflow-node-category-badge-${data.step.id}`}
              className="workflow-node-chip inline-flex h-5 max-w-[188px] items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] font-medium leading-none text-foreground"
            >
              <MemberBotAvatar
                config={presentation.botAvatar}
                animated={false}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{presentation.identityBadge}</span>
            </span>
          ) : (
            <span
              data-testid={`workflow-node-category-badge-${data.step.id}`}
              className="workflow-node-chip inline-flex h-5 max-w-[188px] items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] font-medium leading-none text-foreground"
            >
              <span
                className={cn(
                  'grid size-3.5 shrink-0 place-items-center rounded-[4px]',
                  `workflow-node-kind-${presentation.category}`
                )}
              >
                {renderKindGlyph()}
              </span>
              <span className="truncate">{presentation.identityBadge}</span>
            </span>
          )}

          {presentation.detailBadge ? (
            <span className="workflow-node-tag inline-flex h-5 min-w-0 items-center rounded-[6px] px-1.5 text-[10.5px] leading-none text-muted-foreground tabular-nums">
              <span className="truncate">{presentation.detailBadge}</span>
            </span>
          ) : null}

          {presentation.tabularBadge ? (
            <span
              data-testid={`workflow-node-tabular-badge-${data.step.id}`}
              className="inline-flex h-5 shrink-0 items-center rounded-full bg-primary/12 px-1.5 text-[10.5px] font-semibold tabular-nums text-primary"
            >
              {presentation.tabularBadge}
            </span>
          ) : null}

          {data.stepRun?.status === 'completed' ? (
            <Check className="ml-auto size-3.5 shrink-0 text-success" />
          ) : (
            <MoreHorizontal
              aria-hidden="true"
              className="ml-auto size-3.5 shrink-0 text-muted-foreground/55 transition-colors duration-150 group-hover:text-foreground"
            />
          )}
        </span>

        <span className="mt-2 line-clamp-2 block min-h-[18px] text-[13px] font-semibold leading-[18px] tracking-[-0.005em] text-foreground">
          {presentation.headline}
        </span>
      </button>

      <div
        data-testid={`workflow-node-tray-${data.step.id}`}
        className="space-y-1.5 py-2"
      >
        {isMultiPort ? (
          <div
            data-testid={`workflow-node-ports-${data.step.id}`}
            className="space-y-1 pt-0.5"
          >
            {outputPorts.map((port) => {
              const portOutCount = data.outgoingCounts?.[port.id] ?? 0;
              return (
                <div
                  key={port.id}
                  className="relative flex min-h-6 items-center justify-end gap-1.5 px-3"
                >
                  {portOutCount >= 2 ? (
                    <span
                      data-testid={`workflow-fan-out-badge-${data.step.id}-${port.id}`}
                      title={t('ports.fanOutBadgeTooltip', {
                        count: portOutCount,
                      })}
                      className="workflow-node-tag inline-flex h-5 items-center rounded-[6px] px-1.5 font-mono text-[10.5px] font-semibold tabular-nums text-muted-foreground"
                    >
                      {t('ports.fanOutCount', { count: portOutCount })}
                    </span>
                  ) : null}
                  <span
                    data-testid={`workflow-port-pill-${data.step.id}-${port.id}`}
                    className={cn(
                      'inline-flex h-[21px] items-center rounded-[6px] border px-2 text-[11px] font-medium leading-none',
                      portPillClass(port.accent)
                    )}
                  >
                    {port.label}
                  </span>
                  <Handle
                    id={port.id}
                    type="source"
                    position={Position.Right}
                    isConnectable
                    title={port.tooltip}
                    aria-label={`${presentation.headline} ${port.label}`}
                    data-testid={`workflow-port-${data.step.id}-${port.id}`}
                    onClick={(event) => event.stopPropagation()}
                    className={cn(
                      'nodrag nopan workflow-port-handle',
                      `workflow-port-accent-${port.accent}`
                    )}
                  />
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="flex min-h-6 items-center justify-between gap-1.5 px-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {fanInCount >= 2 ? (
              <span
                data-testid={`workflow-fan-in-badge-${data.step.id}`}
                className="inline-flex h-[21px] shrink-0 items-center rounded-[6px] bg-primary/12 px-1.5 text-[11px] font-semibold tabular-nums text-primary"
              >
                {t(
                  joinMode === 'any'
                    ? 'ports.fanInBadgeAny'
                    : 'ports.fanInBadgeAll',
                  { count: fanInCount }
                )}
              </span>
            ) : null}
            <button
              type="button"
              className="nodrag workflow-node-tag inline-flex !h-[22px] items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
              aria-expanded={data.logExpanded}
              onClick={(event) => {
                event.stopPropagation();
                data.onToggleLog(data.step.id);
              }}
            >
              <span
                className={cn(
                  'workflow-node-status-dot',
                  statusDotClass(status)
                )}
              />
              <span>{statusLabel}</span>
            </button>
          </div>
          {!isMultiPort && totalOutgoing >= 2 ? (
            <span
              data-testid={`workflow-fan-out-badge-${data.step.id}`}
              title={t('ports.fanOutBadgeTooltip', { count: totalOutgoing })}
              className="workflow-node-tag inline-flex h-[21px] shrink-0 items-center rounded-[6px] px-1.5 font-mono text-[10.5px] font-semibold tabular-nums text-muted-foreground"
            >
              {t('ports.fanOutCount', { count: totalOutgoing })}
            </span>
          ) : null}
        </div>
      </div>

      {data.logExpanded ? (
        <div
          className="nodrag nowheel workflow-node-log absolute left-0 top-[calc(100%+10px)] z-30 w-[320px] rounded-[14px] border bg-card p-3 shadow-lg"
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
                    <pre className="max-h-32 overflow-auto p-2 text-2xs leading-4">
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

      {!isMultiPort ? (
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          isConnectable
          title={outputPorts[0]?.tooltip ?? t('ports.sourceOutputTooltip')}
          aria-label={`${presentation.headline} ${
            outputPorts[0]?.tooltip ?? t('ports.sourceOutputTooltip')
          }`}
          data-testid={`workflow-port-${data.step.id}-source`}
          onClick={(event) => event.stopPropagation()}
          className="nodrag nopan workflow-port-handle workflow-port-deck-anchor"
        />
      ) : null}
    </article>
  );
});

export const nodeTypes = { workflowStep: WorkflowStepNode };
