import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FlaskConical,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
  EventEnvelope,
  MandateOrigin,
  PulseEvalMode,
  PulseRuleSpec,
  PulseRuleView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import { PulseEvalModeControl } from './PulseEvalModeControl';
import { PulseFilterBuilder } from './PulseFilterBuilder';
import {
  formatEventSourceLabel,
  formatOrchestratorLabel,
  formatPulseTargetBadge,
  formatTemporalBadgeLabel,
} from './sampleEvents';

export interface AutomationProposalCardProps {
  rule?: PulseRuleView;
  spec?: PulseRuleSpec;
  draftOnly?: boolean;
  mandateOrigin?: MandateOrigin;
  matchedCount?: number;
  observedCount?: number;
  sampleEvents?: EventEnvelope[];
  defaultDryRunOpen?: boolean;
  saving?: boolean;
  onEvalModeChange?: (mode: PulseEvalMode) => void;
  onSpecChange?: (spec: PulseRuleSpec) => void;
  onSave?: (
    spec: PulseRuleSpec,
    evalMode: PulseEvalMode,
    humanConfirmedExternal: boolean
  ) => void | Promise<void>;
  onOpenInStudio?: (spec: PulseRuleSpec) => void;
  className?: string;
}

export function AutomationProposalCard({
  rule,
  spec: propSpec,
  draftOnly,
  mandateOrigin,
  matchedCount,
  observedCount,
  sampleEvents,
  defaultDryRunOpen = false,
  saving = false,
  onEvalModeChange,
  onSpecChange,
  onSave,
  onOpenInStudio,
  className,
}: AutomationProposalCardProps) {
  const initialSpec = propSpec ?? rule?.spec;
  if (!initialSpec) {
    throw new Error('AutomationProposalCard requires either rule or spec.');
  }

  const [localSpec, setLocalSpec] = useState<PulseRuleSpec>(initialSpec);
  useEffect(() => {
    if (propSpec) {
      setLocalSpec(propSpec);
    } else if (rule?.spec) {
      setLocalSpec(rule.spec);
    }
  }, [propSpec, rule?.spec]);
  const currentSpec = localSpec;

  const effectiveDraftOnly = draftOnly ?? rule?.draftOnly ?? false;
  const effectiveMandateOrigin =
    mandateOrigin ?? rule?.mandateOrigin ?? 'explicit_human';
  const requiresHumanConfirmation =
    effectiveDraftOnly || effectiveMandateOrigin === 'untrusted_external';

  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const [dryRunOpen, setDryRunOpen] = useState(defaultDryRunOpen);

  const effectiveEvalMode: PulseEvalMode =
    requiresHumanConfirmation && !humanConfirmed && currentSpec.evalMode === 'auto'
      ? 'observe'
      : currentSpec.evalMode;

  const resolvedMatchedCount = matchedCount ?? rule?.matchedCount ?? 0;
  const resolvedObservedCount = observedCount ?? rule?.observedCount ?? 0;

  const updateSpec = (next: PulseRuleSpec) => {
    setLocalSpec(next);
    onSpecChange?.(next);
  };

  const handleModeChange = (nextMode: PulseEvalMode) => {
    if (nextMode === 'auto' && requiresHumanConfirmation && !humanConfirmed) {
      return;
    }
    const nextSpec = { ...currentSpec, evalMode: nextMode };
    setLocalSpec(nextSpec);
    onSpecChange?.(nextSpec);
    onEvalModeChange?.(nextMode);
  };

  const sourceBadges: string[] = [
    ...currentSpec.filter.sourceKinds.map(formatEventSourceLabel),
    ...(currentSpec.temporal
      ? [formatTemporalBadgeLabel(currentSpec.temporal)]
      : []),
  ];
  if (sourceBadges.length === 0) {
    sourceBadges.push('All Sources');
  }

  return (
    <section
      data-testid="automation-proposal-card"
      className={cn(
        'settings-surface space-y-3 rounded-lg border border-border bg-card p-3.5 text-card-foreground',
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {sourceBadges.map((badge) => (
              <span
                key={badge}
                className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-2xs font-medium text-foreground"
              >
                {badge}
              </span>
            ))}
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold text-foreground">
              <Sparkles className="size-2.5 shrink-0" />
              {formatOrchestratorLabel(currentSpec.orchestrator)}
            </span>
          </div>
          <h3 className="truncate text-base font-semibold text-foreground">
            {currentSpec.name}
          </h3>
          {currentSpec.description ? (
            <p className="text-xs text-muted-foreground">
              {currentSpec.description}
            </p>
          ) : null}
        </div>

        <PulseEvalModeControl
          value={effectiveEvalMode}
          lockAuto={requiresHumanConfirmation && !humanConfirmed}
          onChange={handleModeChange}
        />
      </div>

      {requiresHumanConfirmation ? (
        <div
          role="status"
          data-testid="pulse-external-draft-lock"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 space-y-0.5">
              <div className="font-semibold text-foreground">
                External Draft · Human Confirmation Required
              </div>
              <p className="text-2xs text-muted-foreground">
                Proposed from an untrusted external event. Confirm explicitly before switching this rule to Auto.
              </p>
            </div>
          </div>
          {!humanConfirmed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2.5 text-xs"
              onClick={() => setHumanConfirmed(true)}
            >
              Confirm Draft
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-semibold text-success">
              <Check className="size-3" />
              Confirmed
            </span>
          )}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="text-2xs font-medium text-muted-foreground">
          Targets
        </div>
        <div className="flex flex-wrap gap-1.5">
          {currentSpec.targets.map((target, index) => {
            const formatted = formatPulseTargetBadge(target);
            return (
              <div
                key={index}
                data-testid={`proposal-target-badge-${index}`}
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs',
                  formatted.memoryModel === 'persistent'
                    ? 'border-primary/35 bg-primary/5'
                    : 'border-border bg-muted/45'
                )}
              >
                <span className="font-semibold text-foreground">
                  {formatted.category}
                </span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
                  {formatted.detail}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Matched:{' '}
            <strong className="font-semibold text-foreground">
              {resolvedMatchedCount}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            Observed:{' '}
            <strong className="font-semibold text-foreground">
              {resolvedObservedCount}
            </strong>
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-xs"
            aria-expanded={dryRunOpen}
            onClick={() => setDryRunOpen((open) => !open)}
          >
            <FlaskConical className="mr-1 size-3.5" />
            Test Sample
            {dryRunOpen ? (
              <ChevronUp className="ml-1 size-3" />
            ) : (
              <ChevronDown className="ml-1 size-3" />
            )}
          </Button>

          {onOpenInStudio ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={() => onOpenInStudio(currentSpec)}
            >
              <ExternalLink className="mr-1 size-3.5" />
              Studio
            </Button>
          ) : null}

          {onSave ? (
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={saving}
              onClick={() =>
                void onSave(currentSpec, effectiveEvalMode, humanConfirmed)
              }
            >
              <Check className="mr-1 size-3.5" />
              {saving
                ? 'Saving…'
                : effectiveEvalMode === 'off'
                  ? 'Save Rule'
                  : 'Save / Enable'}
            </Button>
          ) : null}
        </div>
      </div>

      {dryRunOpen ? (
        <div className="pt-1">
          <PulseFilterBuilder
            filter={currentSpec.filter}
            ruleSpec={currentSpec}
            sampleEvents={sampleEvents}
            onChange={(nextFilter) =>
              updateSpec({ ...currentSpec, filter: nextFilter })
            }
          />
        </div>
      ) : null}
    </section>
  );
}
