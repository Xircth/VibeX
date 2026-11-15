import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  EventEnvelope,
  EventSourceKind,
  GateFilterAst,
  GateFilterCondition,
  PulseRuleSpec,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';

import {
  BUILT_IN_SAMPLE_EVENTS,
  formatEventSourceLabel,
} from './sampleEvents';

export type ConditionOp = GateFilterCondition['op'];

const CONDITION_OP_LIST: readonly ConditionOp[] = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in_set',
  'exists',
  'regex',
  'not_bot_actor',
];

const QUICK_SOURCE_KINDS: readonly EventSourceKind[] = [
  'feishu',
  'jira',
  'github',
  'webhook_standard',
  'time_cron',
  'sdk_custom',
];

function parseScalarInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  return raw;
}

function formatConditionValue(condition: GateFilterCondition): string {
  switch (condition.op) {
    case 'eq':
    case 'neq':
      return typeof condition.value === 'string'
        ? condition.value
        : JSON.stringify(condition.value ?? '');
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return String(condition.value);
    case 'contains':
      return condition.needle;
    case 'in_set':
      return condition.values
        .map((item) =>
          typeof item === 'string' ? item : JSON.stringify(item)
        )
        .join(', ');
    case 'regex':
      return condition.pattern;
    case 'exists':
    case 'not_bot_actor':
      return '';
  }
}

function buildConditionForOp(
  op: ConditionOp,
  pointer: string,
  rawValue: string
): GateFilterCondition {
  switch (op) {
    case 'not_bot_actor':
      return { op: 'not_bot_actor' };
    case 'exists':
      return { op: 'exists', pointer };
    case 'eq':
      return { op: 'eq', pointer, value: parseScalarInput(rawValue) };
    case 'neq':
      return { op: 'neq', pointer, value: parseScalarInput(rawValue) };
    case 'gt':
      return { op: 'gt', pointer, value: Number(rawValue) || 0 };
    case 'gte':
      return { op: 'gte', pointer, value: Number(rawValue) || 0 };
    case 'lt':
      return { op: 'lt', pointer, value: Number(rawValue) || 0 };
    case 'lte':
      return { op: 'lte', pointer, value: Number(rawValue) || 0 };
    case 'contains':
      return { op: 'contains', pointer, needle: rawValue };
    case 'in_set':
      return {
        op: 'in_set',
        pointer,
        values: rawValue
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map(parseScalarInput),
      };
    case 'regex':
      return { op: 'regex', pointer, pattern: rawValue };
  }
}

export interface PulseFilterBuilderProps {
  filter: GateFilterAst;
  onChange?: (next: GateFilterAst) => void;
  ruleSpec?: PulseRuleSpec;
  sampleEvents?: EventEnvelope[];
  showDryRun?: boolean;
  readOnly?: boolean;
  className?: string;
}

