import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  formatPulseErrorMessage,
  usePulseDeckSnapshot,
} from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type GroupDispatchMode,
  type PulseEvalMode,
  type PulseRuleView,
  type PulseSubscriptionView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { buildGroupPulseProposalSpec } from './collaborationPulseEvents';
import {
  PulseRuleProposalCard,
  describeGroupDispatchMode,
  type PulseRosterOption,
} from './PulseRuleProposalCard';

const EVAL_MODES: ReadonlyArray<{ value: PulseEvalMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Observe' },
  { value: 'auto', label: 'Auto' },
];

export function GroupPulsePanel({
  spaceId,
  spaceName = 'Group',
  workspaceId = null,
  leadMemberId = null,
  roster = [],
}: {
  spaceId: string;
  spaceName?: string;
  workspaceId?: string | null;
  leadMemberId?: string | null;
  roster?: readonly PulseRosterOption[];
}) {
  const {
    snapshot,
    isLoading,
    error: queryError,
    refetch,
    setSnapshotData,
    invalidateSnapshot,
  } = usePulseDeckSnapshot(null, { enabled: Boolean(spaceId) });

  const [newThreadKey, setNewThreadKey] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftDispatchMode, setDraftDispatchMode] =
    useState<GroupDispatchMode | null>(null);

  const rules = useMemo<PulseRuleView[]>(() => {
    if (!spaceId) return [];
    return (snapshot?.rules ?? []).filter((rule) =>
      rule.spec.targets.some(
        (target) => target.kind === 'group' && target.spaceId === spaceId
      )
    );
  }, [snapshot?.rules, spaceId]);

  const subscriptions = useMemo<PulseSubscriptionView[]>(() => {
    if (!spaceId) return [];
    return (snapshot?.subscriptions ?? []).filter(
      (sub) =>
        sub.subscriberKind === 'group' &&
        sub.subscriberId === spaceId &&
        sub.active
    );
  }, [snapshot?.subscriptions, spaceId]);

  const errorMessage =
    actionError ??
    (queryError
      ? formatPulseErrorMessage(queryError, 'Failed to load group Pulse state.')
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
        formatPulseErrorMessage(err, 'Failed to update rule mode.')
      );
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
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
        formatPulseErrorMessage(err, 'Failed to delete group rule.')
      );
    }
  };

  const handleSubscribeThread = async () => {
    const trimmed = newThreadKey.trim();
    if (!trimmed || subscribing) return;
    setSubscribing(true);
    setActionError(null);
    try {
      const created = await pulseApi.subscribeThread(trimmed, 'group', spaceId);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              subscriptions: [
                created,
                ...prev.subscriptions.filter((item) => item.id !== created.id),
              ],
            }
          : prev
      );
      setNewThreadKey('');
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, 'Failed to subscribe thread.')
      );
    } finally {
      setSubscribing(false);
    }
  };

  const handleUnsubscribe = async (subscriptionId: string) => {
    setActionError(null);
    try {
      await pulseApi.unsubscribeThread(subscriptionId);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              subscriptions: prev.subscriptions.filter(
                (item) => item.id !== subscriptionId
              ),
            }
          : prev
      );
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, 'Failed to unsubscribe thread.')
      );
    }
  };

  const defaultModeratorId =
    leadMemberId?.trim() || roster[0]?.memberId || 'moderator';

  return (
    <div
      className="space-y-3 text-xs text-foreground"
      data-testid="group-pulse-panel"
    >
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Zap className="h-3.5 w-3.5 text-primary" />
            Seat Routing &amp; Group Rules
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
              data-testid="group-pulse-rules-count"
            >
              {rules.length}
            </span>
          </span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="group-pulse-new-moderator-rule"
            onClick={() =>
              setDraftDispatchMode({
                type: 'moderator_triage',
                moderatorMemberId: defaultModeratorId,
              })
            }
            icon={<Plus className="h-3 w-3" />}
          >
            Triage Rule
          </Button>
        </div>

        {roster.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-muted-foreground">
              Quick seat bind:
            </span>
            {roster.map((seat) => (
              <button
                key={seat.memberId}
                type="button"
                data-testid={`group-pulse-bind-seat-${seat.nickname}`}
                onClick={() =>
                  setDraftDispatchMode({
                    type: 'specific_seat',
                    memberId: seat.memberId,
                  })
                }
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
              >
                @{seat.nickname}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {errorMessage ? (
        <div
          role="alert"
          data-testid="group-pulse-error"
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
            data-testid="group-pulse-retry"
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

      {draftDispatchMode ? (
        <PulseRuleProposalCard
          initialSpec={buildGroupPulseProposalSpec({
            spaceId,
            spaceName,
            dispatchMode: draftDispatchMode,
            workspaceId,
          })}
          contextLabel={describeGroupDispatchMode(draftDispatchMode, roster)}
          roster={roster}
          onSaved={(saved) => {
            setDraftDispatchMode(null);
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
          onCancel={() => setDraftDispatchMode(null)}
        />
      ) : null}

      {isLoading && !snapshot ? (
        <p className="py-1.5 text-muted-foreground">Loading group rules…</p>
      ) : rules.length === 0 ? (
        <p
          className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-muted-foreground"
          data-testid="group-pulse-empty"
        >
          No group Pulse rules yet. Bind a seat above or type{' '}
          <code>/automate</code> in chat.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rules.map((rule) => {
            const groupTarget = rule.spec.targets.find(
              (target): target is Extract<typeof target, { kind: 'group' }> =>
                target.kind === 'group' && target.spaceId === spaceId
            );
            return (
              <div
                key={rule.id}
                data-testid={`group-pulse-rule-${rule.id}`}
                className="settings-surface flex flex-col gap-1.5 rounded-md border border-border bg-background p-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {rule.spec.name}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {groupTarget ? (
                        <span>
                          {describeGroupDispatchMode(
                            groupTarget.dispatchMode,
                            roster
                          )}
                        </span>
                      ) : null}
                      <span>·</span>
                      <span className="tabular-nums">
                        Matched {rule.matchedCount} · Observed{' '}
                        {rule.observedCount}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <div className="inline-flex rounded border border-border bg-muted/50 p-0.5">
                      {EVAL_MODES.map((mode) => (
                        <button
                          key={mode.value}
                          type="button"
                          data-testid={`group-rule-mode-${rule.id}-${mode.value}`}
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
                      onClick={() => void handleDeleteRule(rule.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2 border-t border-border/70 pt-2.5">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Link2 className="h-3.5 w-3.5 text-primary" />
            Thread Subscriptions
          </span>
          <span
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
            data-testid="group-pulse-subscriptions-count"
          >
            {subscriptions.length}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            aria-label="External Thread Key"
            placeholder="jira:PROJ-123 or github:org/repo#42"
            value={newThreadKey}
            onChange={(event) => setNewThreadKey(event.target.value)}
            className="h-7 flex-1 px-2 font-mono text-xs"
          />
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="group-pulse-subscribe-btn"
            disabled={!newThreadKey.trim() || subscribing}
            onClick={() => void handleSubscribeThread()}
          >
            Subscribe
          </Button>
        </div>

        {subscriptions.length > 0 ? (
          <div className="space-y-1">
            {subscriptions.map((sub) => (
              <div
                key={sub.id}
                data-testid={`group-pulse-subscription-${sub.id}`}
                className="flex items-center justify-between gap-2 rounded border border-border/70 bg-background px-2 py-1"
              >
                <span className="truncate font-mono text-[11px] text-foreground">
                  {sub.threadKey}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5 text-muted-foreground hover:text-destructive"
                  aria-label={`Unsubscribe ${sub.threadKey}`}
                  onClick={() => void handleUnsubscribe(sub.id)}
                >
                  <Unlink className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
