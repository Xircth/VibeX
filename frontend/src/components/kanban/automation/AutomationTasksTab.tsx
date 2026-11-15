import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Bot,
  Filter,
  GitFork,
  History,
  Play,
  Plus,
  Rocket,
  Search,
  Send,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
  EventEnvelope,
  PulseDryRunReport,
  PulseOutboxEntryView,
  PulseRuleSpec,
  PulseRuleView,
  PulseSourceView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { AutomationSplitFrame, TaskStatusBadge } from './AutomationSplitFrame';
import {
  summarizeFastTaskSegments,
  type AutomationTaskStatus,
  type FastTaskEditorTab,
  type TaskTypeFilter,
  type UnifiedAutomationTask,
} from './automationModels';
import { FastTaskEditorPane } from './FastTaskEditorPane';

export interface AutomationTasksTabProps {
  tasks: readonly UnifiedAutomationTask[];
  selectedTaskKey: string | null;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TaskTypeFilter>('all');

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return props.tasks.filter((task) => {
      if (typeFilter !== 'all' && task.kind !== typeFilter) {
        return false;
      }
      if (!q) return true;
      if (task.name.toLowerCase().includes(q)) return true;
      if (task.kind === 'fast_task') {
        const eventStr = task.rule.spec.filter.eventTypes.join(' ').toLowerCase();
        return eventStr.includes(q);
      }
      return task.workflowId.toLowerCase().includes(q);
    });
  }, [props.tasks, searchQuery, typeFilter]);

  const masterPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search + Type Filter Bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('pulseDeck.workbench.tasks.searchPlaceholder')}
            placeholder={t('pulseDeck.workbench.tasks.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 pl-8 text-xs"
          />
        </div>
        <div className="inline-flex items-center rounded-md border border-border bg-[var(--surface-control)] p-0.5">
          {(
            [
              {
                id: 'all',
                label: t('pulseDeck.workbench.tasks.filterAll'),
              },
              {
                id: 'fast_task',
                label: t('pulseDeck.workbench.tasks.filterFastTask'),
              },
              {
                id: 'workflow',
                label: t('pulseDeck.workbench.tasks.filterWorkflow'),
              },
            ] as const
          ).map((item) => {
            const active = typeFilter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`automation-task-filter-${item.id}`}
                aria-pressed={active}
                onClick={() => setTypeFilter(item.id)}
                className={cn(
                  'rounded px-2 py-0.5 text-2xs font-medium transition-colors',
                  active
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Unified Task List */}
      <div
        data-testid="automation-tasks-list"
        className="flex-1 divide-y divide-border overflow-y-auto"
      >
        {filteredTasks.length === 0 ? (
          <div
            data-testid="automation-tasks-empty"
            className="flex flex-col items-start gap-2.5 p-5"
          >
            <div className="text-sm font-medium text-foreground">
              {t('pulseDeck.workbench.tasks.emptyTitle')}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('pulseDeck.workbench.tasks.emptyDesc')}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                data-testid="automation-empty-new-fasttask"
                onClick={props.onStartNewFastTask}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t('pulseDeck.workbench.actions.newFastTask')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="automation-empty-new-workflow"
                onClick={() => props.onOpenWorkflowStudio(null)}
              >
                <GitFork className="mr-1 h-3.5 w-3.5" />
                {t('pulseDeck.workbench.actions.newWorkflow')}
              </Button>
            </div>
          </div>
        ) : (
          filteredTasks.map((task) => {
            const selected = props.selectedTaskKey === task.key;
            if (task.kind === 'fast_task') {
              const segments = summarizeFastTaskSegments(
                task.rule.spec,
                props.sources,
                t
              );
              return (
                <div
                  key={task.key}
                  data-testid={`automation-task-row-${task.id}`}
                  onClick={() => props.onSelectFastTask(task.rule)}
                  className={cn(
                    'cursor-pointer space-y-2 px-3 py-2.5 transition-colors',
                    selected
                      ? 'bg-[var(--surface-elevated)]'
                      : 'hover:bg-[var(--surface-control)]/50'
                  )}
                >
                  {/* Row Top Line: 1. Switch + Name + 2. Type + 3. Status + 4. Records */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        data-testid={`automation-task-switch-${task.id}`}
                        aria-checked={task.enabled}
                        aria-label={t('pulseDeck.workbench.tasks.switchAria', {
                          name: task.name,
                        })}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onToggleTaskEnabled(task);
                        }}
                        className={cn(
                          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors',
                          task.enabled
                            ? 'border-primary bg-primary'
                            : 'border-border bg-[var(--surface-control)]'
                        )}
                      >
                        <span
                          className={cn(
                            'inline-block h-3 w-3 rounded-full bg-background transition-transform',
                            task.enabled ? 'translate-x-3' : 'translate-x-0.5'
                          )}
                        />
                      </button>

                      <span className="truncate text-xs font-medium text-foreground">
                        {task.name}
                      </span>

                      <span
                        data-testid={`automation-task-type-${task.id}`}
                        className="rounded border border-border bg-[var(--surface-control)] px-1.5 py-0.5 text-2xs font-medium text-foreground"
                      >
                        {t('pulseDeck.workbench.tasks.typeFastTask')}
                      </span>

                      <TaskStatusBadge
                        status={task.status}
                        testId={`automation-task-status-${task.id}`}
                      />
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid={`automation-task-records-${task.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onSelectFastTask(task.rule, 'records');
                        }}
                        className="inline-flex items-center gap-1 rounded border border-border bg-[var(--surface-control)] px-1.5 py-0.5 text-2xs font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <History className="h-3 w-3 shrink-0" />
                        {t('pulseDeck.workbench.tasks.recordsCount', {
                          count: task.recordCount,
                        })}
                      </button>

                      <button
                        type="button"
                        data-testid={`automation-task-quick-test-${task.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onQuickTestFastTask(task.rule);
                        }}
                        title={t('pulseDeck.workbench.tasks.quickTest')}
                        className="rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-[var(--surface-control)] hover:text-foreground"
                      >
                        <Play className="inline h-3 w-3" />{' '}
                        {t('pulseDeck.workbench.tasks.quickTest')}
                      </button>

                      <button
                        type="button"
                        data-testid={`automation-task-quick-publish-${task.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onQuickPublishFastTask(task.rule);
                        }}
                        title={t('pulseDeck.workbench.tasks.quickPublish')}
                        className="rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-[var(--surface-control)] hover:text-foreground"
                      >
                        <Rocket className="inline h-3 w-3" />{' '}
                        {t('pulseDeck.workbench.tasks.quickPublish')}
                      </button>

                      <button
                        type="button"
                        data-testid={`automation-task-quick-delete-${task.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onQuickDeleteFastTask(task.rule);
                        }}
                        aria-label={`${t('pulseDeck.workbench.tasks.quickDelete')} ${task.name}`}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {/* 5. Info: Interactive 4-Segment Pipeline Strip */}
                  <div
                    data-testid={`automation-task-pipeline-${task.id}`}
                    className="flex flex-wrap items-center gap-1 text-2xs"
                  >
                    <button
                      type="button"
                      data-testid={`automation-seg-event-${task.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectFastTask(task.rule, 'event');
                      }}
                      className={cn(
                        'inline-flex max-w-[180px] items-center gap-1 truncate rounded border px-1.5 py-0.5 transition-colors',
                        selected && props.activeSubTab === 'event'
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Zap className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {t('pulseDeck.workbench.tasks.segEvent')}:{' '}
                        {segments.eventSummary}
                      </span>
                    </button>

                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />

                    <button
                      type="button"
                      data-testid={`automation-seg-rule-${task.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectFastTask(task.rule, 'rule');
                      }}
                      className={cn(
                        'inline-flex max-w-[150px] items-center gap-1 truncate rounded border px-1.5 py-0.5 transition-colors',
                        selected && props.activeSubTab === 'rule'
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Filter className="h-3 w-3 shrink-0" />
                      <span className="truncate tabular-nums">
                        {t('pulseDeck.workbench.tasks.segRule')}:{' '}
                        {segments.ruleSummary}
                      </span>
                    </button>

                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />

                    <button
                      type="button"
                      data-testid={`automation-seg-target-${task.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectFastTask(task.rule, 'target');
                      }}
                      className={cn(
                        'inline-flex max-w-[160px] items-center gap-1 truncate rounded border px-1.5 py-0.5 transition-colors',
                        selected && props.activeSubTab === 'target'
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Bot className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {t('pulseDeck.workbench.tasks.segTarget')}:{' '}
                        {segments.targetSummary}
                      </span>
                    </button>

                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />

                    <button
                      type="button"
                      data-testid={`automation-seg-callback-${task.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectFastTask(task.rule, 'callback');
                      }}
                      className={cn(
                        'inline-flex max-w-[150px] items-center gap-1 truncate rounded border px-1.5 py-0.5 transition-colors',
                        selected && props.activeSubTab === 'callback'
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Send className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {segments.callbackSummary
                          ? `${t('pulseDeck.workbench.tasks.segCallback')}: ${segments.callbackSummary}`
                          : t('pulseDeck.workbench.tasks.segAddCallback')}
                      </span>
                    </button>
                  </div>
                </div>
              );
            }

            // Workflow Row
            const triggerInfo = task.triggerRule
              ? task.triggerRule.spec.filter.eventTypes[0] ||
                task.triggerRule.spec.name
              : t('pulseDeck.workbench.tasks.workflowDraft');

            return (
              <div
                key={task.key}
                data-testid={`automation-workflow-row-${task.workflowId}`}
                onClick={() => props.onSelectWorkflowTask(task)}
                className={cn(
                  'cursor-pointer space-y-2 px-3 py-2.5 transition-colors',
                  selected
                    ? 'bg-[var(--surface-elevated)]'
                    : 'hover:bg-[var(--surface-control)]/50'
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      data-testid={`automation-workflow-switch-${task.workflowId}`}
                      aria-checked={task.enabled}
                      aria-label={t('pulseDeck.workbench.tasks.switchAria', {
                        name: task.name,
                      })}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onToggleTaskEnabled(task);
                      }}
                      className={cn(
                        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors',
                        task.enabled
                          ? 'border-primary bg-primary'
                          : 'border-border bg-[var(--surface-control)]'
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-3 w-3 rounded-full bg-background transition-transform',
                          task.enabled ? 'translate-x-3' : 'translate-x-0.5'
                        )}
                      />
                    </button>

                    <span className="truncate text-xs font-medium text-foreground">
                      {task.name}
                    </span>

                    <span
                      data-testid={`automation-workflow-type-${task.workflowId}`}
                      className="rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary"
                    >
                      {t('pulseDeck.workbench.tasks.typeWorkflow')}
                    </span>

                    <TaskStatusBadge
                      status={task.status}
                      testId={`automation-workflow-status-${task.workflowId}`}
                    />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`automation-workflow-records-${task.workflowId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectWorkflowTask(task);
                      }}
                      className="inline-flex items-center gap-1 rounded border border-border bg-[var(--surface-control)] px-1.5 py-0.5 text-2xs font-medium tabular-nums text-muted-foreground hover:text-foreground"
                    >
                      <History className="h-3 w-3 shrink-0" />
                      {t('pulseDeck.workbench.tasks.recordsCount', {
                        count: task.recordCount,
                      })}
                    </button>

                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={`automation-workflow-open-${task.workflowId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onOpenWorkflowStudio(task.workflowId);
                      }}
                      className="h-6 px-2 text-2xs"
                    >
                      <GitFork className="mr-1 h-3 w-3" />
                      {t('pulseDeck.workbench.tasks.openStudio')}
                    </Button>
                  </div>
                </div>

                {/* Clicking Workflow Info immediately opens embedded Workflow Studio */}
                <button
                  type="button"
                  data-testid={`automation-workflow-info-${task.workflowId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onOpenWorkflowStudio(task.workflowId);
                  }}
                  key={`${task.workflowId}-${i18n.language}`}
                  className="flex w-full items-center justify-between gap-2 rounded border border-border bg-[var(--surface-control)] px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <GitFork className="h-3 w-3 shrink-0 text-primary" />
                    <span className="truncate">{triggerInfo}</span>
                  </span>
                  {task.versionLabel ? (
                    <span className="shrink-0 font-mono tabular-nums">
                      {t('pulseDeck.workbench.tasks.workflowVersion', {
                        version: task.versionLabel,
                      })}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const detailPane = (
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
    />
  );

  return (
    <AutomationSplitFrame
      testId="automation-tab-tasks-split"
      master={masterPane}
      detail={detailPane}
    />
  );
}
