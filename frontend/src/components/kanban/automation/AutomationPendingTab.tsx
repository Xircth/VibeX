import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Eye, Play, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  EventEnvelope,
  PulseDryRunReport,
  PulseObservedCandidateView,
  PulseUserInteractionView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { PulseInteractionCard } from '../pulseInteractionForm';
import { AutomationSplitFrame } from './AutomationSplitFrame';

type QueueFilter = 'all' | 'interactions' | 'observed';

type PendingQueueItem =
  | {
      key: string;
      kind: 'interaction';
      interaction: PulseUserInteractionView;
    }
  | {
      key: string;
      kind: 'observed';
      candidate: PulseObservedCandidateView;
    };

export function buildCandidateEnvelope(
  candidate: PulseObservedCandidateView
): EventEnvelope {
  return {
    eventId: candidate.eventId,
    deliveryId: `dlv-${candidate.id}`,
    source: {
      kind: candidate.sourceKind,
      instanceId: `${candidate.sourceKind}-observed`,
      trustLevel: 'verified_external',
    },
    eventType: candidate.eventType,
    occurredAt: candidate.occurredAt,
    actor: {
      id: 'external-actor',
      displayName: 'External Event',
      roles: [],
      isBot: false,
      isSelf: false,
    },
    threadKey: candidate.threadKey ?? null,
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: candidate.eventId,
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      summary: candidate.summary,
    },
  };
}

export interface AutomationPendingTabProps {
  pendingInteractions: readonly PulseUserInteractionView[];
  observedCandidates: readonly PulseObservedCandidateView[];
  inspectedCandidateId: string | null;
  inspectedReport: PulseDryRunReport | null;
  onInspectCandidateDryRun: (candidate: PulseObservedCandidateView) => void;
  onPromoteCandidate: (candidate: PulseObservedCandidateView) => void;
  onPromoteAndEditTask: (candidate: PulseObservedCandidateView) => void;
  onInteractionResolved: (interactionId: string) => void;
}