export function PulseFilterBuilder({
  filter,
  onChange,
  ruleSpec,
  sampleEvents,
  showDryRun = true,
  readOnly = false,
  className,
}: PulseFilterBuilderProps) {
  const { t, i18n } = useTranslation('panels');

  const availableSamples =
    sampleEvents && sampleEvents.length > 0
      ? sampleEvents
      : BUILT_IN_SAMPLE_EVENTS;
  const [selectedSampleId, setSelectedSampleId] = useState<string>(
    availableSamples[0]?.eventId ?? ''
  );
  const [sampleJson, setSampleJson] = useState<string>(() =>
    JSON.stringify(availableSamples[0] ?? BUILT_IN_SAMPLE_EVENTS[0], null, 2)
  );

  const editable = Boolean(onChange) && !readOnly;

  const effectiveSpec: PulseRuleSpec = useMemo(
    () =>
      ruleSpec
        ? { ...ruleSpec, filter }
        : {
            name: t('pulseFilter.sampleDryRunTitle'),
            evalMode: 'observe',
            filter,
            targets: [
              {
                kind: 'session',
                mode: 'ephemeral_fresh',
                agentId: 'codex',
                promptTemplate:
                  'Handle {{event.type}} on {{threadKey}} from {{actor.displayName}}',
              },
            ],
          },
    [filter, ruleSpec, t, i18n.language]
  );

  const dryRunState = useMemo(() => {
    try {
      const parsed = JSON.parse(sampleJson) as EventEnvelope;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.source ||
        !parsed.actor ||
        !parsed.trace
      ) {
        return {
          parseError: t('pulseFilter.errInvalidEnvelope'),
          report: null,
        };
      }
      return {
        parseError: null,
        report: evaluatePulseRuleLocally(effectiveSpec, parsed),
      };
    } catch (error) {
      return {
        parseError:
          error instanceof Error
            ? error.message
            : t('pulseFilter.errInvalidJson'),
        report: null,
      };
    }
  }, [effectiveSpec, sampleJson, t, i18n.language]);

  const toggleSourceKind = (kind: EventSourceKind) => {
    if (!editable) return;
    const nextKinds = filter.sourceKinds.includes(kind)
      ? filter.sourceKinds.filter((item) => item !== kind)
      : [...filter.sourceKinds, kind];
    onChange?.({ ...filter, sourceKinds: nextKinds });
  };

  const updateCondition = (
    index: number,
    nextCondition: GateFilterCondition
  ) => {
    if (!editable) return;
    onChange?.({
      ...filter,
      conditions: filter.conditions.map((item, idx) =>
        idx === index ? nextCondition : item
      ),
    });
  };

  const addCondition = () => {
    if (!editable) return;
    onChange?.({
      ...filter,
      conditions: [
        ...filter.conditions,
        { op: 'eq', pointer: '/priority', value: 'P0' },
      ],
    });
  };

  const removeCondition = (index: number) => {
    if (!editable) return;
    onChange?.({
      ...filter,
      conditions: filter.conditions.filter((_, idx) => idx !== index),
    });
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-1.5">
        <Label className="text-xs">{t('pulseFilter.allowedSources')}</Label>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_SOURCE_KINDS.map((kind) => {
            const selected = filter.sourceKinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                disabled={!editable}
                aria-pressed={selected}
                onClick={() => toggleSourceKind(kind)}
                className={cn(
                  'inline-flex h-6 items-center rounded-full border px-2.5 text-2xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground'
                )}
              >
                {formatEventSourceLabel(kind, t)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pulse-filter-event-types" className="text-xs">
          {t('pulseFilter.eventTypesLabel')}
        </Label>
        <Input
          id="pulse-filter-event-types"
          aria-label={t('pulseFilter.eventTypesAria')}
          disabled={!editable}
          placeholder="jira.issue.transitioned, github.ci.failed"
          value={filter.eventTypes.join(', ')}
          onChange={(event) =>
            onChange?.({
              ...filter,
              eventTypes: event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">
            {t('pulseFilter.gateConditions')}{' '}
            <span className="tabular-nums text-muted-foreground">
              ({filter.conditions.length})
            </span>
          </Label>
          {editable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={addCondition}
            >
              <Plus className="mr-1 size-3.5" />
              {t('pulseFilter.addCondition')}
            </Button>
          ) : null}
        </div>

        {filter.conditions.length === 0 ? (
          <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t('pulseFilter.noConditionsHint')}
          </div>
        ) : (
          <div className="space-y-2">
            {filter.conditions.map((condition, index) => {
              const pointerValue =
                condition.op === 'not_bot_actor' ? '' : condition.pointer;
              const rawValue = formatConditionValue(condition);
              const unmatched =
                dryRunState.report?.unmatchedConditions.includes(index) ??
                false;
              const matched = Boolean(dryRunState.report) && !unmatched;
              const oneBased = index + 1;

              return (
                <div
                  key={index}
                  data-testid={`pulse-filter-condition-${index}`}
                  className={cn(
                    'space-y-2 rounded-lg p-2.5',
                    unmatched
                      ? 'bg-destructive/5 ring-1 ring-destructive/50'
                      : matched
                        ? 'bg-success/5 ring-1 ring-success/50'
                        : 'bg-muted/35'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-mono text-2xs tabular-nums text-muted-foreground">
                      <span>#{oneBased}</span>
                      {dryRunState.report ? (
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 font-sans text-2xs font-medium',
                            unmatched
                              ? 'bg-destructive/10 text-destructive'
                              : 'bg-success/10 text-success'
                          )}
                        >
                          {unmatched
                            ? t('pulseFilter.unmatched')
                            : t('pulseFilter.matched')}
                        </span>
                      ) : null}
                    </span>
                    {editable ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label={t('pulseFilter.removeConditionAria', {
                          index: oneBased,
                        })}
                        onClick={() => removeCondition(index)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Select
                      value={condition.op}
                      disabled={!editable}
                      onValueChange={(nextOp: ConditionOp) =>
                        updateCondition(
                          index,
                          buildConditionForOp(
                            nextOp,
                            pointerValue || '/priority',
                            rawValue
                          )
                        )
                      }
                    >
                      <SelectTrigger
                        aria-label={t('pulseFilter.conditionOperatorAria', {
                          index: oneBased,
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CONDITION_OP_LIST.map((op) => (
                          <SelectItem key={op} value={op}>
                            {t(
                              `pulseFilter.operators.${op.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {condition.op !== 'not_bot_actor' ? (
                      <Input
                        aria-label={t('pulseFilter.conditionPointerAria', {
                          index: oneBased,
                        })}
                        disabled={!editable}
                        placeholder="/issue/priority"
                        className="font-mono text-xs"
                        value={pointerValue}
                        onChange={(event) =>
                          updateCondition(
                            index,
                            buildConditionForOp(
                              condition.op,
                              event.target.value,
                              rawValue
                            )
                          )
                        }
                      />
                    ) : null}

                    {condition.op !== 'exists' &&
                    condition.op !== 'not_bot_actor' ? (
                      <Input
                        aria-label={t('pulseFilter.conditionValueAria', {
                          index: oneBased,
                        })}
                        disabled={!editable}
                        placeholder={
                          condition.op === 'in_set'
                            ? 'P0, P1'
                            : condition.op === 'regex'
                              ? '^CORE-\\d+$'
                              : t('pulseFilter.expectedValuePlaceholder')
                        }
                        value={rawValue}
                        onChange={(event) =>
                          updateCondition(
                            index,
                            buildConditionForOp(
                              condition.op,
                              pointerValue,
                              event.target.value
                            )
                          )
                        }
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showDryRun ? (
        <div
          data-testid="pulse-dry-run-bench"
          className="space-y-2.5 rounded-lg bg-muted/35 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              {t('pulseFilter.sampleDryRunTitle')}
            </span>
            <Select
              value={selectedSampleId}
              onValueChange={(sampleId) => {
                setSelectedSampleId(sampleId);
                const found = availableSamples.find(
                  (item) => item.eventId === sampleId
                );
                if (found) {
                  setSampleJson(JSON.stringify(found, null, 2));
                }
              }}
            >
              <SelectTrigger
                aria-label={t('pulseFilter.selectSampleAria')}
                className="h-7 w-52 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableSamples.map((sample) => (
                  <SelectItem key={sample.eventId} value={sample.eventId}>
                    {formatEventSourceLabel(sample.source.kind, t)} ·{' '}
                    {sample.eventType}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Textarea
            aria-label={t('pulseFilter.sampleJsonAria')}
            value={sampleJson}
            onChange={(event) => setSampleJson(event.target.value)}
            className="min-h-[112px] font-mono text-xs leading-5"
          />

          {dryRunState.parseError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{dryRunState.parseError}</span>
            </div>
          ) : null}

          {dryRunState.report ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  data-testid="pulse-dry-run-verdict"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-2xs font-semibold',
                    dryRunState.report.matched
                      ? 'bg-success/15 text-success'
                      : 'bg-warning/15 text-warning'
                  )}
                >
                  {dryRunState.report.matched ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <AlertCircle className="size-3" />
                  )}
                  {dryRunState.report.matched
                    ? t('pulseFilter.gateMatched')
                    : t('pulseFilter.gateFiltered')}
                </span>
                {dryRunState.report.unmatchedConditions.length > 0 ? (
                  <span className="tabular-nums text-2xs text-muted-foreground">
                    {t('pulseFilter.unmatchedIndices', {
                      list: dryRunState.report.unmatchedConditions
                        .map((idx) =>
                          idx === -1
                            ? t('pulseFilter.selfHopGuard')
                            : `#${idx + 1}`
                        )
                        .join(', '),
                    })}
                  </span>
                ) : null}
              </div>

              {dryRunState.report.violations.length > 0 ? (
                <ul
                  role="alert"
                  data-testid="pulse-dry-run-violations"
                  className="space-y-1 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive"
                >
                  {dryRunState.report.violations.map((violation, idx) => (
                    <li
                      key={`${violation.path}-${violation.code}-${idx}`}
                      className="font-mono text-2xs"
                    >
                      [{violation.path}] {violation.message}
                    </li>
                  ))}
                </ul>
              ) : null}

              {dryRunState.report.renderedPreviews.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-2xs font-medium text-muted-foreground">
                    {t('pulseFilter.renderedPreviews')}
                  </div>
                  {dryRunState.report.renderedPreviews.map((preview, idx) => (
                    <pre
                      key={idx}
                      data-testid={`pulse-rendered-preview-${idx}`}
                      className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-card px-2.5 py-2 font-mono text-2xs text-foreground"
                    >
                      {preview}
                    </pre>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
