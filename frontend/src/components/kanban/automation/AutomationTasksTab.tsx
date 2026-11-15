import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
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
import { Switch } from '@astryxdesign/core/Switch';
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
  ChevronDown,
  ChevronRight,
  Eye,
  GitFork,
  MoreHorizontal,
  Pencil,
  Play,
  Rocket,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  EventEnvelope,
  PulseDryRunReport,
  PulseOutboxEntryView,
  PulseRuleSpec,
  PulseRuleView,
  PulseSourceView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import {
  AutomationSplitFrame,
  groupHeaderCell,
  interactiveRowStyle,
  NewAutomationMenuButton,
  selectedTableRowStyle,
  TaskStatusBadge,
} from './AutomationSplitFrame';
import {
  summarizeFastTaskSegments,
  type AutomationTaskStatus,
  type FastTaskEditorTab,
  type UnifiedAutomationTask,
} from './automationModels';
import { FastTaskEditorPane } from './FastTaskEditorPane';

type TaskGroupBy = 'kind' | 'status' | 'none';

const KIND_GROUP_ORDER: readonly UnifiedAutomationTask['kind'][] = [
  'fast_task',
  'workflow',
];

const STATUS_GROUP_ORDER: readonly AutomationTaskStatus[] = [
  'running',
  'testing',
  'publishing',
  'published',
  'pending_test',
  'editing',
];

function groupAutomationTasks(
  tasks: readonly UnifiedAutomationTask[],
  groupBy: TaskGroupBy
): Map<string, UnifiedAutomationTask[]> {
  const map = new Map<string, UnifiedAutomationTask[]>();
  if (groupBy === 'none') {
    map.set('all', [...tasks]);
    return map;
  }
  const order = groupBy === 'kind' ? KIND_GROUP_ORDER : STATUS_GROUP_ORDER;
  for (const key of order) {
    map.set(key, []);
  }
  for (const task of tasks) {
    const key = groupBy === 'kind' ? task.kind : task.status;
    const bucket = map.get(key) ?? [];
    bucket.push(task);
    map.set(key, bucket);
  }
  return map;
}

export interface AutomationTasksTabProps {
  renderHeader?: (toolbarRow: ReactNode) => ReactNode;
  tasks: readonly UnifiedAutomationTask[];
  selectedTaskKey: string | null;
  onCloseDetail: () => void;
  onSelectFastTask: (rule: PulseRuleView, subTab?: FastTaskEditorTab) => void;
  onSelectWorkflowTask: (
    task: Extract<UnifiedAutomationTask, { kind: 'workflow' }>
  ) => void;
  onStartNewFastTask: () => void;
  onOpenWorkflowStudio: (definitionId?: string | null) => void;
  onToggleTaskEnabled: (task: UnifiedAutomationTask) => void;
  onQuickTestFastTask: (rule: PulseRuleView) => void;
  onQuickPublishFastTask: (rule: PulseRuleView) => void;
  onQuickDeleteFastTask: (rule: PulseRuleView) => void;
  // Right-pane editor props
  selectedWorkflowTask: Extract<UnifiedAutomationTask, { kind: 'workflow' }> | null;
  draftRuleId: string | null;
  draftSpec: PulseRuleSpec;
  existingRule: PulseRuleView | null;
  editorStatus: AutomationTaskStatus;
  activeSubTab: FastTaskEditorTab;
  onSubTabChange: (tab: FastTaskEditorTab) => void;
  onSpecChange: (next: PulseRuleSpec) => void;
  sources: readonly PulseSourceView[];
  allRules: readonly PulseRuleView[];
  capturedEvents: readonly EventEnvelope[];
  recentOutbox: readonly PulseOutboxEntryView[];
  validationErrors: readonly string[];
  lastTestReport: PulseDryRunReport | null;
  saving: boolean;
  testing: boolean;
  publishing: boolean;
  converting: boolean;
  onSaveDraft: () => void;
  onTestTask: () => void;
  onEmitLiveSample: () => void;
  onPublishTask: () => void;
  onConvertToWorkflow: () => void;
  onDeleteTask: () => void;
  onJumpCreateSource: () => void;
}

