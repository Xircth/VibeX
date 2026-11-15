import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const [rules, setRules] = useState<PulseRuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingKind, setCreatingKind] = useState<'event' | 'schedule' | null>(
    null
  );

  const loadRules = useCallback(async () => {
    if (!memberId) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const allRules = await pulseApi.listRules();
      const bound = allRules.filter((rule) =>
        rule.spec.targets.some(
          (target) => target.kind === 'bot' && target.memberId === memberId
        )
      );
      setRules(bound);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const handleModeChange = async (rule: PulseRuleView, mode: PulseEvalMode) => {
    try {
      const updated = await pulseApi.setRuleMode(rule.id, mode);
      setRules((prev) =>
        prev.map((item) => (item.id === rule.id ? updated : item))
      );
    } catch {
      // Ignore best-effort toggle failure
    }
  };

  const handleMailboxPolicyChange = async (
    rule: PulseRuleView,
    mailboxPolicy: BotMailboxPolicy
  ) => {
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
      setRules((prev) =>
        prev.map((item) => (item.id === rule.id ? updated : item))
      );
    } catch {
      // Ignore best-effort update failure
    }
  };

  const handleDelete = async (ruleId: string) => {
    try {
      await pulseApi.deleteRule(ruleId);
      setRules((prev) => prev.filter((item) => item.id !== ruleId));
    } catch {
      // Ignore best-effort delete failure
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
            setRules((prev) => [
              saved,
              ...prev.filter((item) => item.id !== saved.id),
            ]);
          }}
          onCancel={() => setCreatingKind(null)}
        />
      ) : null}

      {loading ? (
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
                          onClick={() => void handleModeChange(rule, mode.value)}
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
