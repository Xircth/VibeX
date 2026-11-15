import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Filter,
  Play,
  Plus,
  Save,
  Trash2,
  Zap,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BUILT_IN_SAMPLE_EVENTS,
  PulseEvalModeControl,
  PulseFilterBuilder,
} from '@/features/pulse';
import {
  pulseApi,
  type EventEnvelope,
  type PulseDryRunReport,
  type PulseEvalMode,
  type PulseRuleSpec,
  type PulseRuleView,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import {
  AutomationSplitFrame,
  groupHeaderCell,
  interactiveRowStyle,
  selectedTableRowStyle,
} from './AutomationSplitFrame';
import {
  buildSampleEnvelopeForRule,
  isReusableRuleTemplate,
} from './automationModels';

function buildNewRuleTemplateSpec(
  defaultName: string,
  projectId?: string | null
): PulseRuleSpec {
  return {
    name: defaultName,
    description: '',
    projectId: projectId ?? null,
    evalMode: 'observe',
    filter: {
      sourceKinds: ['github'],
      sourceInstanceIds: [],
      eventTypes: ['github.workflow_run.completed'],
      allowedActors: [],
      conditions: [
        { op: 'eq', pointer: '/workflow_run/conclusion', value: 'failure' },
      ],
    },
    targets: [
      {
        kind: 'session',
        mode: 'thread_keyed',
        agentId: 'claude-code',
        workspaceIsolation: 'isolated_worktree',
        promptTemplate: 'Analyze {{event.eventType}} on {{threadKey}}',
      },
    ],
    taskMeta: {
      taskKind: 'reusable_rule',
      lifecycleState: 'published',
    },
  };
}

export interface AutomationRulesTabProps {
  renderHeader?: (
    toolbarRow?: ReactNode,
    contextualAction?: ReactNode
  ) => ReactNode;
  projectId?: string | null;
  rules: readonly PulseRuleView[];
  capturedEvents: readonly EventEnvelope[];
  onSetRuleMode: (rule: PulseRuleView, mode: PulseEvalMode) => void;
  onSaveRule: (
    ruleId: string | null,
    spec: PulseRuleSpec,
    enabled: boolean
  ) => Promise<PulseRuleView | null>;
  onDeleteRule: (ruleId: string) => void;
  onCreateFastTaskFromRule: (
    spec: PulseRuleSpec,
    templateId?: string | null
  ) => void;
}

export function AutomationRulesTab({
  renderHeader,
  projectId,
  rules,
  capturedEvents,
  onSetRuleMode,
  onSaveRule,
  onDeleteRule,
  onCreateFastTaskFromRule,
}: AutomationRulesTabProps) {
  const { t, i18n } = useTranslation('panels');
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(
    () => rules[0]?.id ?? null
  );
  const [creatingNew, setCreatingNew] = useState(rules.length === 0);
  const [draftSpec, setDraftSpec] = useState<PulseRuleSpec>(
    () =>
      rules[0]?.spec ??
      buildNewRuleTemplateSpec(t('pulseDeck.composerTitle'), projectId)
  );
  const [saving, setSaving] = useState(false);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [dryRunReport, setDryRunReport] = useState<PulseDryRunReport | null>(
    null
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(['templates', 'task_rules'])
  );

  const sampleOptions = useMemo(() => {
    const generated = buildSampleEnvelopeForRule(draftSpec);
    const merged = [generated, ...capturedEvents, ...BUILT_IN_SAMPLE_EVENTS];
    const seen = new Set<string>();
    return merged.filter((item) => {
      if (seen.has(item.eventId)) return false;
      seen.add(item.eventId);
      return true;
    });
  }, [capturedEvents, draftSpec]);

  const [selectedSampleId, setSelectedSampleId] = useState<string>(
    () => sampleOptions[0]?.eventId ?? ''
  );

  useEffect(() => {
    if (creatingNew) return;
    const match = rules.find((item) => item.id === selectedRuleId) ?? rules[0];
    if (match) {
      setSelectedRuleId(match.id);
      setDraftSpec(match.spec);
    }
  }, [creatingNew, rules, selectedRuleId]);

  const usageCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const rule of rules) {
      const tplId = rule.spec.taskMeta?.boundRuleTemplateId;
      if (tplId) {
        map.set(tplId, (map.get(tplId) ?? 0) + 1);
      }
    }
    return map;
  }, [rules]);

  const groupedRules = useMemo(() => {
    const map = new Map<'templates' | 'task_rules', PulseRuleView[]>([
      ['templates', []],
      ['task_rules', []],
    ]);
    for (const rule of rules) {
      if (isReusableRuleTemplate(rule)) {
        map.get('templates')?.push(rule);
      } else {
        map.get('task_rules')?.push(rule);
      }
    }
    return map;
  }, [rules]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedRule = creatingNew
    ? null
    : (rules.find((r) => r.id === selectedRuleId) ?? null);

  const handleSelectRule = (rule: PulseRuleView) => {
    setCreatingNew(false);
    setSelectedRuleId(rule.id);
    setDraftSpec(rule.spec);
    setDryRunReport(null);
  };

  const handleStartNew = () => {
    setCreatingNew(true);
    setSelectedRuleId(null);
    setDraftSpec(
      buildNewRuleTemplateSpec(t('pulseDeck.composerTitle'), projectId)
    );
    setDryRunReport(null);
  };

  const handleRunBackendDryRun = async () => {
    const chosenSample =
      sampleOptions.find((item) => item.eventId === selectedSampleId) ??
      sampleOptions[0] ??
      buildSampleEnvelopeForRule(draftSpec);
    setRunningDryRun(true);
    const localReport = evaluatePulseRuleLocally(draftSpec, chosenSample);
    setDryRunReport(localReport);
    try {
      const remote = await pulseApi.dryRunRule(draftSpec, chosenSample);
      setDryRunReport(remote);
    } catch {
      // Keep deterministic local report when backend RPC is unavailable
    } finally {
      setRunningDryRun(false);
    }
  };

  const handleSave = async () => {
    if (!draftSpec.name.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await onSaveRule(
        creatingNew ? null : selectedRuleId,
        draftSpec,
        selectedRule ? selectedRule.enabled : true
      );
      if (saved) {
        setCreatingNew(false);
        setSelectedRuleId(saved.id);
      }
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo<TableColumn<Record<string, unknown>>[]>(
    () => [
      {
        key: 'name',
        header: t('pulseDeck.workbench.rules.colName'),
        width: proportional(1.2),
      },
      {
        key: 'mode',
        header: t('pulseDeck.workbench.rules.colMode'),
        width: pixel(172),
      },
      {
        key: 'stats',
        header: t('pulseDeck.workbench.rules.colStats'),
        width: proportional(0.9),
      },
    ],
    [t, i18n.language]
  );

  const resolvedWidths = useMemo(
    () => resolveColumnWidths(columns),
    [columns]
  );

  const newTemplateAction = (
    <AstryxButton
      label={t('pulseDeck.workbench.rules.newTemplateBtn')}
      variant="secondary"
      size="md"
      icon={<Icon icon={Plus} size="sm" />}
      data-testid="rules-new-template-btn"
      onClick={handleStartNew}
    />
  );

  const isReusable = draftSpec.taskMeta?.taskKind === 'reusable_rule';

  const masterPane = (
    <div data-testid="pulse-deck-rules-list" className="min-h-0 flex-1">
      {rules.length === 0 ? (
        <div className="p-8">
          <EmptyState
            icon={<Icon icon={Filter} size="lg" color="secondary" />}
            title={t('pulseDeck.workbench.rules.emptyList')}
            actions={newTemplateAction}
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
            {(['templates', 'task_rules'] as const).map((groupKey) => {
              const groupItems = groupedRules.get(groupKey);
              if (!groupItems || groupItems.length === 0) return null;
              const isExpanded = expandedGroups.has(groupKey);
              const groupTitle =
                groupKey === 'templates'
                  ? t('pulseDeck.workbench.rules.groupTemplates')
                  : t('pulseDeck.workbench.rules.groupTaskRules');

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
                        <Icon icon={Filter} size="sm" color="secondary" />
                        <Text type="body" weight="bold">
                          {groupTitle}
                        </Text>
                        <Badge
                          variant="neutral"
                          label={String(groupItems.length)}
                          className="tabular-nums"
                        />
                      </HStack>
                    </TableCell>
                  </TableRow>

                  {isExpanded &&
                    groupItems.map((rule) => {
                      const active =
                        !creatingNew && selectedRuleId === rule.id;
                      const usedCount = usageCounts.get(rule.id) ?? 0;
                      const rowStyle = active
                        ? { ...interactiveRowStyle, ...selectedTableRowStyle }
                        : interactiveRowStyle;

                      return (
                        <TableRow
                          key={rule.id}
                          data-testid={`pulse-deck-rule-${rule.id}`}
                          style={rowStyle}
                          onClick={() => handleSelectRule(rule)}
                        >
                          <TableCell>
                            <HStack gap={2} vAlign="center">
                              <Text
                                type="body"
                                weight="medium"
                                maxLines={1}
                              >
                                {rule.spec.name}
                              </Text>
                              {usedCount > 0 ? (
                                <Badge
                                  variant="neutral"
                                  label={t(
                                    'pulseDeck.workbench.rules.usedByCount',
                                    { count: usedCount }
                                  )}
                                  className="tabular-nums"
                                />
                              ) : null}
                            </HStack>
                          </TableCell>
                          <TableCell>
                            <div onClick={(e) => e.stopPropagation()}>
                              <PulseEvalModeControl
                                size="sm"
                                value={rule.spec.evalMode}
                                ariaLabel={t('pulseDeck.ruleModeAria', {
                                  name: rule.spec.name,
                                })}
                                onChange={(nextMode) =>
                                  onSetRuleMode(rule, nextMode)
                                }
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <span
                              data-testid={`pulse-deck-rule-counts-${rule.id}`}
                              className="text-xs tabular-nums text-muted-foreground"
                            >
                              {t('pulseDeck.ruleCounts', {
                                matched: rule.matchedCount,
                                observed: rule.observedCount,
                              })}
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

  const detailPane = (
    <div data-testid="automation-rule-lab">
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <PulseEvalModeControl
              size="sm"
              value={draftSpec.evalMode}
              onChange={(mode) =>
                setDraftSpec({ ...draftSpec, evalMode: mode })
              }
            />
          </StackItem>
          <HStack gap={1.5} vAlign="center" wrap="wrap">
            <AstryxButton
              label={t('pulseDeck.workbench.rules.createFastTaskFromRule')}
              variant="secondary"
              size="sm"
              icon={<Icon icon={Zap} size="sm" />}
              data-testid="rule-create-fasttask-btn"
              onClick={() =>
                onCreateFastTaskFromRule(
                  draftSpec,
                  creatingNew ? null : selectedRuleId
                )
              }
            />
            <AstryxButton
              label={t('pulseDeck.workbench.rules.saveRuleBtn')}
              variant="primary"
              size="sm"
              isDisabled={saving}
              icon={<Icon icon={Save} size="sm" />}
              data-testid="rule-lab-save-btn"
              onClick={() => void handleSave()}
            />
            {selectedRule ? (
              <AstryxButton
                label={t('pulseDeck.workbench.tasks.quickDelete')}
                variant="ghost"
                size="sm"
                isIconOnly
                icon={<Icon icon={Trash2} size="sm" />}
                data-testid="rule-lab-delete-btn"
                onClick={() => onDeleteRule(selectedRule.id)}
              />
            ) : null}
          </HStack>
        </HStack>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rule-lab-name" className="text-xs">
              {t('pulseDeck.workbench.rules.ruleNameLabel')}
            </Label>
            <Input
              id="rule-lab-name"
              data-testid="rule-lab-name-input"
              value={draftSpec.name}
              onChange={(e) =>
                setDraftSpec({ ...draftSpec, name: e.target.value })
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-lab-desc" className="text-xs">
              {t('pulseDeck.workbench.rules.ruleDescLabel')}
            </Label>
            <Input
              id="rule-lab-desc"
              placeholder={t('pulseDeck.workbench.rules.ruleDescPlaceholder')}
              value={draftSpec.description ?? ''}
              onChange={(e) =>
                setDraftSpec({
                  ...draftSpec,
                  description: e.target.value || null,
                })
              }
              className="h-8 text-xs"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-foreground">
          <Checkbox
            checked={isReusable}
            onCheckedChange={(checked) =>
              setDraftSpec({
                ...draftSpec,
                taskMeta: {
                  ...draftSpec.taskMeta,
                  taskKind: checked === true ? 'reusable_rule' : 'fast_task',
                },
              })
            }
          />
          <span>{t('pulseDeck.workbench.rules.markReusableLabel')}</span>
        </label>

        <PulseFilterBuilder
          filter={draftSpec.filter}
          ruleSpec={draftSpec}
          showDryRun={false}
          onChange={(nextFilter) =>
            setDraftSpec({ ...draftSpec, filter: nextFilter })
          }
        />

        {/* Backend Live Dry-Run Lab */}
        <div className="space-y-2.5 rounded-lg bg-[var(--color-background-muted)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {t('pulseDeck.workbench.rules.dryRunLabTitle')}
            </span>
            <div className="flex items-center gap-2">
              <select
                aria-label={t('pulseFilter.selectSampleAria')}
                value={selectedSampleId}
                onChange={(e) => setSelectedSampleId(e.target.value)}
                className="h-7 rounded-md border border-border bg-background px-2 text-2xs text-foreground"
              >
                {sampleOptions.map((sample) => (
                  <option key={sample.eventId} value={sample.eventId}>
                    {sample.eventType} ({sample.source.kind})
                  </option>
                ))}
              </select>
              <AstryxButton
                label={t('pulseDeck.workbench.rules.runDryRunBtn')}
                variant="secondary"
                size="sm"
                isDisabled={runningDryRun}
                icon={<Icon icon={Play} size="sm" />}
                data-testid="rule-lab-dryrun-btn"
                onClick={() => void handleRunBackendDryRun()}
              />
            </div>
          </div>

          {dryRunReport ? (
            <div
              data-testid="rule-lab-dryrun-result"
              className="rounded-md bg-background p-3 text-xs"
            >
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {dryRunReport.matched
                  ? t('pulseDeck.matched')
                  : t('pulseDeck.filtered')}
              </div>
              {dryRunReport.renderedPreviews[0] ? (
                <pre className="mt-1.5 overflow-x-auto font-mono text-2xs text-muted-foreground">
                  {dryRunReport.renderedPreviews[0]}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </VStack>
    </div>
  );

  return (
    <AutomationSplitFrame
      testId="automation-tab-rules-split"
      header={renderHeader?.(undefined, newTemplateAction)}
      master={masterPane}
      detail={detailPane}
    />
  );
}
