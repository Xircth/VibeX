import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import {
  ArrowRight,
  Bell,
  Clock3,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Search,
  Sparkles,
  Ticket,
  Trash2,
  Users,
  Webhook,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import type { WorkflowStudioAgentOption } from '@/features/workflow/workflowAgent';
import { StudioAgentIcon } from '@/features/workflow/workflow-studio/StudioAgentIcon';
import type {
  EventSourceKind,
  PulseUserInteractionView,
} from '@/lib/api/pulse';

import { PulseInteractionCard } from '../pulseInteractionForm';
import {
  CANONICAL_WORKFLOW_STARTERS,
  type CanonicalWorkflowStarter,
} from './automationAgentBridge';
import {
  FilterStatusPill,
  FilterTable,
  type FilterChipItem,
  type FilterStatusTone,
  type FilterTableRow,
} from './FilterTable';
import type {
  AutomationTaskStatus,
  TaskChainActor,
  UnifiedAutomationTask,
} from './automationModels';

const STATUS_FILTER_ORDER: readonly AutomationTaskStatus[] = [
  'awaiting_approval',
  'running',
  'active',
  'paused',
  'draft',
];

const STATUS_VISUAL: Record<
  AutomationTaskStatus,
  { dot: string; tone: FilterStatusTone }
> = {
  awaiting_approval: { dot: '#f09a2f', tone: 'todo' },
  running: { dot: '#16a6c7', tone: 'progress' },
  active: { dot: '#25a878', tone: 'done' },
  paused: { dot: '#737373', tone: 'paused' },
  draft: { dot: '#f09a2f', tone: 'todo' },
};

function resolveSourceIcon(kind: EventSourceKind | string): LucideIcon {
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
  renderShell: (options: {
    headerSearch?: ReactNode;
    children: ReactNode;
  }) => ReactNode;
  tasks: readonly UnifiedAutomationTask[];
  pendingInteractions: readonly PulseUserInteractionView[];
  agentOptions: WorkflowStudioAgentOption[];
  applyingStarterId?: string | null;
  customizingStarterId?: string | null;
  onOpenTaskCanvas: (task: UnifiedAutomationTask) => void;
  onToggleTaskEnabled: (task: UnifiedAutomationTask) => void;
  onDeleteTask: (task: UnifiedAutomationTask) => void;
  onApplyStarter: (starter: CanonicalWorkflowStarter) => void;
  onCustomizeStarter?: (starter: CanonicalWorkflowStarter) => void;
  onInteractionResolved: (interactionId: string) => void;
}

export function AutomationTasksTab(props: AutomationTasksTabProps) {
  const { t } = useTranslation('panels');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    AutomationTaskStatus | 'all'
  >('all');

  const searchedTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return props.tasks;
    return props.tasks.filter((task) => {
      const haystack = [
        task.name,
        task.description ?? '',
        task.chain.sourceSummary,
        task.chain.outcomeSummary,
        ...task.chain.actors.map((actor) => actor.label),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [props.tasks, searchQuery]);

  const filterChips = useMemo<
    FilterChipItem<AutomationTaskStatus | 'all'>[]
  >(() => {
    const counts = new Map<AutomationTaskStatus, number>();
    for (const task of searchedTasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    const chips: FilterChipItem<AutomationTaskStatus | 'all'>[] = [
      {
        key: 'all',
        label: t('pulseDeck.workbench.tasks.filterAll'),
        count: searchedTasks.length,
        testId: 'automation-filter-chip-all',
      },
    ];
    for (const st of STATUS_FILTER_ORDER) {
      const count = counts.get(st) ?? 0;
      if (count > 0 || statusFilter === st) {
        chips.push({
          key: st,
          label: t(`pulseDeck.workbench.status.${st}`),
          dot: STATUS_VISUAL[st].dot,
          count,
          testId: `automation-filter-chip-${st}`,
        });
      }
    }
    return chips;
  }, [searchedTasks, statusFilter, t]);

  const columns = useMemo(
    () => [
      { key: 'name', label: t('pulseDeck.workbench.tasks.colName') },
      { key: 'pipeline', label: t('pulseDeck.workbench.tasks.colPipeline') },
      { key: 'status', label: t('pulseDeck.workbench.tasks.colStatus') },
      {
        key: 'actions',
        label: t('pulseDeck.workbench.tasks.colActions'),
        align: 'right' as const,
      },
    ],
    [t]
  );

  const tableRows = useMemo<FilterTableRow<AutomationTaskStatus>[]>(
    () =>
      searchedTasks.map((task) => {
        const SourceIcon = resolveSourceIcon(task.chain.sourceKind);
        const visibleActors = task.chain.actors.slice(0, 2);
        const extraActorCount = task.chain.actors.length - visibleActors.length;
        const visual = STATUS_VISUAL[task.status];
        const statusLabel = t(`pulseDeck.workbench.status.${task.status}`);

        return {
          key: task.key,
          statusKey: task.status,
          testId: `automation-task-row-${task.id}`,
          onClick: () => props.onOpenTaskCanvas(task),
          cells: [
            // Col 1: Task Name + 1-line summary
            <div key="name" className="min-w-0 py-0.5">
              <div className="truncate font-medium text-foreground">
                {task.name}
              </div>
              {task.description ? (
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {task.description}
                </div>
              ) : null}
            </div>,

            // Col 2: Semantic Chain [从哪来] → [触发谁] → [结果给谁]
            <div
              key="pipeline"
              data-testid={`automation-task-pipeline-${task.id}`}
              className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs"
            >
              <span className="inline-flex max-w-[165px] items-center gap-1.5 truncate text-muted-foreground">
                <SourceIcon className="size-3.5 shrink-0 text-foreground/75" />
                <span className="truncate">{task.chain.sourceSummary}</span>
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
            </div>,

            // Col 3: Status Pill + Trigger Count
            <div key="status" className="flex min-w-0 items-center gap-2">
              <FilterStatusPill
                tone={visual.tone}
                label={statusLabel}
                testId={`automation-task-status-${task.id}`}
              />
              {task.recordCount > 0 ? (
                <span
                  data-testid={`automation-task-records-${task.id}`}
                  className="truncate text-[11.5px] tabular-nums text-muted-foreground"
                >
                  {t('pulseDeck.workbench.tasks.triggeredCount', {
                    count: task.recordCount,
                  })}
                </span>
              ) : null}
            </div>,

            // Col 4: Switch + Edit (black) + Delete
            <div
              key="actions"
              onClick={(e) => e.stopPropagation()}
              className="flex w-full shrink-0 items-center justify-end gap-1.5"
            >
              <Switch
                aria-label={t('pulseDeck.workbench.tasks.switchAria', {
                  name: task.name,
                })}
                checked={task.enabled}
                onCheckedChange={() => props.onToggleTaskEnabled(task)}
                data-testid={`automation-task-switch-${task.id}`}
              />
              <Button
                type="button"
                variant="default"
                size="xs"
                data-testid={`automation-task-open-workflow-${task.id}`}
                title={t('pulseDeck.workbench.tasks.openWorkflowTooltip')}
                onClick={() => props.onOpenTaskCanvas(task)}
                className="h-6 gap-1 px-2 text-[11px]"
              >
                <Pencil className="size-3" />
                <span>{t('pulseDeck.workbench.tasks.openWorkflowBtn')}</span>
              </Button>
              <Button
                type="button"
                aria-label={t('pulseDeck.workbench.tasks.quickDelete')}
                variant="ghost"
                size="icon"
                data-testid={`automation-task-delete-${task.id}`}
                onClick={() => props.onDeleteTask(task)}
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>,
          ],
        };
      }),
    [props, searchedTasks, t]
  );

  const headerSearch = (
    <div className="relative flex items-center">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
      <Input
        type="search"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={t('pulseDeck.workbench.tasks.searchPlaceholder')}
        aria-label={t('pulseDeck.workbench.tasks.searchPlaceholder')}
        data-testid="automation-header-search"
        className="h-7 w-40 rounded-[var(--radius-element)] pl-7 pr-6 text-xs sm:w-52"
      />
      {searchQuery ? (
        <button
          type="button"
          onClick={() => setSearchQuery('')}
          aria-label={t('pulseDeck.workbench.tasks.clearSearchAria')}
          data-testid="automation-header-search-clear"
          className="absolute right-1.5 inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );

  const content = (
    <div
      data-testid="automation-tasks-list"
      className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-0.5"
    >
      {props.pendingInteractions.length > 0 ? (
        <div
          data-testid="automation-pending-approvals-strip"
          className="automation-filter-table-card px-4 py-3"
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

      {searchedTasks.length === 0 ? (
        <div
          data-testid="automation-tasks-empty"
          className="automation-filter-table-card flex flex-1 flex-col items-center justify-center gap-6 p-8"
        >
          <EmptyState
            icon={<Icon icon={Zap} size="lg" color="secondary" />}
            title={t('pulseDeck.workbench.tasks.emptyTitle')}
            description={t('pulseDeck.workbench.tasks.emptyDesc')}
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
                  const isCustomizing =
                    props.customizingStarterId === starter.id;
                  const isBusy = Boolean(
                    props.applyingStarterId || props.customizingStarterId
                  );
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

                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={isBusy}
                          data-testid={`automation-apply-starter-${starter.id}`}
                          onClick={() => props.onApplyStarter(starter)}
                          className="h-6 gap-1 px-2 text-[11px]"
                        >
                          {isApplying ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Play className="size-3" />
                          )}
                          <span>
                            {isApplying
                              ? t('pulseDeck.workbench.agent.applyingStarterBtn')
                              : t('pulseDeck.workbench.agent.applyStarterBtn')}
                          </span>
                        </Button>
                        {props.onCustomizeStarter ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={isBusy}
                            data-testid={`automation-customize-starter-${starter.id}`}
                            onClick={() => props.onCustomizeStarter?.(starter)}
                            className="h-6 gap-1 px-2 text-[11px]"
                          >
                            {isCustomizing ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Sparkles className="size-3 text-primary" />
                            )}
                            <span>
                              {t(
                                'pulseDeck.workbench.agent.customizeStarterBtn'
                              )}
                            </span>
                          </Button>
                        ) : null}
                      </HStack>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <FilterTable
          filters={filterChips}
          columns={columns}
          rows={tableRows}
          activeFilter={statusFilter}
          onFilterChange={setStatusFilter}
          gridTemplateColumns="minmax(130px,1.05fr) minmax(180px,1.65fr) minmax(110px,0.75fr) minmax(156px,0.85fr)"
          minTableWidthClass="min-w-[580px]"
          ariaLabel={t('pulseDeck.workbench.primaryTabs.tasks')}
        />
      )}
    </div>
  );

  return (
    <>
      {props.renderShell({
        headerSearch,
        children: content,
      })}
    </>
  );
}
