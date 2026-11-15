import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Play, Plus, Save, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import { AutomationSplitFrame } from './AutomationSplitFrame';
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
      conditions: [{ op: 'eq', pointer: '/workflow_run/conclusion', value: 'failure' }],
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
  onCreateFastTaskFromRule: (spec: PulseRuleSpec, templateId?: string | null) => void;
}

export function AutomationRulesTab({
  projectId,
  rules,
  capturedEvents,
  onSetRuleMode,
  onSaveRule,
  onDeleteRule,
  onCreateFastTaskFromRule,
}: AutomationRulesTabProps) {
  const { t } = useTranslation('panels');
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(
    () => rules[0]?.id ?? null
  );
  const [creatingNew, setCreatingNew] = useState(rules.length === 0);
  const [draftSpec, setDraftSpec] = useState<PulseRuleSpec>(() =>
    rules[0]?.spec ??
    buildNewRuleTemplateSpec(t('pulseDeck.composerTitle'), projectId)
  );
  const [saving, setSaving] = useState(false);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [dryRunReport, setDryRunReport] = useState<PulseDryRunReport | null>(
    null
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

  const isReusable = draftSpec.taskMeta?.taskKind === 'reusable_rule';

  const masterPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground">
          {t('pulseDeck.rulesTitle')}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="rules-new-template-btn"
          onClick={handleStartNew}
          className="h-7 px-2.5 text-2xs"
        >
          <Plus className="mr-1 h-3 w-3" />
          {t('pulseDeck.workbench.rules.newTemplateBtn')}
        </Button>
      </div>

      <div
        data-testid="pulse-deck-rules-list"
        className="flex-1 divide-y divide-border overflow-y-auto"
      >
        {rules.length === 0 ? (
          <div className="p-5 text-xs text-muted-foreground">
            {t('pulseDeck.workbench.rules.emptyList')}
          </div>
        ) : (
          rules.map((rule) => {
            const active = !creatingNew && selectedRuleId === rule.id;
            const usedCount = usageCounts.get(rule.id) ?? 0;
            return (
              <div
                key={rule.id}
                data-testid={`pulse-deck-rule-${rule.id}`}
                onClick={() => handleSelectRule(rule)}
                className={cn(
                  'cursor-pointer space-y-1.5 px-3 py-2.5 transition-colors',
                  active
                    ? 'bg-[var(--surface-elevated)]'
                    : 'hover:bg-[var(--surface-control)]/50'
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {rule.spec.name}
                    </span>
                    {isReusableRuleTemplate(rule) ? (
                      <span className="rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                        {t('pulseDeck.workbench.rules.reusableBadge')}
                      </span>
                    ) : null}
                  </div>
                  <PulseEvalModeControl
                    size="sm"
                    value={rule.spec.evalMode}
                    ariaLabel={t('pulseDeck.ruleModeAria', {
                      name: rule.spec.name,
                    })}
                    onChange={(nextMode) => onSetRuleMode(rule, nextMode)}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                  <span
                    data-testid={`pulse-deck-rule-counts-${rule.id}`}
                    className="tabular-nums"
                  >
                    {t('pulseDeck.ruleCounts', {
                      matched: rule.matchedCount,
                      observed: rule.observedCount,
                    })}
                  </span>
                  {usedCount > 0 ? (
                    <span className="tabular-nums">
                      {t('pulseDeck.workbench.rules.usedByCount', {
                        count: usedCount,
                      })}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const detailPane = (
    <div
      data-testid="automation-rule-lab"
      className="flex flex-1 flex-col gap-4 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <PulseEvalModeControl
            size="sm"
            value={draftSpec.evalMode}
            onChange={(mode) => setDraftSpec({ ...draftSpec, evalMode: mode })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="rule-create-fasttask-btn"
            onClick={() =>
              onCreateFastTaskFromRule(
                draftSpec,
                creatingNew ? null : selectedRuleId
              )
            }
          >
            <Zap className="mr-1 h-3.5 w-3.5" />
            {t('pulseDeck.workbench.rules.createFastTaskFromRule')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving}
            data-testid="rule-lab-save-btn"
            onClick={() => void handleSave()}
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            {t('pulseDeck.workbench.rules.saveRuleBtn')}
          </Button>
          {selectedRule ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="rule-lab-delete-btn"
              onClick={() => onDeleteRule(selectedRule.id)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

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
      <div className="space-y-2.5 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">
            {t('pulseDeck.workbench.rules.dryRunLabTitle')}
          </span>
          <div className="flex items-center gap-2">
            <select
              aria-label={t('pulseFilter.selectSampleAria')}
              value={selectedSampleId}
              onChange={(e) => setSelectedSampleId(e.target.value)}
              className="h-7 rounded-md border border-border bg-[var(--surface-control)] px-2 text-2xs text-foreground"
            >
              {sampleOptions.map((sample) => (
                <option key={sample.eventId} value={sample.eventId}>
                  {sample.eventType} ({sample.source.kind})
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={runningDryRun}
              data-testid="rule-lab-dryrun-btn"
              onClick={() => void handleRunBackendDryRun()}
            >
              <Play className="mr-1 h-3.5 w-3.5" />
              {t('pulseDeck.workbench.rules.runDryRunBtn')}
            </Button>
          </div>
        </div>

        {dryRunReport ? (
          <div
            data-testid="rule-lab-dryrun-result"
            className="rounded-md border border-border bg-[var(--surface-panel)] p-3 text-xs"
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
    </div>
  );

  return (
    <AutomationSplitFrame
      testId="automation-tab-rules-split"
      master={masterPane}
      detail={detailPane}
    />
  );
}
