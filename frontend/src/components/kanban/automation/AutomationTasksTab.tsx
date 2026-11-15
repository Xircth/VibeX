import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
import { Popover } from '@astryxdesign/core/Popover';
import {
  PowerSearch,
  type PowerSearchConfig,
  type PowerSearchFilter,
} from '@astryxdesign/core/PowerSearch';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Switch } from '@/components/ui/switch';
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
import { Text } from '@astryxdesign/core/Text';
import {
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronRight,
  Clock3,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Play,
  Sparkles,
  Ticket,
  Trash2,
  Users,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import type { CollaborationBotOption } from '@/features/workflow/useCollaborationBotRoster';
import type { WorkflowStudioAgentOption } from '@/features/workflow/workflowAgent';
import { StudioAgentIcon } from '@/features/workflow/workflow-studio/StudioAgentIcon';
import type {
  EventSourceKind,
  PulseSourceView,
  PulseUserInteractionView,
} from '@/lib/api/pulse';

import { PulseInteractionCard } from '../pulseInteractionForm';
import { AutomationAgentComposerPopover } from './AutomationAgentComposerPopover';
import {
  CANONICAL_WORKFLOW_STARTERS,
  type CanonicalWorkflowStarter,
  type DispatchedAutomationAgentSession,
} from './automationAgentBridge';
import {
  AutomationSplitFrame,
  groupHeaderCell,
  interactiveRowStyle,
  TaskStatusBadge,
} from './AutomationSplitFrame';
import type {
  AutomationGovernanceGroup,
  AutomationTaskStatus,
  TaskChainActor,
  UnifiedAutomationTask,
} from './automationModels';

type TaskGroupBy = 'governance' | 'none';

const GOVERNANCE_GROUP_ORDER: readonly AutomationGovernanceGroup[] = [
  'needs_attention',
  'active',
  'paused',
];

const STATUS_FILTER_ORDER: readonly AutomationTaskStatus[] = [
  'awaiting_approval',
  'running',
  'active',
  'paused',
  'draft',
];

function resolveSourceIcon(kind: EventSourceKind | (string & {})): LucideIcon {
  switch (kind) {
    case 'github':
      return GitPullRequest;
    case 'feishu':
      return MessageSquare;
    case 'jira':
      return Ticket;
    case 'time_cron':
    case 'time_interval':
    case 'time_once':
    case 'time_sla':
    case 'timer':
      return Clock3;
    case 'webhook_standard':
    case 'webhook_custom':
      return Webhook;
    case 'sdk_custom':
    case 'system_internal':
    default:
      return Sparkles;
  }
}

function groupAutomationTasks(
  tasks: readonly UnifiedAutomationTask[],
  groupBy: TaskGroupBy
): Map<string, UnifiedAutomationTask[]> {
  const map = new Map<string, UnifiedAutomationTask[]>();
  if (groupBy === 'none') {
    map.set('all', [...tasks]);
    return map;
  }
  for (const key of GOVERNANCE_GROUP_ORDER) {
    map.set(key, []);
  }
  for (const task of tasks) {
    const bucket = map.get(task.governanceGroup) ?? [];
    bucket.push(task);
    map.set(task.governanceGroup, bucket);
  }
  return map;
}

function SemanticActorChip({
  actor,
  agentOptions,
}: {
  actor: TaskChainActor;
  agentOptions: WorkflowStudioAgentOption[];
}) {
  if (actor.kind === 'bot') {
    return (
      <span className="inline-flex max-w-[160px] items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
        <MemberBotAvatar
          config={actor.avatar}
          animated={false}
          className="size-4 shrink-0"
        />
        <span className="truncate">{actor.label}</span>
      </span>
    );
  }

  if (actor.kind === 'group') {
    return (
      <span className="inline-flex max-w-[160px] items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
        <Users className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">{actor.label}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex max-w-[160px] items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
      <StudioAgentIcon
        agentId={actor.agentId}
        agentOptions={agentOptions}
        className="size-3.5 shrink-0"
      />
      <span className="truncate">{actor.label}</span>
    </span>
  );
}

export interface AutomationTasksTabProps {
  renderHeader?: (toolbarRow: ReactNode) => ReactNode;
  projectId?: string | null;
  tasks: readonly UnifiedAutomationTask[];
  pendingInteractions: readonly PulseUserInteractionView[];
  sources: readonly PulseSourceView[];
  agentOptions: WorkflowStudioAgentOption[];
  bots: readonly CollaborationBotOption[];
  applyingStarterId?: string | null;
  onOpenTaskCanvas: (task: UnifiedAutomationTask) => void;
  onToggleTaskEnabled: (task: UnifiedAutomationTask) => void;
  onDeleteTask: (task: UnifiedAutomationTask) => void;
  onApplyStarter: (starter: CanonicalWorkflowStarter) => void;
  onInteractionResolved: (interactionId: string) => void;
  onAgentDispatched?: (session: DispatchedAutomationAgentSession) => void;
}

export function AutomationTasksTab(props: AutomationTasksTabProps) {
  const { t, i18n } = useTranslation('panels');
  const [powerSearchFilters, setPowerSearchFilters] = useState<
    ReadonlyArray<PowerSearchFilter>
  >([]);
  const [groupBy, setGroupBy] = useState<TaskGroupBy>('governance');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(GOVERNANCE_GROUP_ORDER)
  );

  const powerSearchConfig = useMemo<PowerSearchConfig>(
    () => ({
      name: 'AutomationTasksSearch',
      contentSearchFieldKey: 'query',
      fields: [
        {
          key: 'status',
          label: t('pulseDeck.workbench.tasks.fieldStatus'),
          operators: [
            {
              key: 'is',
              label: t('pulseDeck.workbench.tasks.opIs'),
              value: {
                type: 'enum',
                values: STATUS_FILTER_ORDER.map((st) => ({
                  value: st,
                  label: t(`pulseDeck.workbench.status.${st}`),
                })),
              },
            },
          ],
        },
        {
          key: 'query',
          label: t('pulseDeck.workbench.tasks.fieldQuery'),
          operators: [
            {
              key: 'contains',
              label: t('pulseDeck.workbench.tasks.opContains'),
              value: { type: 'string' },
            },
          ],
        },
      ],
    }),
    [t, i18n.language]
  );

  const filteredTasks = useMemo(() => {
    if (powerSearchFilters.length === 0) {
      return props.tasks;
    }
    return props.tasks.filter((task) => {
      for (const filter of powerSearchFilters) {
        if (filter.field === 'status' && filter.value.type === 'enum') {
          if (task.status !== filter.value.value) return false;
        } else if (filter.field === 'query' && filter.value.type === 'string') {
          const q = filter.value.value.trim().toLowerCase();
          if (!q) continue;
          const haystack = [
            task.name,
            task.description ?? '',
            task.chain.sourceSummary,
            task.chain.outcomeSummary,
            ...task.chain.actors.map((actor) => actor.label),
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
      }
      return true;
    });
  }, [powerSearchFilters, props.tasks]);

  const grouped = useMemo(
    () => groupAutomationTasks(filteredTasks, groupBy),
    [filteredTasks, groupBy]
  );

  const groupKeys = useMemo(() => Array.from(grouped.keys()), [grouped]);

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      for (const key of groupKeys) {
        next.add(key);
      }
      return next;
    });
  }, [groupBy, groupKeys]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const getGroupLabel = (key: string): string => {
    switch (key as AutomationGovernanceGroup) {
      case 'needs_attention':
        return t('pulseDeck.workbench.tasks.groupNeedsAttention');
      case 'active':
        return t('pulseDeck.workbench.tasks.groupActive');
      case 'paused':
        return t('pulseDeck.workbench.tasks.groupPaused');
      default:
        return '';
    }
  };

  const columns = useMemo<TableColumn<Record<string, unknown>>[]>(
    () => [
      {
        key: 'name',
        header: t('pulseDeck.workbench.tasks.colName'),
        width: proportional(1.05),
      },
      {
        key: 'pipeline',
        header: t('pulseDeck.workbench.tasks.colPipeline'),
        width: proportional(1.75),
      },
      {
        key: 'status',
        header: t('pulseDeck.workbench.tasks.colStatus'),
        width: pixel(164),
      },
      {
        key: 'actions',
        header: t('pulseDeck.workbench.tasks.colActions'),
        width: pixel(228),
      },
    ],
    [t, i18n.language]
  );

  const resolvedWidths = useMemo(
    () => resolveColumnWidths(columns),
    [columns]
  );
  const colCount = columns.length;

  const toolbarRow = (
    <HStack gap={2} vAlign="center">
      <StackItem size="fill">
        <PowerSearch
          config={powerSearchConfig}
          filters={powerSearchFilters}
          onChange={(next) => setPowerSearchFilters(next)}
          label={t('pulseDeck.workbench.tasks.searchPlaceholder')}
          isLabelHidden
          hasClear
          placeholder={t('pulseDeck.workbench.tasks.searchPlaceholder')}
          resultCount={t('pulseDeck.workbench.tasks.resultCount', {
            count: filteredTasks.length,
          })}
        />
      </StackItem>
      <Popover
        placement="below"
        alignment="end"
        width={240}
        label={t('pulseDeck.workbench.tasks.groupOptionsAria')}
        content={
          <VStack gap={3}>
            <RadioList
              label={t('pulseDeck.workbench.tasks.groupByLabel')}
              value={groupBy}
              onChange={(val) => setGroupBy(val as TaskGroupBy)}
            >
              <RadioListItem
                value="governance"
                label={t('pulseDeck.workbench.tasks.groupByStatus')}
              />
              <RadioListItem
                value="none"
                label={t('pulseDeck.workbench.tasks.groupByNone')}
              />
            </RadioList>
          </VStack>
        }
      >
        <Button
          label={t('pulseDeck.workbench.tasks.viewOptionsBtn')}
          variant="secondary"
          size="md"
          data-testid="automation-view-options-btn"
        />
      </Popover>
    </HStack>
  );

  const masterPane = (
    <div
      data-testid="automation-tasks-list"
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {props.pendingInteractions.length > 0 ? (
        <div
          data-testid="automation-pending-approvals-strip"
          className="border-b border-border/70 bg-muted/30 px-4 py-3"
        >
          <div className="mb-2 flex items-center gap-2">
            <Bell className="size-3.5 text-warning" />
            <Text type="body" weight="semibold">
              {t('pulseDeck.workbench.tasks.pendingApprovalsTitle')}
            </Text>
            <Badge
              variant="warning"
              label={String(props.pendingInteractions.length)}
              className="tabular-nums"
            />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {props.pendingInteractions.map((interaction) => (
              <PulseInteractionCard
                key={interaction.id}
                interaction={interaction}
                onResolved={props.onInteractionResolved}
              />
            ))}
          </div>
        </div>
      ) : null}

      {filteredTasks.length === 0 ? (
        <div
          data-testid="automation-tasks-empty"
          className="flex flex-1 flex-col items-center justify-center gap-8 p-8"
        >
          <EmptyState
            icon={<Icon icon={Zap} size="lg" color="secondary" />}
            title={t('pulseDeck.workbench.tasks.emptyTitle')}
            description={t('pulseDeck.workbench.tasks.emptyDesc')}
            actions={
              <AutomationAgentComposerPopover
                mode="create"
                projectId={props.projectId}
                sources={props.sources}
                bots={props.bots}
                buttonSize="md"
                testId="automation-empty-agent-create-btn"
                onDispatched={props.onAgentDispatched}
              />
            }
          />

          {props.tasks.length === 0 ? (
            <div
              data-testid="automation-starter-gallery"
              className="w-full max-w-3xl space-y-3"
            >
              <div className="flex items-center justify-between px-1">
                <Text type="supporting" weight="medium" color="secondary">
                  {t('pulseDeck.workbench.agent.starterGalleryTitle')}
                </Text>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {CANONICAL_WORKFLOW_STARTERS.map((starter) => {
                  const StarterIcon = resolveSourceIcon(starter.sourceKind);
                  const isApplying = props.applyingStarterId === starter.id;
                  return (
                    <div
                      key={starter.id}
                      data-testid={`automation-starter-card-${starter.id}`}
                      className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/25"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <StarterIcon className="size-4 shrink-0 text-primary" />
                          <Text type="body" weight="semibold" maxLines={1}>
                            {t(starter.titleKey)}
                          </Text>
                        </div>
                        <Text type="supporting" color="secondary" maxLines={2}>
                          {t(starter.summaryKey)}
                        </Text>
                      </div>

                      <HStack gap={2} vAlign="center">
                        <Button
                          label={
                            isApplying
                              ? t('pulseDeck.workbench.agent.applyingStarterBtn')
                              : t('pulseDeck.workbench.agent.applyStarterBtn')
                          }
                          variant="secondary"
                          size="sm"
                          isDisabled={Boolean(props.applyingStarterId)}
                          data-testid={`automation-apply-starter-${starter.id}`}
                          icon={
                            isApplying ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Icon icon={Play} size="xsm" />
                            )
                          }
                          onClick={() => props.onApplyStarter(starter)}
                        />
                      </HStack>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
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
            {groupKeys.map((groupKey) => {
              const groupItems = grouped.get(groupKey);
              if (!groupItems || groupItems.length === 0) {
                return null;
              }
              const isExpanded = expandedGroups.has(groupKey);

              return (
                <Fragment key={groupKey}>
                  {groupBy !== 'none' ? (
                    <TableRow
                      role="button"
                      tabIndex={0}
                      data-testid={`automation-group-header-${groupKey}`}
                      onClick={() => toggleGroup(groupKey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleGroup(groupKey);
                        }
                      }}
                    >
                      <TableCell colSpan={colCount} style={groupHeaderCell}>
                        <HStack gap={2} vAlign="center">
                          <Icon
                            icon={isExpanded ? ChevronDown : ChevronRight}
                            size="sm"
                            color="secondary"
                          />
                          <Text type="body" weight="bold">
                            {getGroupLabel(groupKey)}
                          </Text>
                          <Badge
                            variant={
                              groupKey === 'needs_attention'
                                ? 'warning'
                                : 'neutral'
                            }
                            label={String(groupItems.length)}
                            className="tabular-nums"
                          />
                        </HStack>
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {(groupBy === 'none' || isExpanded) &&
                    groupItems.map((task) => {
                      const SourceIcon = resolveSourceIcon(
                        task.chain.sourceKind
                      );
                      const visibleActors = task.chain.actors.slice(0, 2);
                      const extraActorCount =
                        task.chain.actors.length - visibleActors.length;

                      return (
                        <TableRow
                          key={task.key}
                          data-testid={`automation-task-row-${task.id}`}
                          style={interactiveRowStyle}
                          onClick={() => props.onOpenTaskCanvas(task)}
                        >
                          {/* Column 1: Task Name + 1-line summary */}
                          <TableCell>
                            <div className="min-w-0 py-0.5">
                              <Text type="body" weight="medium" maxLines={1}>
                                {task.name}
                              </Text>
                              {task.description ? (
                                <Text
                                  type="supporting"
                                  color="secondary"
                                  maxLines={1}
                                >
                                  {task.description}
                                </Text>
                              ) : null}
                            </div>
                          </TableCell>

                          {/* Column 2: Semantic Chain [从哪来] → [触发谁] → [结果给谁] */}
                          <TableCell>
                            <div
                              data-testid={`automation-task-pipeline-${task.id}`}
                              className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs"
                            >
                              <span className="inline-flex max-w-[180px] items-center gap-1.5 truncate text-muted-foreground">
                                <SourceIcon className="size-3.5 shrink-0 text-foreground/75" />
                                <span className="truncate">
                                  {task.chain.sourceSummary}
                                </span>
                              </span>

                              <ArrowRight className="size-3 shrink-0 text-muted-foreground/50" />

                              {visibleActors.length > 0 ? (
                                <div className="flex shrink-0 items-center gap-1">
                                  {visibleActors.map((actor) => (
                                    <SemanticActorChip
                                      key={`${actor.kind}-${actor.kind === 'agent' ? actor.agentId : actor.kind === 'bot' ? actor.memberId : actor.spaceId}`}
                                      actor={actor}
                                      agentOptions={props.agentOptions}
                                    />
                                  ))}
                                  {extraActorCount > 0 ? (
                                    <span className="text-[11px] tabular-nums text-muted-foreground">
                                      +{extraActorCount}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}

                              {visibleActors.length > 0 ? (
                                <ArrowRight className="size-3 shrink-0 text-muted-foreground/50" />
                              ) : null}

                              <span className="truncate text-muted-foreground">
                                {task.chain.outcomeSummary}
                              </span>
                            </div>
                          </TableCell>

                          {/* Column 3: Status + Trigger count */}
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <TaskStatusBadge
                                status={task.status}
                                testId={`automation-task-status-${task.id}`}
                              />
                              {task.recordCount > 0 ? (
                                <span
                                  data-testid={`automation-task-records-${task.id}`}
                                  className="text-xs tabular-nums text-muted-foreground"
                                >
                                  ·{' '}
                                  {t(
                                    'pulseDeck.workbench.tasks.triggeredCount',
                                    { count: task.recordCount }
                                  )}
                                </span>
                              ) : null}
                            </div>
                          </TableCell>

                          {/* Column 4: Switch + Ask Agent to Edit + Delete */}
                          <TableCell>
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="flex shrink-0 items-center justify-end gap-2"
                            >
                              <Switch
                                aria-label={t(
                                  'pulseDeck.workbench.tasks.switchAria',
                                  { name: task.name }
                                )}
                                checked={task.enabled}
                                onCheckedChange={() =>
                                  props.onToggleTaskEnabled(task)
                                }
                                data-testid={`automation-task-switch-${task.id}`}
                              />
                              <AutomationAgentComposerPopover
                                mode="edit_workflow"
                                projectId={props.projectId}
                                definitionId={task.workflowId}
                                sourceRuleId={task.linkedRule?.id ?? null}
                                currentDefinition={task.studioDefinition}
                                sources={props.sources}
                                bots={props.bots}
                                buttonVariant="ghost"
                                buttonSize="sm"
                                buttonLabel={t(
                                  'pulseDeck.workbench.agent.editShortBtn'
                                )}
                                testId={`automation-task-agent-edit-${task.id}`}
                                onDispatched={props.onAgentDispatched}
                              />
                              <Button
                                label={t('pulseDeck.workbench.tasks.quickDelete')}
                                variant="ghost"
                                size="sm"
                                isIconOnly
                                icon={<Icon icon={Trash2} size="sm" />}
                                data-testid={`automation-task-delete-${task.id}`}
                                onClick={() => props.onDeleteTask(task)}
                              />
                            </div>
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

  return (
    <AutomationSplitFrame
      testId="automation-tab-tasks-split"
      header={props.renderHeader?.(toolbarRow)}
      master={masterPane}
      detail={null}
    />
  );
}
