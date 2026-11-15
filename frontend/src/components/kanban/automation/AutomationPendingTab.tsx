import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import {
  pixel,
  proportional,
  resolveColumnWidths,
  Table,
  TableBody,
  TableCell,
  TableRow,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Eye,
  Play,
  Rocket,
} from 'lucide-react';
import type {
  EventEnvelope,
  PulseDryRunReport,
  PulseObservedCandidateView,
  PulseUserInteractionView,
} from '@/lib/api/pulse';
import { PulseInteractionCard } from '../pulseInteractionForm';
import {
  AutomationSplitFrame,
  groupHeaderCell,
  interactiveRowStyle,
  selectedTableRowStyle,
} from './AutomationSplitFrame';

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
  renderHeader?: (
    toolbarRow?: ReactNode,
    contextualAction?: ReactNode
  ) => ReactNode;
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
  renderHeader,
  pendingInteractions,
  observedCandidates,
  inspectedCandidateId,
  inspectedReport,
  onInspectCandidateDryRun,
  onPromoteCandidate,
  onPromoteAndEditTask,
  onInteractionResolved,
}: AutomationPendingTabProps) {
  const { t, i18n } = useTranslation('panels');
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(['interaction', 'observed'])
  );

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

  const grouped = useMemo(() => {
    const map = new Map<'interaction' | 'observed', PendingQueueItem[]>([
      ['interaction', []],
      ['observed', []],
    ]);
    for (const item of items) {
      map.get(item.kind)?.push(item);
    }
    return map;
  }, [items]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const columns = useMemo<TableColumn<Record<string, unknown>>[]>(
    () => [
      {
        key: 'title',
        header: t('pulseDeck.workbench.pending.colItem'),
        width: proportional(1.2),
      },
      {
        key: 'source',
        header: t('pulseDeck.workbench.pending.colSource'),
        width: proportional(1),
      },
      {
        key: 'time',
        header: t('pulseDeck.workbench.pending.colTime'),
        width: pixel(104),
      },
    ],
    [t, i18n.language]
  );

  const resolvedWidths = useMemo(
    () => resolveColumnWidths(columns),
    [columns]
  );

  const filterControl = (
    <SegmentedControl
      size="sm"
      value={filter}
      onChange={(val) => setFilter(val as QueueFilter)}
      label={t('pulseDeck.workbench.primaryTabs.pending')}
    >
      <SegmentedControlItem
        value="all"
        label={t('pulseDeck.workbench.pending.filterAll')}
        data-testid="pending-filter-all"
      />
      <SegmentedControlItem
        value="interactions"
        label={t('pulseDeck.workbench.pending.filterInteractions')}
        data-testid="pending-filter-interactions"
      />
      <SegmentedControlItem
        value="observed"
        label={t('pulseDeck.workbench.pending.filterObserved')}
        data-testid="pending-filter-observed"
      />
    </SegmentedControl>
  );

  const masterPane = (
    <div data-testid="automation-pending-queue" className="min-h-0 flex-1">
      {items.length === 0 ? (
        <div className="p-8">
          <EmptyState
            icon={<Icon icon={Bell} size="lg" color="secondary" />}
            title={t('pulseDeck.workbench.pending.emptyQueue')}
          />
        </div>
      ) : (
        <Table
          columns={columns}
          density="balanced"
          dividers="rows"
          textOverflow="truncate"
          hasHover
        >
          <colgroup>
            {columns.map((col) => (
              <col
                key={col.key}
                style={resolvedWidths.columns.get(col.key)?.style}
              />
            ))}
          </colgroup>
          <TableBody>
            {(['interaction', 'observed'] as const).map((groupKey) => {
              const groupItems = grouped.get(groupKey);
              if (!groupItems || groupItems.length === 0) return null;
              const isExpanded = expandedGroups.has(groupKey);
              const groupTitle =
                groupKey === 'interaction'
                  ? t('pulseDeck.workbench.pending.groupInteractions')
                  : t('pulseDeck.workbench.pending.groupObserved');

              return (
                <Fragment key={groupKey}>
                  <TableRow
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(groupKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(groupKey);
                      }
                    }}
                  >
                    <TableCell
                      colSpan={columns.length}
                      style={groupHeaderCell}
                    >
                      <HStack gap={2} vAlign="center">
                        <Icon
                          icon={isExpanded ? ChevronDown : ChevronRight}
                          size="sm"
                          color="secondary"
                        />
                        <Icon
                          icon={groupKey === 'interaction' ? Bell : Eye}
                          size="sm"
                          color="secondary"
                        />
                        <Text type="body" weight="bold">
                          {groupTitle}
                        </Text>
                        <Badge
                          variant={
                            groupKey === 'interaction' ? 'warning' : 'neutral'
                          }
                          label={String(groupItems.length)}
                          className="tabular-nums"
                        />
                      </HStack>
                    </TableCell>
                  </TableRow>

                  {isExpanded &&
                    groupItems.map((item) => {
                      const active = selectedItem?.key === item.key;
                      const rowStyle = active
                        ? { ...interactiveRowStyle, ...selectedTableRowStyle }
                        : interactiveRowStyle;

                      if (item.kind === 'interaction') {
                        const ix = item.interaction;
                        return (
                          <TableRow
                            key={item.key}
                            data-testid={`pending-item-ix-${ix.id}`}
                            style={rowStyle}
                            onClick={() => setSelectedKey(item.key)}
                          >
                            <TableCell>
                              <HStack gap={2} vAlign="center">
                                <StatusDot
                                  variant="warning"
                                  label={t(
                                    'pulseDeck.workbench.pending.badgeInteraction'
                                  )}
                                />
                                <Text
                                  type="body"
                                  weight="medium"
                                  maxLines={1}
                                >
                                  {ix.title}
                                </Text>
                              </HStack>
                            </TableCell>
                            <TableCell>
                              <Text
                                type="supporting"
                                color="secondary"
                                maxLines={1}
                              >
                                {ix.body || ix.kind}
                              </Text>
                            </TableCell>
                            <TableCell>
                              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                                {ix.createdAt.slice(11, 19)}
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      }

                      const cand = item.candidate;
                      return (
                        <TableRow
                          key={item.key}
                          data-testid={`pending-item-cand-${cand.id}`}
                          style={rowStyle}
                          onClick={() => setSelectedKey(item.key)}
                        >
                          <TableCell>
                            <HStack gap={2} vAlign="center">
                              <StatusDot
                                variant="accent"
                                label={t(
                                  'pulseDeck.workbench.pending.badgeObserved'
                                )}
                              />
                              <Text type="body" weight="medium" maxLines={1}>
                                {cand.summary}
                              </Text>
                            </HStack>
                          </TableCell>
                          <TableCell>
                            <Text
                              type="supporting"
                              color="secondary"
                              maxLines={1}
                            >
                              {cand.ruleName} · {cand.eventType}
                            </Text>
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                              {cand.occurredAt.slice(11, 19)}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );

  const detailPane = selectedItem ? (
    selectedItem.kind === 'interaction' ? (
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
          <pre className="max-h-64 overflow-auto rounded-md bg-[var(--color-background-muted)] p-3 font-mono text-2xs text-muted-foreground">
            {JSON.stringify(selectedItem.interaction, null, 2)}
          </pre>
        </div>
      </div>
    ) : (
      <div
        data-testid={`pending-candidate-detail-${selectedItem.candidate.id}`}
      >
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={3}>{selectedItem.candidate.summary}</Heading>
            <Text type="supporting" color="secondary">
              {selectedItem.candidate.ruleName} ·{' '}
              {selectedItem.candidate.eventType}
              {selectedItem.candidate.threadKey
                ? ` · ${selectedItem.candidate.threadKey}`
                : ''}
            </Text>
          </VStack>

          <HStack gap={2} vAlign="center" wrap="wrap">
            <AstryxButton
              label={t('pulseDeck.inspectDryRun')}
              variant="secondary"
              size="sm"
              icon={<Icon icon={Play} size="sm" />}
              data-testid={`pulse-candidate-inspect-${selectedItem.candidate.id}`}
              onClick={() => onInspectCandidateDryRun(selectedItem.candidate)}
            />
            <AstryxButton
              label={t('pulseDeck.promoteToAuto')}
              variant="secondary"
              size="sm"
              icon={<Icon icon={Rocket} size="sm" />}
              data-testid={`pulse-candidate-promote-${selectedItem.candidate.id}`}
              onClick={() => onPromoteCandidate(selectedItem.candidate)}
            />
            <AstryxButton
              label={t('pulseDeck.workbench.pending.promoteCreateTask')}
              variant="primary"
              size="sm"
              data-testid={`pulse-candidate-create-task-${selectedItem.candidate.id}`}
              onClick={() => onPromoteAndEditTask(selectedItem.candidate)}
            />
          </HStack>

          {inspectedCandidateId === selectedItem.candidate.id &&
          inspectedReport ? (
            <div
              data-testid={`pulse-candidate-dryrun-${selectedItem.candidate.id}`}
              className="rounded-md bg-[var(--color-background-muted)] p-3 text-xs"
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
            <pre className="max-h-72 overflow-auto rounded-md bg-[var(--color-background-muted)] p-3 font-mono text-2xs text-muted-foreground">
              {JSON.stringify(
                buildCandidateEnvelope(selectedItem.candidate),
                null,
                2
              )}
            </pre>
          </div>
        </VStack>
      </div>
    )
  ) : null;

  return (
    <AutomationSplitFrame
      testId="automation-tab-pending-split"
      header={renderHeader?.(undefined, filterControl)}
      master={masterPane}
      detail={detailPane}
    />
  );
}
