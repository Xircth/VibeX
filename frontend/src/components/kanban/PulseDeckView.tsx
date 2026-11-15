import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Eye,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unlink,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  pulseApi,
  type EventEnvelope,
  type EventSourceKind,
  type PulseDeckSnapshot,
  type PulseDryRunReport,
  type PulseEvalMode,
  type PulseObservedCandidateView,
  type PulseRuleView,
  type PulseSourceView,
  type PulseSubscriptionView,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';

const EVAL_MODES: ReadonlyArray<{ value: PulseEvalMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Observe' },
  { value: 'auto', label: 'Auto' },
];

const DEFAULT_SOURCE_CATALOG: ReadonlyArray<{
  kind: EventSourceKind;
  label: string;
}> = [
  { kind: 'feishu', label: 'Feishu' },
  { kind: 'jira', label: 'Jira' },
  { kind: 'github', label: 'GitHub' },
  { kind: 'webhook_standard', label: 'Standard Webhook' },
  { kind: 'time_cron', label: 'Temporal' },
];

function buildCandidateSampleEnvelope(
  candidate: PulseObservedCandidateView
): EventEnvelope {
  return {
    eventId: candidate.eventId,
    deliveryId: `dlv-${candidate.id}`,
    source: {
      kind: candidate.sourceKind,
      instanceId: `${candidate.sourceKind}-observed`,
      trustLevel: 'verified_external',
    },
    eventType: candidate.eventType,
    occurredAt: candidate.occurredAt,
    actor: {
      id: 'external-actor',
      displayName: 'External Event',
      roles: [],
      isBot: false,
      isSelf: false,
    },
    threadKey: candidate.threadKey ?? null,
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: candidate.eventId,
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      summary: candidate.summary,
    },
  };
}

