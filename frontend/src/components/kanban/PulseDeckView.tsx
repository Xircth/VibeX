import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, GitFork, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePulseDeckSnapshot } from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type EventEnvelope,
  type EventSourceKind,
  type PulseDryRunReport,
  type PulseEvalMode,
  type PulseObservedCandidateView,
  type PulseRuleView,
  type PulseSourceView,
  type PulseSubscriberKind,
  type PulseSubscriptionView,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';
import { requestOpenWorkflowStudio } from './pulseDeckEvents';
import { PulseDeckApprovalsAndObserve } from './pulseDeckObserveAndApprovals';
import { PulseDeckRuleComposer } from './pulseDeckRuleComposer';
import {
  DEFAULT_SOURCE_KINDS,
  PulseDeckOnboardingBanner,
  PulseDeckRulesAndSubscriptions,
  PulseDeckSourcesSection,
} from './pulseDeckSections';

export type PulseDeckSectionTab =
  | 'all'
  | 'approvals'
  | 'observe'
  | 'rules'
  | 'sources';

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
  const { t, i18n } = useTranslation('panels');
  const {
    snapshot,
    isLoading,
    isFetching,
    error: queryError,
    refetch,
    setSnapshotData,
    invalidateSnapshot,
  } = usePulseDeckSnapshot(projectId);

  const [activeSection, setActiveSection] =
    useState<PulseDeckSectionTab>('all');
  const [addingRule, setAddingRule] = useState(false);
  const [actionError, setActionError] = useState('');

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
  const [subKind, setSubKind] = useState<PulseSubscriberKind>('session');
  const [subTargetId, setSubTargetId] = useState('');
  const [subscribing, setSubscribing] = useState(false);

  const errorMessage = actionError || (queryError ? queryError.message : '');

  const displayedSources = useMemo<PulseSourceView[]>(() => {
    const existing = snapshot?.sources ?? [];
    if (existing.length > 0) return existing;
    return DEFAULT_SOURCE_KINDS.map((kind) => ({
      id: `placeholder-${kind}`,
      kind,
      title: t(
        `pulseDeck.sources.${kind.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
      ),
      enabled: false,
      healthy: true,
      cursorWatermark: '0',
      receivedCount24h: 0,
      rejectedCount24h: 0,
      updatedAt: '',
    }));
  }, [snapshot?.sources, t, i18n.language]);

  const handleRefresh = async () => {
    setActionError('');
    await refetch();
  };

  const handleUpsertSource = async () => {
    const trimmedTitle = sourceTitle.trim();
    if (!trimmedTitle || savingSource) return;
    setSavingSource(true);
    setActionError('');
    try {
      const created = await pulseApi.upsertSource({
        kind: sourceKind,
        title: trimmedTitle,
        enabled: true,
        signingSecret: signingSecret.trim() || null,
      });
      setSnapshotData((prev) =>
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
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSaveSource')
      );
    } finally {
      setSavingSource(false);
    }
  };

  const handleRuleCreated = (createdRule: PulseRuleView) => {
    setSnapshotData((prev) =>
      prev
        ? {
            ...prev,
            rules: [
              createdRule,
              ...prev.rules.filter((item) => item.id !== createdRule.id),
            ],
          }
        : {
            engineActive: true,
            activeTicketCount: 0,
            pendingUserInteractionCount: 0,
            sources: [],
            rules: [createdRule],
            observedCandidates: [],
            subscriptions: [],
            pendingInteractions: [],
          }
    );
    setAddingRule(false);
  };

  const handlePromoteCandidate = async (
    candidate: PulseObservedCandidateView
  ) => {
    setActionError('');
    try {
      await pulseApi.promoteObservedCandidate(candidate.id);
      setSnapshotData((prev) =>
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
          : null
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errPromote')
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
      // Retain deterministic local dry-run report when backend RPC is offline
    }
  };

  const handleSetRuleMode = async (
    rule: PulseRuleView,
    evalMode: PulseEvalMode
  ) => {
    setActionError('');
    try {
      const updated = await pulseApi.setRuleMode(rule.id, evalMode);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.map((item) =>
                item.id === rule.id ? updated : item
              ),
            }
          : null
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errUpdateMode')
      );
    }
  };

  const handleToggleRuleEnabled = async (rule: PulseRuleView) => {
    setActionError('');
    try {
      const updated = await pulseApi.setRuleEnabled(rule.id, !rule.enabled);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.map((item) =>
                item.id === rule.id ? updated : item
              ),
            }
          : null
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errToggleRule')
      );
    }
  };

  const handleInteractionResolved = (interactionId: string) => {
    setSnapshotData((prev) =>
      prev
        ? {
            ...prev,
            pendingUserInteractionCount: Math.max(
              0,
              (prev.pendingUserInteractionCount ?? 0) - 1
            ),
            pendingInteractions: (prev.pendingInteractions ?? []).filter(
              (item) => item.id !== interactionId
            ),
          }
        : null
    );
    void invalidateSnapshot();
  };

  const handleSubscribeThread = async () => {
    const threadKey = subThreadKey.trim();
    const subscriberId = subTargetId.trim();
    if (!threadKey || !subscriberId || subscribing) return;
    setSubscribing(true);
    setActionError('');
    try {
      const created: PulseSubscriptionView = await pulseApi.subscribeThread(
        threadKey,
        subKind,
        subscriberId
      );
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              subscriptions: [
                created,
                ...prev.subscriptions.filter((item) => item.id !== created.id),
              ],
            }
          : null
      );
      setSubThreadKey('');
      setSubTargetId('');
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errSubscribe')
      );
    } finally {
      setSubscribing(false);
    }
  };

  const handleUnsubscribeThread = async (subscriptionId: string) => {
    setActionError('');
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
          : null
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('pulseDeck.errUnsubscribe')
      );
    }
  };

  const candidates = snapshot?.observedCandidates ?? [];
  const rules = snapshot?.rules ?? [];
  const subscriptions = snapshot?.subscriptions ?? [];
  const pendingInteractions = useMemo(
    () =>
      (snapshot?.pendingInteractions ?? []).filter(
        (item) => item.status === 'pending'
      ),
    [snapshot?.pendingInteractions]
  );

  const approvalsTotal =
    pendingInteractions.length ||
    (snapshot?.pendingUserInteractionCount ?? 0);
  const configuredSourceCount = snapshot?.sources.length ?? 0;

  const sectionTabs: ReadonlyArray<{
    id: PulseDeckSectionTab;
    label: string;
    count?: number;
  }> = [
    { id: 'all', label: t('pulseDeck.tabs.all') },
    {
      id: 'approvals',
      label: t('pulseDeck.tabs.approvals'),
      count: approvalsTotal,
    },
    {
      id: 'observe',
      label: t('pulseDeck.tabs.observe'),
      count: candidates.length,
    },
    { id: 'rules', label: t('pulseDeck.tabs.rules'), count: rules.length },
    {
      id: 'sources',
      label: t('pulseDeck.tabs.sources'),
      count: configuredSourceCount + subscriptions.length,
    },
  ];

  const showSources =
    addingSource || activeSection === 'all' || activeSection === 'sources';
  const showApprovals =
    activeSection === 'all' || activeSection === 'approvals';
  const showObserve = activeSection === 'all' || activeSection === 'observe';
  const showRules = activeSection === 'all' || activeSection === 'rules';
  const showSubscriptions =
    activeSection === 'all' || activeSection === 'sources';

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col gap-3.5 overflow-y-auto bg-background p-4 text-xs text-foreground',
        className
      )}
      data-testid="pulse-deck-view"
    >
      <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border pb-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">
            {t('pulseDeck.title')}
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
            {snapshot?.engineActive !== false
              ? t('pulseDeck.engineActive')
              : t('pulseDeck.enginePaused')}
          </span>

          <div
            className="inline-flex flex-wrap items-center gap-1.5"
            data-testid="pulse-deck-counters"
          >
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
              {t('pulseDeck.ticketsCount')}
              <strong className="text-foreground">
                {snapshot?.activeTicketCount ?? 0}
              </strong>
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
              {t('pulseDeck.approvalsCount')}
              <strong className="text-foreground">{approvalsTotal}</strong>
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
              {t('pulseDeck.observeCount')}
              <strong className="text-foreground">{candidates.length}</strong>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="primary"
            data-testid="pulse-deck-new-rule-toggle"
            onClick={() => setAddingRule((prev) => !prev)}
          >
            {addingRule
              ? t('pulseDeck.closeRuleCta')
              : t('pulseDeck.newRuleCta')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="pulse-deck-add-source-toggle"
            onClick={() => setAddingSource((prev) => !prev)}
            icon={<Plus className="h-3 w-3" />}
          >
            {t('pulseDeck.addSourceCta')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="pulse-deck-open-workflow-studio"
            onClick={() => requestOpenWorkflowStudio()}
            icon={<GitFork className="h-3 w-3" />}
          >
            {t('pulseDeck.openWorkflowStudioCta')}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={t('pulseDeck.refreshAria')}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                (isLoading || isFetching) && 'animate-spin'
              )}
            />
          </Button>
        </div>
      </header>

      <div
        role="tablist"
        aria-label={t('pulseDeck.sectionFilterAria')}
        data-testid="pulse-deck-section-tabs"
        className="inline-flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5"
      >
        {sectionTabs.map((tabItem) => {
          const active = activeSection === tabItem.id;
          return (
            <button
              key={tabItem.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`pulse-deck-tab-${tabItem.id}`}
              onClick={() => setActiveSection(tabItem.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <span>{tabItem.label}</span>
              {tabItem.count !== undefined ? (
                <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground tabular-nums">
                  {tabItem.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {errorMessage ? (
        <div
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <span>{errorMessage}</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => void handleRefresh()}
          >
            {t('pulseDeck.retry')}
          </Button>
        </div>
      ) : null}

      {addingRule ? (
        <PulseDeckRuleComposer
          projectId={projectId}
          onCancel={() => setAddingRule(false)}
          onCreated={handleRuleCreated}
          onError={setActionError}
        />
      ) : rules.length === 0 && showRules ? (
        <PulseDeckOnboardingBanner
          onStartCreateRule={() => setAddingRule(true)}
        />
      ) : null}

      {showSources ? (
        <PulseDeckSourcesSection
          addingSource={addingSource}
          setAddingSource={setAddingSource}
          sourceKind={sourceKind}
          setSourceKind={setSourceKind}
          sourceTitle={sourceTitle}
          setSourceTitle={setSourceTitle}
          signingSecret={signingSecret}
          setSigningSecret={setSigningSecret}
          savingSource={savingSource}
          onSaveSource={() => void handleUpsertSource()}
          displayedSources={displayedSources}
        />
      ) : null}

      <PulseDeckApprovalsAndObserve
        showApprovals={showApprovals}
        pendingInteractions={pendingInteractions}
        onInteractionResolved={handleInteractionResolved}
        showObserve={showObserve}
        candidates={candidates}
        inspectedCandidateId={inspectedCandidateId}
        inspectedReport={inspectedReport}
        onInspectDryRun={(candidate) => void handleInspectDryRun(candidate)}
        onPromoteCandidate={(candidate) =>
          void handlePromoteCandidate(candidate)
        }
      />

      <PulseDeckRulesAndSubscriptions
        rules={rules}
        showRules={showRules}
        showSubscriptions={showSubscriptions}
        onToggleRuleEnabled={(rule) => void handleToggleRuleEnabled(rule)}
        onSetRuleMode={(rule, mode) => void handleSetRuleMode(rule, mode)}
        subscriptions={subscriptions}
        subThreadKey={subThreadKey}
        setSubThreadKey={setSubThreadKey}
        subKind={subKind}
        setSubKind={setSubKind}
        subTargetId={subTargetId}
        setSubTargetId={setSubTargetId}
        subscribing={subscribing}
        onSubscribeThread={() => void handleSubscribeThread()}
        onUnsubscribeThread={(id) => void handleUnsubscribeThread(id)}
      />
    </div>
  );
}