export function AutomationTasksTab(props: AutomationTasksTabProps) {
  const { t, i18n } = useTranslation('panels');
  const [powerSearchFilters, setPowerSearchFilters] = useState<
    ReadonlyArray<PowerSearchFilter>
  >([]);
  const [groupBy, setGroupBy] = useState<TaskGroupBy>('kind');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set([...KIND_GROUP_ORDER, ...STATUS_GROUP_ORDER])
  );

  const powerSearchConfig = useMemo<PowerSearchConfig>(
    () => ({
      name: 'AutomationTasksSearch',
      contentSearchFieldKey: 'query',
      fields: [
        {
          key: 'kind',
          label: t('pulseDeck.workbench.tasks.searchFieldKind'),
          operators: [
            {
              key: 'is',
              label: t('pulseDeck.workbench.tasks.operatorIs'),
              value: {
                type: 'enum',
                values: [
                  {
                    value: 'fast_task',
                    label: t('pulseDeck.workbench.tasks.typeFastTask'),
                  },
                  {
                    value: 'workflow',
                    label: t('pulseDeck.workbench.tasks.typeWorkflow'),
                  },
                ],
              },
            },
          ],
        },
        {
          key: 'status',
          label: t('pulseDeck.workbench.tasks.searchFieldStatus'),
          operators: [
            {
              key: 'is',
              label: t('pulseDeck.workbench.tasks.operatorIs'),
              value: {
                type: 'enum',
                values: STATUS_GROUP_ORDER.map((st) => ({
                  value: st,
                  label: t(`pulseDeck.workbench.status.${st}`),
                })),
              },
            },
          ],
        },
        {
          key: 'query',
          label: t('pulseDeck.workbench.tasks.searchFieldQuery'),
          operators: [
            {
              key: 'contains',
              label: t('pulseDeck.workbench.tasks.operatorContains'),
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
        if (filter.field === 'kind' && filter.value.type === 'enum') {
          if (task.kind !== filter.value.value) return false;
        } else if (filter.field === 'status' && filter.value.type === 'enum') {
          if (task.status !== filter.value.value) return false;
        } else if (filter.field === 'query' && filter.value.type === 'string') {
          const q = filter.value.value.trim().toLowerCase();
          if (!q) continue;
          const nameHit = task.name.toLowerCase().includes(q);
          const detailHit =
            task.kind === 'fast_task'
              ? task.rule.spec.filter.eventTypes
                  .join(' ')
                  .toLowerCase()
                  .includes(q)
              : task.workflowId.toLowerCase().includes(q);
          if (!nameHit && !detailHit) return false;
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
    if (groupBy === 'kind') {
      return key === 'fast_task'
        ? t('pulseDeck.workbench.tasks.groupTasksTitle')
        : t('pulseDeck.workbench.tasks.groupWorkflowsTitle');
    }
    if (groupBy === 'status') {
      return t(`pulseDeck.workbench.status.${key}`);
    }
    return '';
  };

  const columns = useMemo<TableColumn<Record<string, unknown>>[]>(
    () => [
      {
        key: 'enabled',
        header: t('pulseDeck.workbench.tasks.colEnabled'),
        width: pixel(68),
      },
      {
        key: 'status',
        header: t('pulseDeck.workbench.tasks.colStatus'),
        width: pixel(108),
      },
      {
        key: 'name',
        header: t('pulseDeck.workbench.tasks.colName'),
        width: proportional(1),
      },
      {
        key: 'pipeline',
        header: t('pulseDeck.workbench.tasks.colPipeline'),
        width: proportional(1.4),
      },
      {
        key: 'records',
        header: t('pulseDeck.workbench.tasks.colRecords'),
        width: pixel(88),
      },
      {
        key: 'actions',
        header: '',
        width: pixel(52),
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
          placeholder={t('pulseDeck.workbench.tasks.searchPlaceholder')}
          resultCount={t('pulseDeck.workbench.tasks.resultCount', {
            count: filteredTasks.length,
          })}
        />
      </StackItem>
      <Popover
        placement="below"
        alignment="end"
        width={280}
        label={t('pulseDeck.workbench.tasks.groupByAria')}
        content={
          <VStack gap={3}>
            <RadioList
              label={t('pulseDeck.workbench.tasks.groupByLabel')}
              value={groupBy}
              onChange={(val) => setGroupBy(val as TaskGroupBy)}
            >
              <RadioListItem
                value="kind"
                label={t('pulseDeck.workbench.tasks.groupByKind')}
              />
              <RadioListItem
                value="status"
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
    <div data-testid="automation-tasks-list" className="min-h-0 flex-1">
      {filteredTasks.length === 0 ? (
        <div data-testid="automation-tasks-empty" className="p-8">
          <EmptyState
            icon={<Icon icon={Zap} size="lg" color="secondary" />}
            title={t('pulseDeck.workbench.tasks.emptyTitle')}
            description={t('pulseDeck.workbench.tasks.emptyDesc')}
            actions={
              <NewAutomationMenuButton
                onNewFastTask={props.onStartNewFastTask}
                onNewWorkflow={() => props.onOpenWorkflowStudio(null)}
                size="md"
                testId="automation-empty-new-menu-btn"
              />
            }
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
                          {groupBy === 'kind' ? (
                            <Icon
                              icon={groupKey === 'fast_task' ? Zap : GitFork}
                              size="sm"
                              color={
                                groupKey === 'fast_task'
                                  ? 'accent'
                                  : 'secondary'
                              }
                            />
                          ) : null}
                          <Text type="body" weight="bold">
                            {getGroupLabel(groupKey)}
                          </Text>
                          <Badge
                            variant="neutral"
                            label={String(groupItems.length)}
                            className="tabular-nums"
                          />
                        </HStack>
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {(groupBy === 'none' || isExpanded) &&
                    groupItems.map((task) => {
                      const selected = props.selectedTaskKey === task.key;
                      const rowStyle = selected
                        ? { ...interactiveRowStyle, ...selectedTableRowStyle }
                        : interactiveRowStyle;

                      if (task.kind === 'fast_task') {
                        const segments = summarizeFastTaskSegments(
                          task.rule.spec,
                          props.sources,
                          t
                        );
                        return (
                          <TableRow
                            key={task.key}
                            data-testid={`automation-task-row-${task.id}`}
                            style={rowStyle}
                            onClick={() => props.onSelectFastTask(task.rule)}
                          >
                            <TableCell>
                              <div onClick={(e) => e.stopPropagation()}>
                                <Switch
                                  size="sm"
                                  isLabelHidden
                                  label={t(
                                    'pulseDeck.workbench.tasks.switchAria',
                                    { name: task.name }
                                  )}
                                  value={task.enabled}
                                  onChange={() =>
                                    props.onToggleTaskEnabled(task)
                                  }
                                  data-testid={`automation-task-switch-${task.id}`}
                                />
                              </div>
                            </TableCell>

                            <TableCell>
                              <TaskStatusBadge
                                status={task.status}
                                testId={`automation-task-status-${task.id}`}
                              />
                            </TableCell>

                            <TableCell>
                              <HStack gap={2} vAlign="center">
                                <Icon icon={Zap} size="sm" color="accent" />
                                <Text
                                  type="body"
                                  weight="medium"
                                  maxLines={1}
                                >
                                  {task.name}
                                </Text>
                                {groupBy !== 'kind' ? (
                                  <Badge
                                    variant="neutral"
                                    label={t(
                                      'pulseDeck.workbench.tasks.typeFastTask'
                                    )}
                                    data-testid={`automation-task-type-${task.id}`}
                                  />
                                ) : null}
                              </HStack>
                            </TableCell>

                            <TableCell>
                              <div
                                data-testid={`automation-task-pipeline-${task.id}`}
                                className="flex min-w-0 items-center gap-1 overflow-hidden text-xs"
                              >
                                <button
                                  type="button"
                                  data-testid={`automation-seg-event-${task.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onSelectFastTask(task.rule, 'event');
                                  }}
                                  className={cn(
                                    'truncate rounded px-1.5 py-0.5 transition-colors',
                                    selected && props.activeSubTab === 'event'
                                      ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-muted-foreground hover:bg-[var(--color-background-muted)] hover:text-foreground'
                                  )}
                                >
                                  {segments.eventSummary}
                                </button>
                                <span className="shrink-0 text-muted-foreground/50">
                                  ›
                                </span>
                                <button
                                  type="button"
                                  data-testid={`automation-seg-rule-${task.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onSelectFastTask(task.rule, 'rule');
                                  }}
                                  className={cn(
                                    'truncate rounded px-1.5 py-0.5 tabular-nums transition-colors',
                                    selected && props.activeSubTab === 'rule'
                                      ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-muted-foreground hover:bg-[var(--color-background-muted)] hover:text-foreground'
                                  )}
                                >
                                  {segments.ruleSummary}
                                </button>
                                <span className="shrink-0 text-muted-foreground/50">
                                  ›
                                </span>
                                <button
                                  type="button"
                                  data-testid={`automation-seg-target-${task.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onSelectFastTask(task.rule, 'target');
                                  }}
                                  className={cn(
                                    'truncate rounded px-1.5 py-0.5 transition-colors',
                                    selected && props.activeSubTab === 'target'
                                      ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-muted-foreground hover:bg-[var(--color-background-muted)] hover:text-foreground'
                                  )}
                                >
                                  {segments.targetSummary}
                                </button>
                                <span className="shrink-0 text-muted-foreground/50">
                                  ›
                                </span>
                                <button
                                  type="button"
                                  data-testid={`automation-seg-callback-${task.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onSelectFastTask(
                                      task.rule,
                                      'callback'
                                    );
                                  }}
                                  className={cn(
                                    'truncate rounded px-1.5 py-0.5 transition-colors',
                                    selected &&
                                      props.activeSubTab === 'callback'
                                      ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-muted-foreground hover:bg-[var(--color-background-muted)] hover:text-foreground'
                                  )}
                                >
                                  {segments.callbackSummary ??
                                    t(
                                      'pulseDeck.workbench.tasks.segAddCallback'
                                    )}
                                </button>
                              </div>
                            </TableCell>

                            <TableCell>
                              <button
                                type="button"
                                data-testid={`automation-task-records-${task.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  props.onSelectFastTask(task.rule, 'records');
                                }}
                                className="rounded px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-[var(--color-background-muted)] hover:text-foreground"
                              >
                                {t('pulseDeck.workbench.tasks.recordsCount', {
                                  count: task.recordCount,
                                })}
                              </button>
                            </TableCell>

                            <TableCell>
                              <div onClick={(e) => e.stopPropagation()}>
                                <DropdownMenu
                                  hasChevron={false}
                                  alignment="end"
                                  data-testid={`automation-task-actions-${task.id}`}
                                  button={{
                                    label: t(
                                      'pulseDeck.workbench.tasks.moreActionsAria',
                                      { name: task.name }
                                    ),
                                    variant: 'ghost',
                                    size: 'sm',
                                    icon: (
                                      <Icon icon={MoreHorizontal} size="sm" />
                                    ),
                                    isIconOnly: true,
                                  }}
                                  items={[
                                    {
                                      label: t(
                                        'pulseDeck.workbench.tasks.inspectBtn'
                                      ),
                                      icon: Pencil,
                                      onClick: () =>
                                        props.onSelectFastTask(task.rule),
                                    },
                                    {
                                      label: t(
                                        'pulseDeck.workbench.tasks.quickTest'
                                      ),
                                      icon: Play,
                                      onClick: () =>
                                        props.onQuickTestFastTask(task.rule),
                                    },
                                    {
                                      label: t(
                                        'pulseDeck.workbench.tasks.quickPublish'
                                      ),
                                      icon: Rocket,
                                      onClick: () =>
                                        props.onQuickPublishFastTask(task.rule),
                                    },
                                    { type: 'divider' },
                                    {
                                      label: t(
                                        'pulseDeck.workbench.tasks.quickDelete'
                                      ),
                                      icon: Trash2,
                                      onClick: () =>
                                        props.onQuickDeleteFastTask(task.rule),
                                    },
                                  ]}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      }

                      // Workflow row
                      const triggerInfo = task.triggerRule
                        ? task.triggerRule.spec.filter.eventTypes[0] ||
                          task.triggerRule.spec.name
                        : t('pulseDeck.workbench.tasks.workflowDraft');

                      return (
                        <TableRow
                          key={task.key}
                          data-testid={`automation-workflow-row-${task.workflowId}`}
                          style={rowStyle}
                          onClick={() => props.onSelectWorkflowTask(task)}
                        >
                          <TableCell>
                            <div onClick={(e) => e.stopPropagation()}>
                              <Switch
                                size="sm"
                                isLabelHidden
                                label={t(
                                  'pulseDeck.workbench.tasks.switchAria',
                                  { name: task.name }
                                )}
                                value={task.enabled}
                                onChange={() => props.onToggleTaskEnabled(task)}
                                data-testid={`automation-workflow-switch-${task.workflowId}`}
                              />
                            </div>
                          </TableCell>

                          <TableCell>
                            <TaskStatusBadge
                              status={task.status}
                              testId={`automation-workflow-status-${task.workflowId}`}
                            />
                          </TableCell>

                          <TableCell>
                            <HStack gap={2} vAlign="center">
                              <Icon
                                icon={GitFork}
                                size="sm"
                                color="secondary"
                              />
                              <Text type="body" weight="medium" maxLines={1}>
                                {task.name}
                              </Text>
                              {groupBy !== 'kind' ? (
                                <Badge
                                  variant="purple"
                                  label={t(
                                    'pulseDeck.workbench.tasks.typeWorkflow'
                                  )}
                                  data-testid={`automation-workflow-type-${task.workflowId}`}
                                />
                              ) : null}
                            </HStack>
                          </TableCell>

                          <TableCell>
                            <button
                              type="button"
                              data-testid={`automation-workflow-info-${task.workflowId}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onOpenWorkflowStudio(task.workflowId);
                              }}
                              className="inline-flex max-w-full items-center gap-2 truncate rounded px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-[var(--color-background-muted)] hover:text-foreground"
                            >
                              <span className="truncate">{triggerInfo}</span>
                              {task.versionLabel ? (
                                <span className="shrink-0 font-mono tabular-nums text-muted-foreground/80">
                                  ·{' '}
                                  {t(
                                    'pulseDeck.workbench.tasks.workflowVersion',
                                    { version: task.versionLabel }
                                  )}
                                </span>
                              ) : null}
                            </button>
                          </TableCell>

                          <TableCell>
                            <button
                              type="button"
                              data-testid={`automation-workflow-records-${task.workflowId}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onSelectWorkflowTask(task);
                              }}
                              className="rounded px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-[var(--color-background-muted)] hover:text-foreground"
                            >
                              {t('pulseDeck.workbench.tasks.recordsCount', {
                                count: task.recordCount,
                              })}
                            </button>
                          </TableCell>

                          <TableCell>
                            <div onClick={(e) => e.stopPropagation()}>
                              <DropdownMenu
                                hasChevron={false}
                                alignment="end"
                                data-testid={`automation-workflow-actions-${task.workflowId}`}
                                button={{
                                  label: t(
                                    'pulseDeck.workbench.tasks.moreActionsAria',
                                    { name: task.name }
                                  ),
                                  variant: 'ghost',
                                  size: 'sm',
                                  icon: (
                                    <Icon icon={MoreHorizontal} size="sm" />
                                  ),
                                  isIconOnly: true,
                                }}
                                items={[
                                  {
                                    label: t(
                                      'pulseDeck.workbench.tasks.openStudio'
                                    ),
                                    icon: GitFork,
                                    onClick: () =>
                                      props.onOpenWorkflowStudio(
                                        task.workflowId
                                      ),
                                  },
                                  {
                                    label: t(
                                      'pulseDeck.workbench.tasks.inspectBtn'
                                    ),
                                    icon: Eye,
                                    onClick: () =>
                                      props.onSelectWorkflowTask(task),
                                  },
                                ]}
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

  const detailPane =
    props.selectedTaskKey !== null ? (
      <FastTaskEditorPane
        selectedWorkflowTask={props.selectedWorkflowTask}
        draftRuleId={props.draftRuleId}
        draftSpec={props.draftSpec}
        existingRule={props.existingRule}
        status={props.editorStatus}
        activeSubTab={props.activeSubTab}
        onSubTabChange={props.onSubTabChange}
        onSpecChange={props.onSpecChange}
        sources={props.sources}
        allRules={props.allRules}
        capturedEvents={props.capturedEvents}
        recentOutbox={props.recentOutbox}
        validationErrors={props.validationErrors}
        lastTestReport={props.lastTestReport}
        saving={props.saving}
        testing={props.testing}
        publishing={props.publishing}
        converting={props.converting}
        onSaveDraft={props.onSaveDraft}
        onTestTask={props.onTestTask}
        onEmitLiveSample={props.onEmitLiveSample}
        onPublishTask={props.onPublishTask}
        onConvertToWorkflow={props.onConvertToWorkflow}
        onDeleteTask={props.onDeleteTask}
        onJumpCreateSource={props.onJumpCreateSource}
        onOpenWorkflowStudio={props.onOpenWorkflowStudio}
        onClose={props.onCloseDetail}
      />
    ) : null;

  return (
    <AutomationSplitFrame
      testId="automation-tab-tasks-split"
      header={props.renderHeader?.(toolbarRow)}
      master={masterPane}
      detail={detailPane}
    />
  );
}
