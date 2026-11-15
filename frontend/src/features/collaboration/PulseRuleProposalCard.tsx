import { useMemo, useState } from 'react';
import { CheckCircle2, Play, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  pulseApi,
  type BotMailboxPolicy,
  type EventSourceKind,
  type GateFilterCondition,
  type GroupDispatchMode,
  type PulseEvalMode,
  type PulseRuleSpec,
  type PulseRuleView,
  type PulseTemporalSpec,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';
import {
  buildSampleEnvelopeForSource,
  defaultEventTypeForSource,
  defaultTemporalSpecForSource,
  isTemporalSourceKind,
} from './collaborationPulseEvents';

const SOURCE_OPTIONS: ReadonlyArray<{
  kind: EventSourceKind;
  label: string;
}> = [
  { kind: 'feishu', label: 'Feishu' },
  { kind: 'jira', label: 'Jira' },
  { kind: 'github', label: 'GitHub' },
  { kind: 'webhook_standard', label: 'Webhook' },
  { kind: 'time_cron', label: 'Cron' },
  { kind: 'time_once', label: 'Once' },
  { kind: 'time_interval', label: 'Interval' },
  { kind: 'time_sla', label: 'SLA' },
];

const EVAL_MODES: ReadonlyArray<{ value: PulseEvalMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Observe' },
  { value: 'auto', label: 'Auto' },
];

export type PulseRosterOption = {
  memberId: string;
  nickname: string;
};

export function describeGroupDispatchMode(
  mode: GroupDispatchMode,
  roster: readonly PulseRosterOption[] = []
): string {
  const resolveNick = (id: string) =>
    roster.find((item) => item.memberId === id)?.nickname || id;
  switch (mode.type) {
    case 'specific_seat':
      return `Seat: @${resolveNick(mode.memberId)}`;
    case 'mention_seats':
      return `Seats (${mode.order ?? 'sequential'}): ${mode.memberIds
        .map((id) => `@${resolveNick(id)}`)
        .join(', ')}`;
    case 'moderator_triage':
      return `Moderator triage: @${resolveNick(mode.moderatorMemberId)}`;
    case 'broadcast_log_only':
      return 'Broadcast log only';
  }
}

export function PulseRuleProposalCard({
  initialSpec,
  ruleId = null,
  contextLabel,
  roster = [],
  onSaved,
  onCancel,
}: {
  initialSpec: PulseRuleSpec;
  ruleId?: string | null;
  contextLabel?: string;
  roster?: readonly PulseRosterOption[];
  onSaved?: (saved: PulseRuleView) => void;
  onCancel?: () => void;
}) {
  const [spec, setSpec] = useState<PulseRuleSpec>(initialSpec);
  const [pointerFilter, setPointerFilter] = useState<string>(() => {
    const firstContains = initialSpec.filter.conditions.find(
      (cond): cond is Extract<GateFilterCondition, { op: 'contains' }> =>
        cond.op === 'contains'
    );
    return firstContains?.pointer ?? '';
  });
  const [pointerNeedle, setPointerNeedle] = useState<string>(() => {
    const firstContains = initialSpec.filter.conditions.find(
      (cond): cond is Extract<GateFilterCondition, { op: 'contains' }> =>
        cond.op === 'contains'
    );
    return firstContains?.needle ?? '';
  });
  const [sampleSummary, setSampleSummary] = useState(
    'High-priority P0 regression reported on checkout service'
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedRule, setSavedRule] = useState<PulseRuleView | null>(null);

  const activeSourceKind: EventSourceKind =
    spec.filter.sourceKinds[0] ?? 'webhook_standard';
  const activeEventType = spec.filter.eventTypes[0] ?? '';
  const primaryTarget = spec.targets[0];

  const effectiveSpec = useMemo<PulseRuleSpec>(() => {
    const baseConditions: GateFilterCondition[] = isTemporalSourceKind(
      activeSourceKind
    )
      ? []
      : [{ op: 'not_bot_actor' }];

    if (pointerFilter.trim() || pointerNeedle.trim()) {
      baseConditions.push({
        op: 'contains',
        pointer: pointerFilter.trim(),
        needle: pointerNeedle,
      });
    }

    let skippedPrimaryContains = false;
    for (const condition of spec.filter.conditions) {
      if (condition.op === 'not_bot_actor') continue;
      if (condition.op === 'contains' && !skippedPrimaryContains) {
        skippedPrimaryContains = true;
        continue;
      }
      baseConditions.push(condition);
    }

    return {
      ...spec,
      filter: {
        ...spec.filter,
        conditions: baseConditions,
      },
    };
  }, [activeSourceKind, pointerFilter, pointerNeedle, spec]);

  const dryRunReport = useMemo(() => {
    const envelope = buildSampleEnvelopeForSource(
      activeSourceKind,
      activeEventType,
      {
        summary: sampleSummary,
        issue: { key: 'PROJ-128', priority: 'High' },
        pr: { number: 42, branch: 'feat/pulse-engine' },
      }
    );
    return evaluatePulseRuleLocally(effectiveSpec, envelope);
  }, [activeEventType, activeSourceKind, effectiveSpec, sampleSummary]);

  const handleSourceChange = (nextKind: EventSourceKind) => {
    const nextTemporal = defaultTemporalSpecForSource(nextKind);
    const nextEvent = defaultEventTypeForSource(nextKind);
    setSpec((prev) => ({
      ...prev,
      temporal: nextTemporal,
      filter: {
        ...prev.filter,
        sourceKinds: [nextKind],
        eventTypes: nextEvent ? [nextEvent] : [],
      },
    }));
  };

  const updateTemporal = (nextTemporal: PulseTemporalSpec | null) => {
    setSpec((prev) => ({ ...prev, temporal: nextTemporal }));
  };

  const updateMailboxPolicy = (mailboxPolicy: BotMailboxPolicy) => {
    setSpec((prev) => ({
      ...prev,
      targets: prev.targets.map((target, idx) =>
        idx === 0 && target.kind === 'bot'
          ? { ...target, mailboxPolicy }
          : target
      ),
    }));
  };

  const updateGroupDispatchType = (
    nextType: GroupDispatchMode['type'],
    seatMemberId?: string
  ) => {
    const fallbackSeat =
      seatMemberId ||
      roster[0]?.memberId ||
      (primaryTarget?.kind === 'group' &&
      primaryTarget.dispatchMode.type === 'specific_seat'
        ? primaryTarget.dispatchMode.memberId
        : 'seat-1');

    let nextMode: GroupDispatchMode;
    switch (nextType) {
      case 'specific_seat':
        nextMode = { type: 'specific_seat', memberId: fallbackSeat };
        break;
      case 'mention_seats':
        nextMode = {
          type: 'mention_seats',
          memberIds:
            roster.length > 0
              ? roster.slice(0, 2).map((item) => item.memberId)
              : [fallbackSeat],
          order: 'sequential',
        };
        break;
      case 'moderator_triage':
        nextMode = { type: 'moderator_triage', moderatorMemberId: fallbackSeat };
        break;
      case 'broadcast_log_only':
        nextMode = { type: 'broadcast_log_only' };
        break;
    }

    setSpec((prev) => ({
      ...prev,
      targets: prev.targets.map((target, idx) =>
        idx === 0 && target.kind === 'group'
          ? { ...target, dispatchMode: nextMode }
          : target
      ),
    }));
  };

  const updateTemplate = (value: string) => {
    setSpec((prev) => ({
      ...prev,
      targets: prev.targets.map((target, idx) => {
        if (idx !== 0) return target;
        if (target.kind === 'bot' || target.kind === 'session') {
          return { ...target, promptTemplate: value };
        }
        if (target.kind === 'group') {
          return { ...target, messageTemplate: value };
        }
        return target;
      }),
    }));
  };

  const handleSave = async () => {
    if (!dryRunReport.valid || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await pulseApi.saveRule({
        id: ruleId ?? null,
        enabled: effectiveSpec.evalMode !== 'off',
        spec: effectiveSpec,
      });
      setSavedRule(saved);
      onSaved?.(saved);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Failed to save Pulse rule.'
      );
    } finally {
      setSaving(false);
    }
  };

  const templateValue =
    primaryTarget?.kind === 'bot' || primaryTarget?.kind === 'session'
      ? primaryTarget.promptTemplate
      : primaryTarget?.kind === 'group'
        ? primaryTarget.messageTemplate
        : '';

  return (
    <section
      className="settings-surface rounded-lg border border-border bg-popover p-3 text-xs text-foreground shadow-sm"
      data-testid="pulse-rule-proposal-card"
      aria-label="Pulse Rule Proposal"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-border/70 pb-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate font-semibold text-foreground">
            Pulse Rule Proposal
          </span>
          {contextLabel ? (
            <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {contextLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <div
            className="inline-flex rounded-md border border-border bg-muted/60 p-0.5"
            role="group"
            aria-label="Evaluation mode"
          >
            {EVAL_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                data-testid={`pulse-proposal-mode-${mode.value}`}
                onClick={() =>
                  setSpec((prev) => ({ ...prev, evalMode: mode.value }))
                }
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                  spec.evalMode === mode.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
          {onCancel ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label="Close proposal"
              onClick={onCancel}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2.5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pulse-proposal-name" className="text-[11px]">
              Rule Name
            </Label>
            <Input
              id="pulse-proposal-name"
              aria-label="Rule Name"
              value={spec.name}
              onChange={(event) =>
                setSpec((prev) => ({ ...prev, name: event.target.value }))
              }
              className="h-7 px-2 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pulse-proposal-event-type" className="text-[11px]">
              Event Type
            </Label>
            <Input
              id="pulse-proposal-event-type"
              aria-label="Event Type"
              value={activeEventType}
              onChange={(event) =>
                setSpec((prev) => ({
                  ...prev,
                  filter: {
                    ...prev.filter,
                    eventTypes: event.target.value.trim()
                      ? [event.target.value.trim()]
                      : [],
                  },
                }))
              }
              className="h-7 px-2 font-mono text-xs"
            />
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Event Source
          </span>
          <div className="flex flex-wrap gap-1">
            {SOURCE_OPTIONS.map((option) => (
              <button
                key={option.kind}
                type="button"
                data-testid={`pulse-source-${option.kind}`}
                onClick={() => handleSourceChange(option.kind)}
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  activeSourceKind === option.kind
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {spec.temporal?.kind === 'cron' ? (
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border/70 bg-muted/30 p-2">
            <div className="space-y-1">
              <Label className="text-[11px]">Cron Expression</Label>
              <Input
                aria-label="Cron Expression"
                value={spec.temporal.expression}
                onChange={(event) =>
                  updateTemporal({
                    ...spec.temporal,
                    kind: 'cron',
                    expression: event.target.value,
                    timezone:
                      spec.temporal?.kind === 'cron'
                        ? spec.temporal.timezone
                        : 'UTC',
                  })
                }
                className="h-7 px-2 font-mono text-xs tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Timezone</Label>
              <Input
                aria-label="Timezone"
                value={spec.temporal.timezone}
                onChange={(event) =>
                  updateTemporal({
                    ...spec.temporal,
                    kind: 'cron',
                    expression:
                      spec.temporal?.kind === 'cron'
                        ? spec.temporal.expression
                        : '0 9 * * 1-5',
                    timezone: event.target.value,
                  })
                }
                className="h-7 px-2 text-xs"
              />
            </div>
          </div>
        ) : null}

        {spec.temporal?.kind === 'once' ? (
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/30 p-2">
            <Label className="text-[11px]">Fire At (ISO Timestamp)</Label>
            <Input
              aria-label="Fire At"
              value={spec.temporal.fireAt}
              onChange={(event) =>
                updateTemporal({ kind: 'once', fireAt: event.target.value })
              }
              className="h-7 px-2 font-mono text-xs tabular-nums"
            />
          </div>
        ) : null}

        {spec.temporal?.kind === 'interval' ? (
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/30 p-2">
            <Label className="text-[11px]">Interval (seconds)</Label>
            <Input
              type="number"
              aria-label="Interval Seconds"
              value={spec.temporal.everySeconds}
              onChange={(event) =>
                updateTemporal({
                  kind: 'interval',
                  everySeconds: Number(event.target.value) || 0,
                  skipIfBusy: true,
                })
              }
              className="h-7 px-2 font-mono text-xs tabular-nums"
            />
          </div>
        ) : null}

        {spec.temporal?.kind === 'inactivity_sla' ? (
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border/70 bg-muted/30 p-2">
            <div className="space-y-1">
              <Label className="text-[11px]">Thread Key Prefix</Label>
              <Input
                aria-label="Thread Key Prefix"
                value={spec.temporal.threadKeyPrefix}
                onChange={(event) =>
                  updateTemporal({
                    kind: 'inactivity_sla',
                    threadKeyPrefix: event.target.value,
                    timeoutSeconds:
                      spec.temporal?.kind === 'inactivity_sla'
                        ? spec.temporal.timeoutSeconds
                        : 1800,
                  })
                }
                className="h-7 px-2 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">SLA Timeout (seconds)</Label>
              <Input
                type="number"
                aria-label="SLA Timeout Seconds"
                value={spec.temporal.timeoutSeconds}
                onChange={(event) =>
                  updateTemporal({
                    kind: 'inactivity_sla',
                    threadKeyPrefix:
                      spec.temporal?.kind === 'inactivity_sla'
                        ? spec.temporal.threadKeyPrefix
                        : 'group:',
                    timeoutSeconds: Number(event.target.value) || 0,
                  })
                }
                className="h-7 px-2 font-mono text-xs tabular-nums"
              />
            </div>
          </div>
        ) : null}

        {primaryTarget?.kind === 'bot' ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">
              Bot Target:{' '}
              <strong className="font-mono text-foreground">
                {primaryTarget.memberId}
              </strong>{' '}
              · Persistent memory
            </span>
            <div className="inline-flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Mailbox</span>
              {(['fifo_serial', 'coalesce_batch'] as const).map((policy) => (
                <button
                  key={policy}
                  type="button"
                  data-testid={`pulse-mailbox-${policy}`}
                  onClick={() => updateMailboxPolicy(policy)}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[11px] font-medium',
                    (primaryTarget.mailboxPolicy ?? 'fifo_serial') === policy
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground'
                  )}
                >
                  {policy === 'fifo_serial' ? 'FIFO Serial' : 'Coalesce Batch'}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {primaryTarget?.kind === 'group' ? (
          <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/30 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="text-[11px] font-medium text-foreground"
                data-testid="pulse-group-dispatch-summary"
              >
                {describeGroupDispatchMode(primaryTarget.dispatchMode, roster)}
              </span>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['specific_seat', 'Specific Seat'],
                    ['mention_seats', 'Mention Seats'],
                    ['moderator_triage', 'Moderator Triage'],
                    ['broadcast_log_only', 'Broadcast Log'],
                  ] as const
                ).map(([modeKey, label]) => (
                  <button
                    key={modeKey}
                    type="button"
                    data-testid={`pulse-dispatch-mode-${modeKey}`}
                    onClick={() => updateGroupDispatchType(modeKey)}
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[11px]',
                      primaryTarget.dispatchMode.type === modeKey
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-muted-foreground'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {primaryTarget.dispatchMode.type === 'specific_seat' &&
            roster.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                {roster.map((seat) => (
                  <button
                    key={seat.memberId}
                    type="button"
                    onClick={() =>
                      updateGroupDispatchType('specific_seat', seat.memberId)
                    }
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[11px]',
                      primaryTarget.dispatchMode.type === 'specific_seat' &&
                        primaryTarget.dispatchMode.memberId === seat.memberId
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-muted-foreground'
                    )}
                  >
                    @{seat.nickname}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[11px]">JSON Pointer Filter (optional)</Label>
            <Input
              aria-label="JSON Pointer Filter"
              placeholder="/summary"
              value={pointerFilter}
              onChange={(event) => setPointerFilter(event.target.value)}
              className="h-7 px-2 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Contains Value</Label>
            <Input
              aria-label="Contains Value"
              placeholder="P0"
              value={pointerNeedle}
              onChange={(event) => setPointerNeedle(event.target.value)}
              className="h-7 px-2 text-xs"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">Dispatch Template</Label>
          <Textarea
            aria-label="Dispatch Template"
            value={templateValue}
            onChange={(event) => updateTemplate(event.target.value)}
            className="min-h-[56px] px-2 py-1.5 font-mono text-xs"
          />
        </div>

        <div
          className="space-y-1.5 rounded-md border border-border bg-muted/40 p-2"
          data-testid="pulse-live-dry-run"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Play className="h-3 w-3 text-primary" />
              Live Dry-Run
            </span>
            <span
              data-testid="pulse-dry-run-status"
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                !dryRunReport.valid
                  ? 'bg-destructive/15 text-destructive'
                  : dryRunReport.matched
                    ? 'bg-success/15 text-success'
                    : 'bg-warning/15 text-warning'
              )}
            >
              {!dryRunReport.valid
                ? `Invalid (${dryRunReport.violations.length})`
                : dryRunReport.matched
                  ? 'Matched'
                  : 'Filtered Out'}
            </span>
          </div>
          <Input
            aria-label="Sample Summary"
            value={sampleSummary}
            onChange={(event) => setSampleSummary(event.target.value)}
            className="h-7 px-2 text-xs"
          />
          {dryRunReport.violations.length > 0 ? (
            <ul
              className="space-y-0.5 text-[11px] text-destructive"
              data-testid="pulse-dry-run-violations"
            >
              {dryRunReport.violations.map((violation) => (
                <li key={`${violation.path}:${violation.code}`}>
                  {violation.path}: {violation.message}
                </li>
              ))}
            </ul>
          ) : dryRunReport.renderedPreviews[0] ? (
            <pre
              className="max-h-20 overflow-auto whitespace-pre-wrap rounded bg-background p-1.5 font-mono text-[11px] text-muted-foreground"
              data-testid="pulse-dry-run-preview"
            >
              {dryRunReport.renderedPreviews[0]}
            </pre>
          ) : null}
        </div>

        {saveError ? (
          <p className="text-[11px] text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}

        {savedRule ? (
          <p
            className="inline-flex items-center gap-1.5 rounded-md border border-success/25 bg-success/[0.06] px-2.5 py-1 text-[11px] text-success"
            data-testid="pulse-rule-saved-banner"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved rule "{savedRule.spec.name}" (rev{' '}
            <span className="tabular-nums">{savedRule.revision}</span>)
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          {onCancel ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onCancel}
              className="h-7 px-2.5 text-xs"
            >
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="primary"
            data-testid="pulse-save-rule-btn"
            disabled={!dryRunReport.valid || saving}
            onClick={() => {
              void handleSave();
            }}
            className="h-7 px-3 text-xs"
          >
            {saving ? 'Saving…' : 'Save Pulse Rule'}
          </Button>
        </div>
      </div>
    </section>
  );
}
