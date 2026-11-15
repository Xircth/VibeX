import { memo, useCallback, useEffect, useState } from 'react';
import { CalendarClock, Clock, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PopoverContent } from '@/components/ui/popover';
import i18n from '@/i18n';
import {
  pulseApi,
  type EventSourceKind,
  type PulseRuleView,
  type PulseTemporalSpec,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import { DelayedMessageCountdown } from './CollaborationSpaceChrome';
import type { ScheduledSpaceMessage } from './types';
import { useOptionalCollaborationSpaceStore } from './SpaceStoreContext';

type TemporalPresetKind = PulseTemporalSpec['kind'];

const TEMPORAL_KINDS: ReadonlyArray<{
  kind: TemporalPresetKind;
  label: string;
  sourceKind: EventSourceKind;
}> = [
  { kind: 'cron', label: 'Cron', sourceKind: 'time_cron' },
  { kind: 'once', label: 'Once', sourceKind: 'time_once' },
  { kind: 'interval', label: 'Interval', sourceKind: 'time_interval' },
  { kind: 'inactivity_sla', label: 'Inactivity SLA', sourceKind: 'time_sla' },
];

export function describeTemporalSpec(temporal: PulseTemporalSpec): string {
  switch (temporal.kind) {
    case 'cron':
      return `Cron ${temporal.expression} (${temporal.timezone})`;
    case 'once':
      return `Once @ ${temporal.fireAt}`;
    case 'interval':
      return `Every ${temporal.everySeconds}s`;
    case 'inactivity_sla':
      return `SLA ${temporal.timeoutSeconds}s (${temporal.threadKeyPrefix})`;
  }
}

export const ScheduledMessages = memo(function ScheduledMessages({
  nick,
  memberHoverKey,
  items,
  memberId,
  spaceId,
}: {
  nick: string;
  memberHoverKey: string;
  items: ScheduledSpaceMessage[];
  memberId?: string;
  spaceId?: string;
}) {
  const spaceStore = useOptionalCollaborationSpaceStore();
  const openDelayedMemberPopover = (key: string) => {
    spaceStore?.getSnapshot().openDelayedMemberPopover(key);
  };
  const scheduleCloseDelayedMemberPopover = () => {
    spaceStore?.getSnapshot().scheduleCloseDelayedMemberPopover();
  };

  const [temporalRules, setTemporalRules] = useState<PulseRuleView[]>([]);
  const [creating, setCreating] = useState(false);
  const [temporalKind, setTemporalKind] = useState<TemporalPresetKind>('cron');
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');
  const [fireAt, setFireAt] = useState(
    () => new Date(Date.now() + 3_600_000).toISOString()
  );
  const [everySeconds, setEverySeconds] = useState('600');
  const [slaSeconds, setSlaSeconds] = useState('1800');
  const [slaPrefix, setSlaPrefix] = useState(() =>
    spaceId ? `group:${spaceId}` : 'bot:'
  );
  const [promptText, setPromptText] = useState(
    () => `@${nick} Sync status update`
  );
  const [saving, setSaving] = useState(false);

  const loadTemporalRules = useCallback(async () => {
    try {
      const all = await pulseApi.listRules();
      const filtered = all.filter((rule) => {
        if (!rule.spec.temporal) return false;
        return rule.spec.targets.some((target) => {
          if (memberId && target.kind === 'bot') {
            return target.memberId === memberId;
          }
          if (spaceId && target.kind === 'group') {
            return target.spaceId === spaceId;
          }
          return true;
        });
      });
      setTemporalRules(filtered);
    } catch {
      setTemporalRules([]);
    }
  }, [memberId, spaceId]);

  useEffect(() => {
    void loadTemporalRules();
  }, [loadTemporalRules]);

  const handleSaveTemporal = async () => {
    if (!promptText.trim() || saving) return;
    setSaving(true);
    try {
      const preset = TEMPORAL_KINDS.find((item) => item.kind === temporalKind)!;
      let temporal: PulseTemporalSpec;
      switch (temporalKind) {
        case 'cron':
          temporal = {
            kind: 'cron',
            expression: cronExpr.trim() || '0 9 * * 1-5',
            timezone: 'UTC',
            weekdaysOnly: true,
          };
          break;
        case 'once':
          temporal = {
            kind: 'once',
            fireAt: fireAt.trim(),
          };
          break;
        case 'interval':
          temporal = {
            kind: 'interval',
            everySeconds: Math.max(5, Number(everySeconds) || 60),
            skipIfBusy: true,
          };
          break;
        case 'inactivity_sla':
          temporal = {
            kind: 'inactivity_sla',
            threadKeyPrefix: slaPrefix.trim() || 'group:',
            timeoutSeconds: Math.max(10, Number(slaSeconds) || 600),
          };
          break;
      }

      const targetMemberId = memberId?.trim() || nick;
      const saved = await pulseApi.saveRule({
        enabled: true,
        spec: {
          name: `${nick} ${preset.label} Schedule`,
          evalMode: 'auto',
          filter: {
            sourceKinds: [preset.sourceKind],
            sourceInstanceIds: [],
            eventTypes: [],
            allowedActors: [],
            conditions: [],
          },
          temporal,
          targets: spaceId
            ? [
                {
                  kind: 'group',
                  spaceId,
                  dispatchMode: {
                    type: 'specific_seat',
                    memberId: targetMemberId,
                  },
                  messageTemplate: promptText.trim(),
                },
              ]
            : [
                {
                  kind: 'bot',
                  memberId: targetMemberId,
                  conversationScope: 'fixed_primary',
                  mailboxPolicy: 'fifo_serial',
                  promptTemplate: promptText.trim(),
                },
              ],
        },
      });
      setTemporalRules((prev) => [
        saved,
        ...prev.filter((item) => item.id !== saved.id),
      ]);
      setCreating(false);
    } catch {
      // Ignore best-effort save error
    } finally {
      setSaving(false);
    }
  };

  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={6}
      onMouseEnter={() => openDelayedMemberPopover(memberHoverKey)}
      onMouseLeave={scheduleCloseDelayedMemberPopover}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      data-testid={`member-delayed-queue-${nick}`}
      className="collaboration-member-delayed-queue-popover w-80 rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
    >
      <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3 text-primary" aria-hidden="true" />
          <span>{i18n.t('panels:ui.collabPage.scheduledMessageQueue')}</span>
        </span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      <div className="collaboration-member-delayed-queue-list">
        {items.map((item) => {
          const itemId = item.id ?? item.delayed_input_id ?? item.deliver_at;
          return (
            <div
              key={itemId}
              className="collaboration-member-delayed-queue-item"
              data-testid={`member-delayed-queue-item-${itemId}`}
            >
              <span
                className="collaboration-member-delayed-queue-content"
                title={item.content}
              >
                {item.content}
              </span>
              <span
                className="collaboration-member-delayed-queue-timer tabular-nums"
                data-testid={`member-delayed-queue-timer-${itemId}`}
              >
                <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                <DelayedMessageCountdown deliverAt={item.deliver_at} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 border-t border-border/70 pt-2 text-xs">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
            <CalendarClock className="h-3 w-3 text-primary" />
            <span>Pulse Schedules</span>
            <span
              className="tabular-nums"
              data-testid={`member-pulse-schedules-count-${nick}`}
            >
              ({temporalRules.length})
            </span>
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="scheduled-messages-add-temporal"
            onClick={() => setCreating((prev) => !prev)}
            className="h-5 px-1.5 text-[11px]"
          >
            <Plus className="mr-0.5 h-3 w-3" />
            Schedule
          </Button>
        </div>

        {temporalRules.length > 0 ? (
          <div
            className="space-y-1"
            data-testid={`member-pulse-schedules-list-${nick}`}
          >
            {temporalRules.map((rule) => (
              <div
                key={rule.id}
                data-testid={`pulse-temporal-rule-${rule.id}`}
                className="flex items-center justify-between gap-2 rounded border border-border/60 bg-background px-2 py-1 text-[11px]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">
                    {rule.spec.name}
                  </p>
                  {rule.spec.temporal ? (
                    <p className="truncate font-mono text-[10px] text-muted-foreground tabular-nums">
                      {describeTemporalSpec(rule.spec.temporal)}
                    </p>
                  ) : null}
                </div>
                {rule.nextFireAt ? (
                  <span
                    className="shrink-0 font-mono text-[10px] text-primary tabular-nums"
                    data-testid={`pulse-temporal-next-fire-${rule.id}`}
                  >
                    {rule.nextFireAt}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {creating ? (
          <div
            className="mt-2 space-y-1.5 rounded border border-border bg-background p-2"
            data-testid="pulse-temporal-creator"
          >
            <div className="flex flex-wrap gap-1">
              {TEMPORAL_KINDS.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  data-testid={`temporal-kind-${option.kind}`}
                  onClick={() => setTemporalKind(option.kind)}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[11px] font-medium',
                    temporalKind === option.kind
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-muted/40 text-muted-foreground'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {temporalKind === 'cron' ? (
              <Input
                aria-label="Cron Expression"
                value={cronExpr}
                onChange={(event) => setCronExpr(event.target.value)}
                className="h-7 px-2 font-mono text-xs tabular-nums"
              />
            ) : null}
            {temporalKind === 'once' ? (
              <Input
                aria-label="Once Timestamp"
                value={fireAt}
                onChange={(event) => setFireAt(event.target.value)}
                className="h-7 px-2 font-mono text-xs tabular-nums"
              />
            ) : null}
            {temporalKind === 'interval' ? (
              <Input
                type="number"
                aria-label="Interval Seconds"
                value={everySeconds}
                onChange={(event) => setEverySeconds(event.target.value)}
                className="h-7 px-2 font-mono text-xs tabular-nums"
              />
            ) : null}
            {temporalKind === 'inactivity_sla' ? (
              <div className="grid grid-cols-2 gap-1">
                <Input
                  aria-label="SLA Thread Prefix"
                  value={slaPrefix}
                  onChange={(event) => setSlaPrefix(event.target.value)}
                  className="h-7 px-2 font-mono text-xs"
                />
                <Input
                  type="number"
                  aria-label="SLA Timeout Seconds"
                  value={slaSeconds}
                  onChange={(event) => setSlaSeconds(event.target.value)}
                  className="h-7 px-2 font-mono text-xs tabular-nums"
                />
              </div>
            ) : null}

            <Input
              aria-label="Scheduled Prompt"
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              className="h-7 px-2 text-xs"
            />
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                variant="primary"
                data-testid="pulse-temporal-save-btn"
                disabled={!promptText.trim() || saving}
                onClick={() => void handleSaveTemporal()}
              >
                Save Schedule
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </PopoverContent>
  );
});