export function PulseDeckView({
  projectId = null,
  className,
}: {
  projectId?: string | null;
  className?: string;
}) {
  const [snapshot, setSnapshot] = useState<PulseDeckSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [addingSource, setAddingSource] = useState(false);
  const [sourceKind, setSourceKind] =
    useState<EventSourceKind>('webhook_standard');
  const [sourceTitle, setSourceTitle] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [savingSource, setSavingSource] = useState(false);

  const [inspectedCandidateId, setInspectedCandidateId] = useState<
    string | null
  >(null);
  const [inspectedReport, setInspectedReport] =
    useState<PulseDryRunReport | null>(null);

  const [subThreadKey, setSubThreadKey] = useState('');
  const [subKind, setSubKind] = useState<'session' | 'bot' | 'group'>(
    'session'
  );
  const [subTargetId, setSubTargetId] = useState('');
  const [subscribing, setSubscribing] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await pulseApi.deckSnapshot(projectId);
      setSnapshot(next);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to load Pulse Deck.'
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const displayedSources = useMemo<PulseSourceView[]>(() => {
    const existing = snapshot?.sources ?? [];
    if (existing.length > 0) return existing;
    return DEFAULT_SOURCE_CATALOG.map((item) => ({
      id: `placeholder-${item.kind}`,
      kind: item.kind,
      title: item.label,
      enabled: false,
      healthy: true,
      cursorWatermark: '0',
      receivedCount24h: 0,
      rejectedCount24h: 0,
      updatedAt: '',
    }));
  }, [snapshot?.sources]);

  const handleUpsertSource = async () => {
    const trimmedTitle = sourceTitle.trim();
    if (!trimmedTitle || savingSource) return;
    setSavingSource(true);
    try {
      const created = await pulseApi.upsertSource({
        kind: sourceKind,
        title: trimmedTitle,
        enabled: true,
        signingSecret: signingSecret.trim() || null,
      });
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              sources: [
                created,
                ...prev.sources.filter((item) => item.id !== created.id),
              ],
            }
          : {
              engineActive: true,
              activeTicketCount: 0,
              pendingUserInteractionCount: 0,
              sources: [created],
              rules: [],
              observedCandidates: [],
              subscriptions: [],
              pendingInteractions: [],
            }
      );
      setSourceTitle('');
      setSigningSecret('');
      setAddingSource(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save source.');
    } finally {
      setSavingSource(false);
    }
  };

  const handlePromoteCandidate = async (
    candidate: PulseObservedCandidateView
  ) => {
    try {
      await pulseApi.promoteObservedCandidate(candidate.id);
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              observedCandidates: prev.observedCandidates.map((item) =>
                item.id === candidate.id ? { ...item, promoted: true } : item
              ),
              rules: prev.rules.map((rule) =>
                rule.id === candidate.ruleId
                  ? { ...rule, spec: { ...rule.spec, evalMode: 'auto' } }
                  : rule
              ),
            }
          : prev
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to promote candidate.'
      );
    }
  };

  const handleInspectDryRun = async (candidate: PulseObservedCandidateView) => {
    if (inspectedCandidateId === candidate.id) {
      setInspectedCandidateId(null);
      setInspectedReport(null);
      return;
    }
    setInspectedCandidateId(candidate.id);
    const envelope = buildCandidateSampleEnvelope(candidate);
    const matchingRule = snapshot?.rules.find(
      (rule) => rule.id === candidate.ruleId
    );
    if (!matchingRule) {
      setInspectedReport({
        valid: true,
        matched: true,
        violations: [],
        unmatchedConditions: [],
        renderedPreviews: [candidate.summary],
      });
      return;
    }
    const localReport = evaluatePulseRuleLocally(matchingRule.spec, envelope);
    setInspectedReport(localReport);
    try {
      const remoteReport = await pulseApi.dryRunRule(
        matchingRule.spec,
        envelope
      );
      setInspectedReport(remoteReport);
    } catch {
      // Keep local deterministic dry-run report when backend RPC is offline
    }
  };

  const handleSetRuleMode = async (
    rule: PulseRuleView,
    evalMode: PulseEvalMode
  ) => {
    try {
      const updated = await pulseApi.setRuleMode(rule.id, evalMode);
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.map((item) =>
                item.id === rule.id ? updated : item
              ),
            }
          : prev
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update rule mode.'
      );
    }
  };

  const handleSubscribeThread = async () => {
    const threadKey = subThreadKey.trim();
    const subscriberId = subTargetId.trim();
    if (!threadKey || !subscriberId || subscribing) return;
    setSubscribing(true);
    try {
      const created: PulseSubscriptionView = await pulseApi.subscribeThread(
        threadKey,
        subKind,
        subscriberId
      );
      setSnapshot((prev) =>
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
      setSubThreadKey('');
      setSubTargetId('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to subscribe thread.'
      );
    } finally {
      setSubscribing(false);
    }
  };

  const handleUnsubscribeThread = async (subscriptionId: string) => {
    try {
      await pulseApi.unsubscribeThread(subscriptionId);
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              subscriptions: prev.subscriptions.filter(
                (item) => item.id !== subscriptionId
              ),
            }
          : prev
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to unsubscribe thread.'
      );
    }
  };

  const candidates = snapshot?.observedCandidates ?? [];
  const rules = snapshot?.rules ?? [];
  const subscriptions = snapshot?.subscriptions ?? [];

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-background p-4 text-xs text-foreground',
        className
      )}
      data-testid="pulse-deck-view"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">
            Event Pulse Deck
          </h2>
          <span
            data-testid="pulse-deck-engine-badge"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              snapshot?.engineActive !== false
                ? 'border-border bg-success/15 text-success'
                : 'border-border bg-muted text-muted-foreground'
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                snapshot?.engineActive !== false
                  ? 'bg-success'
                  : 'bg-muted-foreground'
              )}
            />
            {snapshot?.engineActive !== false ? 'Engine Active' : 'Paused'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span
            className="text-[11px] text-muted-foreground tabular-nums"
            data-testid="pulse-deck-counters"
          >
            Active Tickets{' '}
            <strong className="text-foreground">
              {snapshot?.activeTicketCount ?? 0}
            </strong>{' '}
            · Pending Approvals{' '}
            <strong className="text-foreground">
              {snapshot?.pendingUserInteractionCount ?? 0}
            </strong>
          </span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="pulse-deck-add-source-toggle"
            onClick={() => setAddingSource((prev) => !prev)}
            icon={<Plus className="h-3 w-3" />}
          >
            Add Source / Webhook
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="Refresh Pulse Deck"
            onClick={() => void loadSnapshot()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </header>

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {addingSource ? (
        <section
          className="settings-surface space-y-2.5 rounded-lg border border-border bg-popover p-3"
          data-testid="pulse-deck-add-source-form"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-foreground">
              Register Event Source / Webhook
            </span>
            <div className="flex flex-wrap gap-1">
              {DEFAULT_SOURCE_CATALOG.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  data-testid={`deck-source-kind-${option.kind}`}
                  onClick={() => setSourceKind(option.kind)}
                  className={cn(
                    'rounded border px-2 py-0.5 text-[11px] font-medium',
                    sourceKind === option.kind
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11px]">Source Title</Label>
              <Input
                aria-label="Source Title"
                placeholder="Production GitHub Webhook"
                value={sourceTitle}
                onChange={(event) => setSourceTitle(event.target.value)}
                className="h-7 px-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Signing Secret (optional)</Label>
              <Input
                type="password"
                aria-label="Signing Secret"
                placeholder="whsec_..."
                value={signingSecret}
                onChange={(event) => setSigningSecret(event.target.value)}
                className="h-7 px-2 font-mono text-xs"
              />
            </div>
          </div>

          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setAddingSource(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              variant="primary"
              data-testid="pulse-deck-save-source-btn"
              disabled={!sourceTitle.trim() || savingSource}
              onClick={() => void handleUpsertSource()}
            >
              {savingSource ? 'Saving…' : 'Save Source'}
            </Button>
          </div>
        </section>
      ) : null}

      {/* 1. Source Health & Watermarks Strip */}
      <section aria-label="Source Health and Watermarks" className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground">
          Source Health &amp; Watermarks
        </h3>
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5"
          data-testid="pulse-deck-sources-strip"
        >
          {displayedSources.map((source) => (
            <div
              key={source.id}
              data-testid={`pulse-source-card-${source.id}`}
              className="settings-surface flex flex-col justify-between gap-1.5 rounded-md border border-border bg-popover p-2.5"
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="truncate font-medium text-foreground">
                  {source.title}
                </span>
                <span
                  data-testid={`pulse-source-health-${source.id}`}
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    !source.enabled
                      ? 'bg-muted-foreground'
                      : source.healthy
                        ? 'bg-success'
                        : 'bg-destructive'
                  )}
                  title={
                    !source.enabled
                      ? 'Disabled'
                      : source.healthy
                        ? 'Healthy'
                        : source.statusMessage || 'Unhealthy'
                  }
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="font-mono uppercase">{source.kind}</span>
                <span
                  className="font-mono tabular-nums"
                  data-testid={`pulse-source-watermark-${source.id}`}
                >
                  wm:{source.cursorWatermark || '—'}
                </span>
              </div>

              <div
                className="flex items-center justify-between border-t border-border/60 pt-1 text-[11px] tabular-nums"
                data-testid={`pulse-source-counts-${source.id}`}
              >
                <span className="text-foreground">
                  24h in: <strong>{source.receivedCount24h}</strong>
                </span>
                <span
                  className={cn(
                    source.rejectedCount24h > 0
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  )}
                >
                  rej: {source.rejectedCount24h}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Observe Candidate Stream */}
      <section aria-label="Observe Candidate Stream" className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Eye className="h-3.5 w-3.5 text-warning" />
            Observe Candidate Stream
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground tabular-nums"
              data-testid="pulse-deck-candidates-count"
            >
              {candidates.length}
            </span>
          </h3>
        </div>

        {candidates.length === 0 ? (
          <div
            className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-muted-foreground"
            data-testid="pulse-deck-candidates-empty"
          >
            No shadow Observe candidates queued right now.
          </div>
        ) : (
          <div className="space-y-2" data-testid="pulse-deck-candidates-list">
            {candidates.map((candidate) => (
              <div
                key={candidate.id}
                data-testid={`pulse-observed-candidate-${candidate.id}`}
                className="settings-surface space-y-2 rounded-md border border-border bg-popover p-2.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-foreground">
                        {candidate.ruleName}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {candidate.sourceKind} · {candidate.eventType}
                      </span>
                      {candidate.threadKey ? (
                        <span className="font-mono text-[11px] text-primary">
                          {candidate.threadKey}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-foreground">{candidate.summary}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      data-testid={`pulse-candidate-inspect-${candidate.id}`}
                      onClick={() => void handleInspectDryRun(candidate)}
                    >
                      Inspect Dry-Run
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="primary"
                      disabled={candidate.promoted}
                      data-testid={`pulse-candidate-promote-${candidate.id}`}
                      onClick={() => void handlePromoteCandidate(candidate)}
                      icon={<ArrowUpRight className="h-3 w-3" />}
                    >
                      {candidate.promoted ? 'Promoted' : 'Promote to Auto'}
                    </Button>
                  </div>
                </div>

                {inspectedCandidateId === candidate.id && inspectedReport ? (
                  <div
                    className="rounded border border-border bg-background p-2 text-[11px]"
                    data-testid={`pulse-candidate-dryrun-${candidate.id}`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-medium text-foreground">
                        Dry-Run Evaluation
                      </span>
                      <span
                        className={cn(
                          'font-medium tabular-nums',
                          inspectedReport.matched
                            ? 'text-success'
                            : 'text-warning'
                        )}
                      >
                        {inspectedReport.matched ? 'Matched' : 'Filtered'}
                      </span>
                    </div>
                    {inspectedReport.renderedPreviews[0] ? (
                      <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                        {inspectedReport.renderedPreviews[0]}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Rules & Active Thread Subscriptions */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section aria-label="Pulse Rules" className="space-y-2">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-primary" />
            Pulse Rules
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground tabular-nums"
              data-testid="pulse-deck-rules-count"
            >
              {rules.length}
            </span>
          </h3>

          {rules.length === 0 ? (
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-muted-foreground">
              No Pulse rules configured for this project.
            </div>
          ) : (
            <div className="space-y-1.5" data-testid="pulse-deck-rules-list">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  data-testid={`pulse-deck-rule-${rule.id}`}
                  className="settings-surface flex items-center justify-between gap-2 rounded-md border border-border bg-popover p-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {rule.spec.name}
                    </p>
                    <p
                      className="mt-0.5 text-[11px] text-muted-foreground tabular-nums"
                      data-testid={`pulse-deck-rule-counts-${rule.id}`}
                    >
                      Matched {rule.matchedCount} · Observed{' '}
                      {rule.observedCount}
                    </p>
                  </div>

                  <div
                    className="inline-flex shrink-0 rounded border border-border bg-muted/50 p-0.5"
                    role="group"
                    aria-label={`Mode for ${rule.spec.name}`}
                  >
                    {EVAL_MODES.map((mode) => (
                      <button
                        key={mode.value}
                        type="button"
                        data-testid={`pulse-deck-rule-mode-${rule.id}-${mode.value}`}
                        onClick={() => void handleSetRuleMode(rule, mode.value)}
                        className={cn(
                          'rounded px-2 py-0.5 text-[11px] font-medium',
                          rule.spec.evalMode === mode.value
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section
          aria-label="Active Thread Subscriptions"
          className="space-y-2"
        >
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Link2 className="h-3.5 w-3.5 text-primary" />
            Active Thread Subscriptions
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground tabular-nums"
              data-testid="pulse-deck-subscriptions-count"
            >
              {subscriptions.length}
            </span>
          </h3>

          <div className="settings-surface space-y-2 rounded-md border border-border bg-popover p-2.5">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <Input
                aria-label="Subscription Thread Key"
                placeholder="jira:PROJ-123"
                value={subThreadKey}
                onChange={(event) => setSubThreadKey(event.target.value)}
                className="h-7 px-2 font-mono text-xs"
              />
              <div className="inline-flex rounded border border-border bg-muted/40 p-0.5">
                {(['session', 'bot', 'group'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    data-testid={`deck-sub-kind-${kind}`}
                    onClick={() => setSubKind(kind)}
                    className={cn(
                      'flex-1 rounded px-1.5 py-0.5 text-[11px] capitalize',
                      subKind === kind
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground'
                    )}
                  >
                    {kind}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <Input
                  aria-label="Subscriber ID"
                  placeholder="sess-1 / bot-1"
                  value={subTargetId}
                  onChange={(event) => setSubTargetId(event.target.value)}
                  className="h-7 flex-1 px-2 font-mono text-xs"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  data-testid="pulse-deck-subscribe-btn"
                  disabled={
                    !subThreadKey.trim() || !subTargetId.trim() || subscribing
                  }
                  onClick={() => void handleSubscribeThread()}
                >
                  Bind
                </Button>
              </div>
            </div>

            {subscriptions.length === 0 ? (
              <p className="py-1 text-[11px] text-muted-foreground">
                No external threads subscribed (`jira:*`, `github:*`,
                `feishu:*`).
              </p>
            ) : (
              <div
                className="space-y-1"
                data-testid="pulse-deck-subscriptions-list"
              >
                {subscriptions.map((sub) => (
                  <div
                    key={sub.id}
                    data-testid={`pulse-deck-subscription-${sub.id}`}
                    className="flex items-center justify-between gap-2 rounded border border-border/70 bg-background px-2 py-1"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <ShieldCheck className="h-3 w-3 shrink-0 text-success" />
                      <span className="truncate font-mono text-[11px] text-foreground">
                        {sub.threadKey}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {sub.subscriberKind}:{sub.subscriberId}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      aria-label={`Unsubscribe ${sub.threadKey}`}
                      data-testid={`pulse-deck-unsubscribe-${sub.id}`}
                      onClick={() => void handleUnsubscribeThread(sub.id)}
                    >
                      <Unlink className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
