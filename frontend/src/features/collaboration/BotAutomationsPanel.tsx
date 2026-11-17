import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  formatPulseErrorMessage,
  usePulseDeckSnapshot,
} from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type BotMailboxPolicy,
  type PulseEvalMode,
  type PulseRuleView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { buildBotPulseProposalSpec } from './collaborationPulseEvents';
import { PulseRuleProposalCard } from './PulseRuleProposalCard';

const EVAL_MODES: ReadonlyArray<{ value: PulseEvalMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Observe' },
  { value: 'auto', label: 'Auto' },
];

export function BotAutomationsPanel({
  memberId,
  botName,
  workspaceId = null,
}: {
  memberId: string;
  botName: string;
  workspaceId?: string | null;
}) {
  const {
    snapshot,
    isLoading,
    error: queryError,
    refetch,
    setSnapshotData,
    invalidateSnapshot,
  } = usePulseDeckSnapshot(null, { enabled: Boolean(memberId) });

  const [creatingKind, setCreatingKind] = useState<'event' | 'schedule' | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const rules = useMemo<PulseRuleView[]>(() => {
    if (!memberId) return [];
    const allRules = snapshot?.rules ?? [];
    return allRules.filter((rule) =>
      rule.spec.targets.some(
        (target) => target.kind === 'bot' && target.memberId === memberId
      )
    );
  }, [memberId, snapshot?.rules]);

  const errorMessage =
    actionError ??
    (queryError
      ? formatPulseErrorMessage(queryError, 'Failed to load bot triggers.')
      : null);

  const handleModeChange = async (rule: PulseRuleView, mode: PulseEvalMode) => {
    setActionError(null);
    try {
      const updated = await pulseApi.setRuleMode(rule.id, mode);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.map((item) =>
                item.id === rule.id ? updated : item
              ),
            }
          : prev
      );
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, 'Failed to update trigger mode.')
      );
    }
  };

  const handleMailboxPolicyChange = async (
    rule: PulseRuleView,
    mailboxPolicy: BotMailboxPolicy
  ) => {
    setActionError(null);
    try {
      const nextSpec = {
        ...rule.spec,
        targets: rule.spec.targets.map((target) =>
          target.kind === 'bot' && target.memberId === memberId
            ? { ...target, mailboxPolicy }
            : target
        ),
      };
      const updated = await pulseApi.saveRule({
        id: rule.id,
        enabled: rule.enabled,
        spec: nextSpec,
      });
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.map((item) =>
                item.id === rule.id ? updated : item
              ),
            }
          : prev
      );
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, 'Failed to update mailbox policy.')
      );
    }
  };

  const handleDelete = async (ruleId: string) => {
    setActionError(null);
    try {
      await pulseApi.deleteRule(ruleId);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.filter((item) => item.id !== ruleId),
            }
          : prev
      );
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, 'Failed to delete bot trigger.')
      );
    }
  };

  return (
    <div
      className="space-y-3 text-xs text-foreground"
      data-testid="bot-automations-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-primary" />
          <span className="font-semibold">Bot Pulse Triggers</span>
          <span
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
            data-testid="bot-automations-count"
          >
            {rules.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="bot-automations-new-trigger"
            onClick={() => setCreatingKind('event')}
            icon={<Plus className="h-3 w-3" />}
          >
            Event Trigger
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="bot-automations-new-schedule"
            onClick={() => setCreatingKind('schedule')}
            icon={<CalendarClock className="h-3 w-3" />}
          >
            Schedule
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div
          role="alert"
          data-testid="bot-automations-error"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{errorMessage}</span>
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="bot-automations-retry"
            onClick={() => {
              setActionError(null);
              void refetch();
            }}
            icon={<RefreshCw className="h-3 w-3" />}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {creatingKind ? (
        <PulseRuleProposalCard
          initialSpec={buildBotPulseProposalSpec({
            memberId,
            botName,
            sourceKind:
              creatingKind === 'schedule' ? 'time_cron' : 'webhook_standard',
            workspaceId,
          })}
          contextLabel={`Bot: ${botName}`}
          onSaved={(saved) => {
            setCreatingKind(null);
            setSnapshotData((prev) =>
              prev
                ? {
                    ...prev,
                    rules: [
                      saved,
                      ...prev.rules.filter((item) => item.id !== saved.id),
                    ],
                  }
                : prev
            );
            void invalidateSnapshot();
          }}
          onCancel={() => setCreatingKind(null)}
        />
      ) : null}

      {isLoading && !snapshot ? (
        <p className="py-2 text-muted-foreground">Loading triggers…</p>
      ) : rules.length === 0 ? (
        <p
          className="rounded-md border border-border/70 bg-muted/30 px-3 py-3 text-muted-foreground"
          data-testid="bot-automations-empty"
        >
          No Pulse triggers bound to {botName}. Add an event trigger or schedule
          above.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => {
            const botTarget = rule.spec.targets.find(
              (target): target is Extract<typeof target, { kind: 'bot' }> =>
                target.kind === 'bot' && target.memberId === memberId
            );
            const activePolicy: BotMailboxPolicy =
              botTarget?.mailboxPolicy ?? 'fifo_serial';

            return (
              <div
                key={rule.id}
                data-testid={`bot-pulse-rule-${rule.id}`}
                className="settings-surface space-y-2 rounded-md border border-border bg-background p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {rule.spec.name}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                        {rule.spec.filter.sourceKinds.join(', ') || 'any'}
                      </span>
                      <span className="tabular-nums">
                        Matched {rule.matchedCount} · Observed{' '}
                        {rule.observedCount}
                      </span>
                      {rule.nextFireAt ? (
                        <span className="font-mono tabular-nums">
                          Next: {rule.nextFireAt}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <div
                      className="inline-flex rounded border border-border bg-muted/50 p-0.5"
                      role="group"
                      aria-label={`Mode for ${rule.spec.name}`}
                    >
                      {EVAL_MODES.map((mode) => (
                        <button
                          key={mode.value}
                          type="button"
                          data-testid={`bot-rule-mode-${rule.id}-${mode.value}`}
                          onClick={() =>
                            void handleModeChange(rule, mode.value)
                          }
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[11px] font-medium',
                            rule.spec.evalMode === mode.value
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${rule.spec.name}`}
                      onClick={() => void handleDelete(rule.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    Mailbox Policy
                  </span>
                  <div className="inline-flex gap-1">
                    {(
                      [
                        ['fifo_serial', 'FIFO Serial'],
                        ['coalesce_batch', 'Coalesce Batch'],
                      ] as const
                    ).map(([policy, label]) => (
                      <button
                        key={policy}
                        type="button"
                        data-testid={`bot-rule-policy-${rule.id}-${policy}`}
                        onClick={() =>
                          void handleMailboxPolicyChange(rule, policy)
                        }
                        className={cn(
                          'rounded border px-2 py-0.5 text-[11px]',
                          activePolicy === policy
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-muted-foreground'
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
