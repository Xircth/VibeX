import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  GitFork,
  Play,
  Rocket,
  Save,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PulseFilterBuilder } from '@/features/pulse';
import type {
  EventEnvelope,
  EventSourceKind,
  GateFilterCondition,
  PulseDryRunReport,
  PulseOutboxEntryView,
  PulseRuleSpec,
  PulseRuleView,
  PulseSourceView,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';
import { TaskStatusBadge } from './AutomationSplitFrame';
import {
  buildSampleEnvelopeForRule,
  type AutomationTaskStatus,
  type FastTaskEditorTab,
  type UnifiedAutomationTask,
} from './automationModels';
import {
  FastTaskCallbackEditor,
  FastTaskRecordsPane,
  FastTaskTargetEditor,
} from './FastTaskTargetAndCallbackEditors';

type EventPreset = {
  id: string;
  labelKey: string;
  sourceKind: EventSourceKind;
  eventTypes: string[];
  cronExpr?: string;
};

const EVENT_PRESETS: readonly EventPreset[] = [
  {
    id: 'gh_ci',
    labelKey: 'pulseDeck.workbench.editor.event.presetGhCi',
    sourceKind: 'github',
    eventTypes: ['github.workflow_run.completed'],
  },
  {
    id: 'gh_pr',
    labelKey: 'pulseDeck.workbench.editor.event.presetGhPr',
    sourceKind: 'github',
    eventTypes: ['github.pull_request.opened'],
  },
  {
    id: 'gh_comment',
    labelKey: 'pulseDeck.workbench.editor.event.presetGhComment',
    sourceKind: 'github',
    eventTypes: ['github.issue_comment.created'],
  },
  {
    id: 'feishu_mention',
    labelKey: 'pulseDeck.workbench.editor.event.presetFeishuMention',
    sourceKind: 'feishu',
    eventTypes: ['feishu.im.mention'],
  },
  {
    id: 'feishu_msg',
    labelKey: 'pulseDeck.workbench.editor.event.presetFeishuMsg',
    sourceKind: 'feishu',
    eventTypes: ['feishu.im.message'],
  },
  {
    id: 'feishu_card',
    labelKey: 'pulseDeck.workbench.editor.event.presetFeishuCard',
    sourceKind: 'feishu',
    eventTypes: ['feishu.card.action'],
  },
  {
    id: 'cron_daily',
    labelKey: 'pulseDeck.workbench.editor.event.presetCron',
    sourceKind: 'time_cron',
    eventTypes: ['pulse.schedule.tick'],
    cronExpr: '0 9 * * *',
  },
  {
    id: 'webhook_custom',
    labelKey: 'pulseDeck.workbench.editor.event.presetWebhook',
    sourceKind: 'webhook_custom',
    eventTypes: ['webhook.inbound'],
  },
];

export interface FastTaskEditorPaneProps {
  selectedWorkflowTask: Extract<UnifiedAutomationTask, { kind: 'workflow' }> | null;
  draftRuleId: string | null;
  draftSpec: PulseRuleSpec;
  existingRule: PulseRuleView | null;
  status: AutomationTaskStatus;
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
  onOpenWorkflowStudio: (definitionId?: string | null) => void;
}

export function FastTaskEditorPane({
  selectedWorkflowTask,
  draftRuleId,
  draftSpec,
  existingRule,
  status,
  activeSubTab,
  onSubTabChange,
  onSpecChange,
  sources,
  allRules,
  capturedEvents,
  recentOutbox,
  validationErrors,
  lastTestReport,
  saving,
  testing,
  publishing,
  converting,
  onSaveDraft,
  onTestTask,
  onEmitLiveSample,
  onPublishTask,
  onConvertToWorkflow,
  onDeleteTask,
  onJumpCreateSource,
  onOpenWorkflowStudio,
}: FastTaskEditorPaneProps) {
  const { t } = useTranslation('panels');
  const [showSampleEnvelope, setShowSampleEnvelope] = useState(false);
  const [ruleMode, setRuleMode] = useState<'inline' | 'template'>(() =>
    draftSpec.taskMeta?.boundRuleTemplateId ? 'template' : 'inline'
  );
  const [stepRuleReport, setStepRuleReport] =
    useState<PulseDryRunReport | null>(null);

  const sampleEnvelope = useMemo(
    () => buildSampleEnvelopeForRule(draftSpec),
    [draftSpec]
  );

  if (selectedWorkflowTask) {
    return (
      <div
        data-testid={`workflow-task-inspector-${selectedWorkflowTask.workflowId}`}
        className="flex flex-1 flex-col gap-4 p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {selectedWorkflowTask.name}
            </h3>
            <TaskStatusBadge status={selectedWorkflowTask.status} />
          </div>
          <Button
            type="button"
            size="sm"
            data-testid={`workflow-inspector-open-${selectedWorkflowTask.workflowId}`}
            onClick={() =>
              onOpenWorkflowStudio(selectedWorkflowTask.workflowId)
            }
          >
            <GitFork className="mr-1.5 h-3.5 w-3.5" />
            {t('pulseDeck.workbench.tasks.openStudio')}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {t('pulseDeck.workbench.tasks.workflowInspectorHint')}
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-[var(--surface-panel)] px-3 py-2">
            <div className="text-2xs text-muted-foreground">
              {t('pulseDeck.workbench.tasks.workflowTriggerLabel')}
            </div>
            <div className="mt-0.5 text-xs font-medium text-foreground">
              {selectedWorkflowTask.triggerRule
                ? selectedWorkflowTask.triggerRule.spec.name
                : t('pulseDeck.workbench.tasks.workflowDraft')}
            </div>
          </div>
          <div className="rounded-md border border-border bg-[var(--surface-panel)] px-3 py-2">
            <div className="text-2xs text-muted-foreground">
              {t('pulseDeck.workbench.tasks.workflowUpdatedAt')}
            </div>
            <div className="mt-0.5 text-xs font-medium tabular-nums text-foreground">
              {selectedWorkflowTask.updatedAt
                ? selectedWorkflowTask.updatedAt.slice(0, 19).replace('T', ' ')
                : '-'}
            </div>
          </div>
        </div>

        <FastTaskRecordsPane
          rule={selectedWorkflowTask.triggerRule}
          capturedEvents={capturedEvents}
          recentOutbox={recentOutbox}
        />
      </div>
    );
  }

  const subTabs: Array<{ id: FastTaskEditorTab; label: string }> = [
    { id: 'event', label: t('pulseDeck.workbench.editor.subTabs.event') },
    { id: 'rule', label: t('pulseDeck.workbench.editor.subTabs.rule') },
    { id: 'target', label: t('pulseDeck.workbench.editor.subTabs.target') },
    { id: 'callback', label: t('pulseDeck.workbench.editor.subTabs.callback') },
    { id: 'records', label: t('pulseDeck.workbench.editor.subTabs.records') },
  ];

  const addQuickCondition = (cond: GateFilterCondition) => {
    onSpecChange({
      ...draftSpec,
      filter: {
        ...draftSpec.filter,
        conditions: [...draftSpec.filter.conditions, cond],
      },
    });
  };

  const scheduleKind = draftSpec.temporal?.kind ?? 'none';

  return (
    <div
      data-testid="fasttask-editor-pane"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Editor Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-[var(--surface-panel)] px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            aria-label={t('pulseDeck.workbench.editor.taskNameAria')}
            data-testid="fasttask-name-input"
            placeholder={t('pulseDeck.workbench.editor.taskNamePlaceholder')}
            value={draftSpec.name}
            onChange={(e) =>
              onSpecChange({ ...draftSpec, name: e.target.value })
            }
            className="h-8 max-w-xs text-xs font-medium"
          />
          <TaskStatusBadge
            status={status}
            testId="fasttask-editor-status-badge"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            data-testid="fasttask-save-btn"
            onClick={onSaveDraft}
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            {saving
              ? t('pulseDeck.workbench.editor.saving')
              : t('pulseDeck.workbench.editor.saveDraft')}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing}
            data-testid="fasttask-test-btn"
            onClick={onTestTask}
          >
            <Play className="mr-1 h-3.5 w-3.5" />
            {testing
              ? t('pulseDeck.workbench.editor.testing')
              : t('pulseDeck.workbench.editor.testTask')}
          </Button>

          <Button
            type="button"
            size="sm"
            disabled={publishing}
            data-testid="fasttask-publish-btn"
            onClick={onPublishTask}
          >
            <Rocket className="mr-1 h-3.5 w-3.5" />
            {publishing
              ? t('pulseDeck.workbench.editor.publishing')
              : t('pulseDeck.workbench.editor.publish')}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={converting}
            data-testid="fasttask-convert-workflow-btn"
            onClick={onConvertToWorkflow}
          >
            <GitFork className="mr-1 h-3.5 w-3.5" />
            {converting
              ? t('pulseDeck.workbench.editor.converting')
              : t('pulseDeck.workbench.editor.convertToWorkflow')}
          </Button>

          {draftRuleId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="fasttask-delete-btn"
              onClick={onDeleteTask}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="sr-only">
                {t('pulseDeck.workbench.editor.delete')}
              </span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Validation & Test Banners */}
      {validationErrors.length > 0 ? (
        <div
          role="alert"
          data-testid="fasttask-validation-errors"
          className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {t('pulseDeck.workbench.editor.validationTitle')}
          </div>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {validationErrors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {lastTestReport ? (
        <div
          data-testid="fasttask-test-report"
          className={cn(
            'border-b px-4 py-2 text-xs',
            lastTestReport.valid && lastTestReport.matched
              ? 'border-success/30 bg-success/10 text-foreground'
              : 'border-warning/30 bg-warning/10 text-foreground'
          )}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            {lastTestReport.valid && lastTestReport.matched
              ? t('pulseDeck.workbench.editor.testPassedBanner')
              : t('pulseDeck.workbench.editor.testFilteredBanner')}
          </div>
          {lastTestReport.renderedPreviews[0] ? (
            <div className="mt-1 truncate font-mono text-2xs text-muted-foreground">
              {lastTestReport.renderedPreviews[0]}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 5 Sub-Tabs */}
      <div
        role="tablist"
        aria-label={t('pulseDeck.workbench.editor.subTabs.aria')}
        className="flex items-center gap-1 overflow-x-auto border-b border-border bg-[var(--surface-panel)] px-4 py-1.5"
      >
        {subTabs.map((tab) => {
          const active = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`fasttask-subtab-${tab.id}`}
              onClick={() => onSubTabChange(tab.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-[var(--surface-control)] hover:text-foreground'
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Sub-Tab Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeSubTab === 'event' ? (
          <div className="space-y-4" data-testid="fasttask-event-editor">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="fasttask-source-select" className="text-xs">
                  {t('pulseDeck.workbench.editor.event.connectedSource')}
                </Label>
                <button
                  type="button"
                  data-testid="fasttask-jump-create-source"
                  onClick={onJumpCreateSource}
                  className="text-2xs font-medium text-primary hover:underline"
                >
                  {t('pulseDeck.workbench.editor.event.jumpCreateSource')}
                </button>
              </div>
              <select
                id="fasttask-source-select"
                data-testid="fasttask-source-select"
                value={draftSpec.filter.sourceInstanceIds[0] ?? ''}
                onChange={(e) => {
                  const sourceId = e.target.value;
                  const chosen = sources.find((src) => src.id === sourceId);
                  onSpecChange({
                    ...draftSpec,
                    filter: {
                      ...draftSpec.filter,
                      sourceInstanceIds: sourceId ? [sourceId] : [],
                      sourceKinds: chosen
                        ? [chosen.kind]
                        : draftSpec.filter.sourceKinds,
                    },
                  });
                }}
                className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
              >
                <option value="">
                  {t('pulseDeck.workbench.editor.event.anySourceOfKind')}
                </option>
                {sources.map((src) => (
                  <option key={src.id} value={src.id}>
                    {src.title} ({src.kind})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('pulseDeck.workbench.editor.event.presetsLabel')}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {EVENT_PRESETS.map((preset) => {
                  const selected =
                    draftSpec.filter.sourceKinds[0] === preset.sourceKind &&
                    draftSpec.filter.eventTypes[0] === preset.eventTypes[0];
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`fasttask-event-preset-${preset.id}`}
                      aria-pressed={selected}
                      onClick={() =>
                        onSpecChange({
                          ...draftSpec,
                          temporal: preset.cronExpr
                            ? {
                                kind: 'cron',
                                expression: preset.cronExpr,
                                timezone: 'Asia/Shanghai',
                              }
                            : null,
                          filter: {
                            ...draftSpec.filter,
                            sourceKinds: [preset.sourceKind],
                            eventTypes: preset.eventTypes,
                          },
                        })
                      }
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Zap className="h-3 w-3 shrink-0" />
                      {t(preset.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fasttask-event-types" className="text-xs">
                {t('pulseDeck.workbench.editor.event.eventTypeLabel')}
              </Label>
              <Input
                id="fasttask-event-types"
                data-testid="fasttask-event-types"
                value={draftSpec.filter.eventTypes.join(', ')}
                onChange={(e) =>
                  onSpecChange({
                    ...draftSpec,
                    filter: {
                      ...draftSpec.filter,
                      eventTypes: e.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    },
                  })
                }
                className="h-8 font-mono text-xs"
              />
            </div>

            {/* Temporal Schedule Editor */}
            <div className="space-y-2 border-t border-border pt-3">
              <Label htmlFor="fasttask-schedule-mode" className="text-xs">
                {t('pulseDeck.workbench.editor.event.scheduleModeLabel')}
              </Label>
              <select
                id="fasttask-schedule-mode"
                value={scheduleKind === 'cron' || scheduleKind === 'interval' ? scheduleKind : 'none'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'cron') {
                    onSpecChange({
                      ...draftSpec,
                      temporal: {
                        kind: 'cron',
                        expression: '0 9 * * *',
                        timezone: 'Asia/Shanghai',
                      },
                      filter: {
                        ...draftSpec.filter,
                        sourceKinds: ['time_cron'],
                      },
                    });
                  } else if (val === 'interval') {
                    onSpecChange({
                      ...draftSpec,
                      temporal: {
                        kind: 'interval',
                        everySeconds: 300,
                        skipIfBusy: true,
                      },
                      filter: {
                        ...draftSpec.filter,
                        sourceKinds: ['time_interval'],
                      },
                    });
                  } else {
                    onSpecChange({ ...draftSpec, temporal: null });
                  }
                }}
                className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
              >
                <option value="none">
                  {t('pulseDeck.workbench.editor.event.scheduleNone')}
                </option>
                <option value="cron">
                  {t('pulseDeck.workbench.editor.event.scheduleCron')}
                </option>
                <option value="interval">
                  {t('pulseDeck.workbench.editor.event.scheduleInterval')}
                </option>
              </select>

              {draftSpec.temporal?.kind === 'cron' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="fasttask-cron-expr" className="text-2xs">
                      {t('pulseDeck.workbench.editor.event.cronExprLabel')}
                    </Label>
                    <Input
                      id="fasttask-cron-expr"
                      value={draftSpec.temporal.expression}
                      onChange={(e) =>
                        onSpecChange({
                          ...draftSpec,
                          temporal: {
                            kind: 'cron',
                            expression: e.target.value,
                            timezone:
                              draftSpec.temporal?.kind === 'cron'
                                ? draftSpec.temporal.timezone
                                : 'Asia/Shanghai',
                          },
                        })
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="fasttask-cron-tz" className="text-2xs">
                      {t('pulseDeck.workbench.editor.event.timezoneLabel')}
                    </Label>
                    <Input
                      id="fasttask-cron-tz"
                      value={draftSpec.temporal.timezone}
                      onChange={(e) =>
                        onSpecChange({
                          ...draftSpec,
                          temporal: {
                            kind: 'cron',
                            expression:
                              draftSpec.temporal?.kind === 'cron'
                                ? draftSpec.temporal.expression
                                : '0 9 * * *',
                            timezone: e.target.value,
                          },
                        })
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>
              ) : null}

              {draftSpec.temporal?.kind === 'interval' ? (
                <div className="space-y-1">
                  <Label htmlFor="fasttask-interval-sec" className="text-2xs">
                    {t('pulseDeck.workbench.editor.event.intervalSecondsLabel')}
                  </Label>
                  <Input
                    id="fasttask-interval-sec"
                    type="number"
                    min={10}
                    value={draftSpec.temporal.everySeconds}
                    onChange={(e) =>
                      onSpecChange({
                        ...draftSpec,
                        temporal: {
                          kind: 'interval',
                          everySeconds: Math.max(
                            10,
                            Number(e.target.value) || 60
                          ),
                          skipIfBusy: true,
                        },
                      })
                    }
                    className="h-8 w-40 tabular-nums text-xs"
                  />
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="fasttask-event-sample-btn"
                onClick={() => setShowSampleEnvelope((prev) => !prev)}
              >
                {t('pulseDeck.workbench.editor.event.samplePreviewBtn')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="fasttask-event-live-emit-btn"
                onClick={onEmitLiveSample}
              >
                {t('pulseDeck.workbench.editor.event.liveEmitBtn')}
              </Button>
            </div>

            {showSampleEnvelope ? (
              <div
                data-testid="fasttask-event-sample-json"
                className="rounded-md border border-border bg-[var(--surface-panel)] p-2.5"
              >
                <div className="mb-1 text-2xs font-medium text-foreground">
                  {t('pulseDeck.workbench.editor.event.samplePreviewTitle')}
                </div>
                <pre className="max-h-44 overflow-auto font-mono text-2xs text-muted-foreground">
                  {JSON.stringify(sampleEnvelope, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}

        {activeSubTab === 'rule' ? (
          <div className="space-y-4" data-testid="fasttask-rule-editor">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="fasttask-rule-mode-inline"
                aria-pressed={ruleMode === 'inline'}
                onClick={() => setRuleMode('inline')}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  ruleMode === 'inline'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                )}
              >
                {t('pulseDeck.workbench.editor.rule.modeInline')}
              </button>
              <button
                type="button"
                data-testid="fasttask-rule-mode-template"
                aria-pressed={ruleMode === 'template'}
                onClick={() => setRuleMode('template')}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  ruleMode === 'template'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                )}
              >
                {t('pulseDeck.workbench.editor.rule.modeTemplate')}
              </button>
            </div>

            {ruleMode === 'template' ? (
              <div className="space-y-1.5">
                <Label htmlFor="fasttask-template-select" className="text-xs">
                  {t('pulseDeck.workbench.editor.rule.selectTemplateLabel')}
                </Label>
                <select
                  id="fasttask-template-select"
                  data-testid="fasttask-template-select"
                  value={draftSpec.taskMeta?.boundRuleTemplateId ?? ''}
                  onChange={(e) => {
                    const tplId = e.target.value;
                    const chosen = allRules.find((r) => r.id === tplId);
                    if (chosen) {
                      onSpecChange({
                        ...draftSpec,
                        filter: chosen.spec.filter,
                        taskMeta: {
                          ...draftSpec.taskMeta,
                          taskKind: 'fast_task',
                          boundRuleTemplateId: chosen.id,
                        },
                      });
                    }
                  }}
                  className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
                >
                  <option value="">
                    {t(
                      'pulseDeck.workbench.editor.rule.selectTemplatePlaceholder'
                    )}
                  </option>
                  {allRules
                    .filter((r) => r.id !== draftRuleId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.spec.name}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('pulseDeck.workbench.editor.rule.quickChipsLabel')}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-testid="fasttask-chip-ci-failure"
                  onClick={() =>
                    addQuickCondition({
                      op: 'eq',
                      pointer: '/workflow_run/conclusion',
                      value: 'failure',
                    })
                  }
                  className="rounded-full border border-border bg-[var(--surface-control)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  + {t('pulseDeck.workbench.editor.rule.chipCiFailure')}
                </button>
                <button
                  type="button"
                  data-testid="fasttask-chip-branch-main"
                  onClick={() =>
                    addQuickCondition({
                      op: 'eq',
                      pointer: '/workflow_run/head_branch',
                      value: 'main',
                    })
                  }
                  className="rounded-full border border-border bg-[var(--surface-control)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  + {t('pulseDeck.workbench.editor.rule.chipBranchMain')}
                </button>
                <button
                  type="button"
                  data-testid="fasttask-chip-human-only"
                  onClick={() => addQuickCondition({ op: 'not_bot_actor' })}
                  className="rounded-full border border-border bg-[var(--surface-control)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  + {t('pulseDeck.workbench.editor.rule.chipHumanOnly')}
                </button>
                <button
                  type="button"
                  data-testid="fasttask-chip-urgent"
                  onClick={() =>
                    addQuickCondition({
                      op: 'contains',
                      pointer: '/text',
                      needle: 'urgent',
                    })
                  }
                  className="rounded-full border border-border bg-[var(--surface-control)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  + {t('pulseDeck.workbench.editor.rule.chipUrgentText')}
                </button>
              </div>
            </div>

            <PulseFilterBuilder
              filter={draftSpec.filter}
              ruleSpec={draftSpec}
              showDryRun={false}
              onChange={(nextFilter) =>
                onSpecChange({ ...draftSpec, filter: nextFilter })
              }
            />

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="fasttask-rule-step-test-btn"
                onClick={() => {
                  const local = evaluatePulseRuleLocally(
                    draftSpec,
                    sampleEnvelope
                  );
                  setStepRuleReport(local);
                }}
              >
                {t('pulseDeck.workbench.editor.rule.stepTestBtn')}
              </Button>
              {stepRuleReport ? (
                <span
                  data-testid="fasttask-rule-step-result"
                  className={cn(
                    'text-xs font-medium',
                    stepRuleReport.matched
                      ? 'text-success'
                      : 'text-muted-foreground'
                  )}
                >
                  {stepRuleReport.matched
                    ? t('pulseDeck.workbench.editor.rule.stepMatched')
                    : t('pulseDeck.workbench.editor.rule.stepFiltered', {
                        indices:
                          stepRuleReport.unmatchedConditions.join(', ') || '-',
                      })}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeSubTab === 'target' ? (
          <FastTaskTargetEditor spec={draftSpec} onChange={onSpecChange} />
        ) : null}

        {activeSubTab === 'callback' ? (
          <FastTaskCallbackEditor spec={draftSpec} onChange={onSpecChange} />
        ) : null}

        {activeSubTab === 'records' ? (
          <FastTaskRecordsPane
            rule={existingRule}
            capturedEvents={capturedEvents}
            recentOutbox={recentOutbox}
          />
        ) : null}
      </div>
    </div>
  );
}
