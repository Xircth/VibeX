import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '@astryxdesign/core/Banner';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Heading, Text } from '@astryxdesign/core/Text';
import {
  GitFork,
  MoreHorizontal,
  Play,
  Rocket,
  Save,
  Trash2,
  X,
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
  onClose?: () => void;
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
  onClose,
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
      >
        <VStack gap={4}>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <TaskStatusBadge status={selectedWorkflowTask.status} />
            </StackItem>
            {onClose ? (
              <AstryxButton
                label={t('pulseDeck.workbench.actions.closePanel')}
                variant="ghost"
                size="sm"
                icon={<Icon icon={X} size="sm" />}
                isIconOnly
                data-testid="automation-detail-close-btn"
                onClick={onClose}
              />
            ) : null}
          </HStack>

          <VStack gap={1}>
            <Heading level={3}>{selectedWorkflowTask.name}</Heading>
            <Text type="supporting" color="secondary">
              {t('pulseDeck.workbench.tasks.workflowInspectorHint')}
            </Text>
          </VStack>

          <AstryxButton
            label={t('pulseDeck.workbench.tasks.openStudio')}
            variant="primary"
            size="md"
            width="100%"
            icon={<Icon icon={GitFork} size="sm" />}
            data-testid={`workflow-inspector-open-${selectedWorkflowTask.workflowId}`}
            onClick={() => onOpenWorkflowStudio(selectedWorkflowTask.workflowId)}
          />

          <MetadataList label={{ position: 'start' }}>
            <MetadataListItem
              label={t('pulseDeck.workbench.tasks.workflowTriggerLabel')}
            >
              {selectedWorkflowTask.triggerRule
                ? selectedWorkflowTask.triggerRule.spec.name
                : t('pulseDeck.workbench.tasks.workflowDraft')}
            </MetadataListItem>
            {selectedWorkflowTask.versionLabel ? (
              <MetadataListItem label="Version">
                <span className="tabular-nums">
                  {t('pulseDeck.workbench.tasks.workflowVersion', {
                    version: selectedWorkflowTask.versionLabel,
                  })}
                </span>
              </MetadataListItem>
            ) : null}
            <MetadataListItem
              label={t('pulseDeck.workbench.tasks.workflowUpdatedAt')}
            >
              <span className="tabular-nums">
                {selectedWorkflowTask.updatedAt
                  ? selectedWorkflowTask.updatedAt.slice(0, 19).replace('T', ' ')
                  : '—'}
              </span>
            </MetadataListItem>
          </MetadataList>

          <FastTaskRecordsPane
            rule={selectedWorkflowTask.triggerRule}
            capturedEvents={capturedEvents}
            recentOutbox={recentOutbox}
          />
        </VStack>
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
    <div data-testid="fasttask-editor-pane">
      <VStack gap={4}>
        {/* Detail Header matching Astryx TaskDetailPanel */}
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <TaskStatusBadge
              status={status}
              testId="fasttask-editor-status-badge"
            />
          </StackItem>

          <HStack gap={1.5} vAlign="center">
            <AstryxButton
              label={
                saving
                  ? t('pulseDeck.workbench.editor.saving')
                  : t('pulseDeck.workbench.editor.saveDraft')
              }
              variant="secondary"
              size="sm"
              isDisabled={saving}
              icon={<Icon icon={Save} size="sm" />}
              data-testid="fasttask-save-btn"
              onClick={onSaveDraft}
            />
            <AstryxButton
              label={
                testing
                  ? t('pulseDeck.workbench.editor.testing')
                  : t('pulseDeck.workbench.editor.testTask')
              }
              variant="secondary"
              size="sm"
              isDisabled={testing}
              icon={<Icon icon={Play} size="sm" />}
              data-testid="fasttask-test-btn"
              onClick={onTestTask}
            />
            <AstryxButton
              label={
                publishing
                  ? t('pulseDeck.workbench.editor.publishing')
                  : t('pulseDeck.workbench.editor.publish')
              }
              variant="primary"
              size="sm"
              isDisabled={publishing}
              icon={<Icon icon={Rocket} size="sm" />}
              data-testid="fasttask-publish-btn"
              onClick={onPublishTask}
            />

            <DropdownMenu
              alignment="end"
              hasChevron={false}
              button={{
                label: t('pulseDeck.workbench.actions.moreActions'),
                variant: 'ghost',
                size: 'sm',
                icon: <Icon icon={MoreHorizontal} size="sm" />,
                isIconOnly: true,
              }}
              items={[
                {
                  label: converting
                    ? t('pulseDeck.workbench.editor.converting')
                    : t('pulseDeck.workbench.editor.convertToWorkflow'),
                  icon: GitFork,
                  isDisabled: converting,
                  onClick: onConvertToWorkflow,
                },
                ...(draftRuleId
                  ? [
                      { type: 'divider' as const },
                      {
                        label: t('pulseDeck.workbench.editor.delete'),
                        icon: Trash2,
                        onClick: onDeleteTask,
                      },
                    ]
                  : []),
              ]}
            />

            {onClose ? (
              <AstryxButton
                label={t('pulseDeck.workbench.actions.closePanel')}
                variant="ghost"
                size="sm"
                icon={<Icon icon={X} size="sm" />}
                isIconOnly
                data-testid="automation-detail-close-btn"
                onClick={onClose}
              />
            ) : null}
          </HStack>
        </HStack>

        {/* Task Name */}
        <Input
          aria-label={t('pulseDeck.workbench.editor.taskNameAria')}
          data-testid="fasttask-name-input"
          placeholder={t('pulseDeck.workbench.editor.taskNamePlaceholder')}
          value={draftSpec.name}
          onChange={(e) => onSpecChange({ ...draftSpec, name: e.target.value })}
          className="h-8 text-xs font-semibold"
        />

        {/* Validation & Test Banners */}
        {validationErrors.length > 0 ? (
          <div data-testid="fasttask-validation-errors">
            <Banner
              status="error"
              container="card"
              title={t('pulseDeck.workbench.editor.validationTitle')}
              defaultIsExpanded
            >
              <ul className="list-inside list-disc space-y-0.5 text-xs">
                {validationErrors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </Banner>
          </div>
        ) : null}

        {lastTestReport ? (
          <div data-testid="fasttask-test-report">
            <Banner
              status={
                lastTestReport.valid && lastTestReport.matched
                  ? 'success'
                  : 'warning'
              }
              container="card"
              title={
                lastTestReport.valid && lastTestReport.matched
                  ? t('pulseDeck.workbench.editor.testPassedBanner')
                  : t('pulseDeck.workbench.editor.testFilteredBanner')
              }
              description={lastTestReport.renderedPreviews[0] ?? undefined}
            />
          </div>
        ) : null}

        {/* Clean Borderless SegmentedControl for 5 Configuration Stages */}
        <SegmentedControl
          value={activeSubTab}
          onChange={(val) => onSubTabChange(val as FastTaskEditorTab)}
          label={t('pulseDeck.workbench.editor.subTabs.aria')}
          layout="fill"
          size="sm"
        >
          {subTabs.map((tab) => (
            <SegmentedControlItem
              key={tab.id}
              value={tab.id}
              label={tab.label}
              data-testid={`fasttask-subtab-${tab.id}`}
            />
          ))}
        </SegmentedControl>

        {/* Stage Content — clean whitespace spacing, zero redundant horizontal lines */}
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
                className="raised-control h-8 w-full rounded-md px-2.5 text-xs text-foreground"
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
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
                        selected
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-[var(--color-background-muted)] text-muted-foreground hover:text-foreground'
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

            <div className="space-y-2">
              <Label htmlFor="fasttask-schedule-mode" className="text-xs">
                {t('pulseDeck.workbench.editor.event.scheduleModeLabel')}
              </Label>
              <select
                id="fasttask-schedule-mode"
                value={
                  scheduleKind === 'cron' || scheduleKind === 'interval'
                    ? scheduleKind
                    : 'none'
                }
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
                className="raised-control h-8 w-full rounded-md px-2.5 text-xs text-foreground"
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
                className="rounded-md bg-[var(--color-background-muted)] p-2.5"
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
            <SegmentedControl
              value={ruleMode}
              onChange={(val) => setRuleMode(val as 'inline' | 'template')}
              label={t('pulseDeck.workbench.editor.subTabs.rule')}
              size="sm"
            >
              <SegmentedControlItem
                value="inline"
                label={t('pulseDeck.workbench.editor.rule.modeInline')}
                data-testid="fasttask-rule-mode-inline"
              />
              <SegmentedControlItem
                value="template"
                label={t('pulseDeck.workbench.editor.rule.modeTemplate')}
                data-testid="fasttask-rule-mode-template"
              />
            </SegmentedControl>

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
                  className="raised-control h-8 w-full rounded-md px-2.5 text-xs text-foreground"
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
                  className="rounded-full bg-[var(--color-background-muted)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
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
                  className="rounded-full bg-[var(--color-background-muted)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  + {t('pulseDeck.workbench.editor.rule.chipBranchMain')}
                </button>
                <button
                  type="button"
                  data-testid="fasttask-chip-human-only"
                  onClick={() => addQuickCondition({ op: 'not_bot_actor' })}
                  className="rounded-full bg-[var(--color-background-muted)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
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
                  className="rounded-full bg-[var(--color-background-muted)] px-2.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
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

            <div className="flex flex-wrap items-center gap-2 pt-1">
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
      </VStack>
    </div>
  );
}