export function AutomationPendingTab({
  pendingInteractions,
  observedCandidates,
  inspectedCandidateId,
  inspectedReport,
  onInspectCandidateDryRun,
  onPromoteCandidate,
  onPromoteAndEditTask,
  onInteractionResolved,
}: AutomationPendingTabProps) {
  const { t } = useTranslation('panels');
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const items = useMemo<PendingQueueItem[]>(() => {
    const list: PendingQueueItem[] = [];
    if (filter === 'all' || filter === 'interactions') {
      for (const ix of pendingInteractions) {
        list.push({
          key: `ix:${ix.id}`,
          kind: 'interaction',
          interaction: ix,
        });
      }
    }
    if (filter === 'all' || filter === 'observed') {
      for (const cand of observedCandidates) {
        if (!cand.promoted) {
          list.push({
            key: `cand:${cand.id}`,
            kind: 'observed',
            candidate: cand,
          });
        }
      }
    }
    return list;
  }, [filter, observedCandidates, pendingInteractions]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !items.some((item) => item.key === selectedKey)) {
      setSelectedKey(items[0]!.key);
    }
  }, [items, selectedKey]);

  const selectedItem =
    items.find((item) => item.key === selectedKey) ?? items[0] ?? null;

  const masterPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="inline-flex items-center rounded-md border border-border bg-[var(--surface-control)] p-0.5">
          {(
            [
              {
                id: 'all',
                label: t('pulseDeck.workbench.pending.filterAll'),
              },
              {
                id: 'interactions',
                label: t('pulseDeck.workbench.pending.filterInteractions'),
              },
              {
                id: 'observed',
                label: t('pulseDeck.workbench.pending.filterObserved'),
              },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`pending-filter-${tab.id}`}
                aria-pressed={active}
                onClick={() => setFilter(tab.id)}
                className={cn(
                  'rounded px-2 py-0.5 text-2xs font-medium transition-colors',
                  active
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <span className="text-2xs font-medium tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </div>

      <div
        data-testid="automation-pending-queue"
        className="flex-1 divide-y divide-border overflow-y-auto"
      >
        {items.length === 0 ? (
          <div className="p-5 text-xs text-muted-foreground">
            {t('pulseDeck.workbench.pending.emptyQueue')}
          </div>
        ) : (
          items.map((item) => {
            const active = selectedItem?.key === item.key;
            if (item.kind === 'interaction') {
              const ix = item.interaction;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`pending-item-ix-${ix.id}`}
                  onClick={() => setSelectedKey(item.key)}
                  className={cn(
                    'flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors',
                    active
                      ? 'bg-[var(--surface-elevated)]'
                      : 'hover:bg-[var(--surface-control)]/50'
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 rounded border border-warning/35 bg-warning/10 px-1.5 py-0.5 text-2xs font-medium text-foreground">
                      <Bell className="h-3 w-3 shrink-0" />
                      {t('pulseDeck.workbench.pending.badgeInteraction')}
                    </span>
                    <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                      {ix.createdAt.slice(11, 19)}
                    </span>
                  </div>
                  <div className="w-full truncate text-xs font-medium text-foreground">
                    {ix.title}
                  </div>
                  {ix.body ? (
                    <div className="w-full truncate text-2xs text-muted-foreground">
                      {ix.body}
                    </div>
                  ) : null}
                </button>
              );
            }

            const cand = item.candidate;
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`pending-item-cand-${cand.id}`}
                onClick={() => setSelectedKey(item.key)}
                className={cn(
                  'flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'bg-[var(--surface-elevated)]'
                    : 'hover:bg-[var(--surface-control)]/50'
                )}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 rounded border border-border bg-[var(--surface-control)] px-1.5 py-0.5 text-2xs font-medium text-foreground">
                    <Eye className="h-3 w-3 shrink-0" />
                    {t('pulseDeck.workbench.pending.badgeObserved')}
                  </span>
                  <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                    {cand.occurredAt.slice(11, 19)}
                  </span>
                </div>
                <div className="w-full truncate text-xs font-medium text-foreground">
                  {cand.summary}
                </div>
                <div className="w-full truncate font-mono text-2xs text-muted-foreground">
                  {cand.ruleName} · {cand.eventType}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  const detailPane = (
    <div className="flex flex-1 flex-col gap-4 p-4">
      {!selectedItem ? (
        <div className="text-xs text-muted-foreground">
          {t('pulseDeck.workbench.pending.selectHint')}
        </div>
      ) : selectedItem.kind === 'interaction' ? (
        <div
          data-testid="pulse-deck-interactions-section"
          className="space-y-4"
        >
          <PulseInteractionCard
            key={selectedItem.interaction.id}
            interaction={selectedItem.interaction}
            onResolved={onInteractionResolved}
          />
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium text-foreground">
              {t('pulseDeck.workbench.pending.payloadTitle')}
            </h4>
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-[var(--surface-panel)] p-3 font-mono text-2xs text-muted-foreground">
              {JSON.stringify(selectedItem.interaction, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div
          data-testid={`pending-candidate-detail-${selectedItem.candidate.id}`}
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {selectedItem.candidate.summary}
              </h3>
              <p className="font-mono text-2xs text-muted-foreground">
                {selectedItem.candidate.ruleName} ·{' '}
                {selectedItem.candidate.eventType}
                {selectedItem.candidate.threadKey
                  ? ` · ${selectedItem.candidate.threadKey}`
                  : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={`pulse-candidate-inspect-${selectedItem.candidate.id}`}
                onClick={() =>
                  onInspectCandidateDryRun(selectedItem.candidate)
                }
              >
                <Play className="mr-1 h-3.5 w-3.5" />
                {t('pulseDeck.inspectDryRun')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={`pulse-candidate-promote-${selectedItem.candidate.id}`}
                onClick={() => onPromoteCandidate(selectedItem.candidate)}
              >
                <Rocket className="mr-1 h-3.5 w-3.5" />
                {t('pulseDeck.promoteToAuto')}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid={`pulse-candidate-create-task-${selectedItem.candidate.id}`}
                onClick={() => onPromoteAndEditTask(selectedItem.candidate)}
              >
                {t('pulseDeck.workbench.pending.promoteCreateTask')}
              </Button>
            </div>
          </div>

          {inspectedCandidateId === selectedItem.candidate.id &&
          inspectedReport ? (
            <div
              data-testid={`pulse-candidate-dryrun-${selectedItem.candidate.id}`}
              className="rounded-md border border-border bg-[var(--surface-panel)] p-3 text-xs"
            >
              <div className="font-medium text-foreground">
                {t('pulseDeck.dryRunEvaluation')} ·{' '}
                {inspectedReport.matched
                  ? t('pulseDeck.matched')
                  : t('pulseDeck.filtered')}
              </div>
              {inspectedReport.renderedPreviews.map((preview, idx) => (
                <pre
                  key={idx}
                  className="mt-1.5 overflow-x-auto font-mono text-2xs text-muted-foreground"
                >
                  {preview}
                </pre>
              ))}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <h4 className="text-xs font-medium text-foreground">
              {t('pulseDeck.workbench.pending.payloadTitle')}
            </h4>
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-[var(--surface-panel)] p-3 font-mono text-2xs text-muted-foreground">
              {JSON.stringify(
                buildCandidateEnvelope(selectedItem.candidate),
                null,
                2
              )}
            </pre>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <AutomationSplitFrame
      testId="automation-tab-pending-split"
      master={masterPane}
      detail={detailPane}
    />
  );
}
