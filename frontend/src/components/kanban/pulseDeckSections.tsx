import { useTranslation } from 'react-i18next';
import {
  GitFork,
  Link2,
  Plus,
  ShieldCheck,
  Sparkles,
  Unlink,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  EventSourceKind,
  PulseEvalMode,
  PulseRuleView,
  PulseSourceView,
  PulseSubscriberKind,
  PulseSubscriptionView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { requestOpenWorkflowStudio } from './pulseDeckEvents';

export const DEFAULT_SOURCE_KINDS: readonly EventSourceKind[] = [
  'feishu',
  'jira',
  'github',
  'webhook_standard',
  'time_cron',
];

const EVAL_MODE_VALUES: readonly PulseEvalMode[] = ['off', 'observe', 'auto'];
const SUBSCRIBER_KINDS: readonly PulseSubscriberKind[] = [
  'session',
  'bot',
  'group',
  'workflow',
];

export function PulseDeckOnboardingBanner({
  onStartCreateRule,
}: {
  onStartCreateRule: () => void;
}) {
  const { t } = useTranslation('panels');

  const steps = [
    {
      num: '1.',
      title: t('pulseDeck.onboardingStep1Title'),
      desc: t('pulseDeck.onboardingStep1Desc'),
    },
    {
      num: '2.',
      title: t('pulseDeck.onboardingStep2Title'),
      desc: t('pulseDeck.onboardingStep2Desc'),
    },
    {
      num: '3.',
      title: t('pulseDeck.onboardingStep3Title'),
      desc: t('pulseDeck.onboardingStep3Desc'),
    },
  ];

  return (
    <section
      data-testid="pulse-onboarding-banner"
      aria-label={t('pulseDeck.onboardingTitle')}
      className="settings-surface space-y-3 rounded-lg border border-border bg-muted/20 p-3.5 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          {t('pulseDeck.onboardingTitle')}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="primary"
            data-testid="pulse-onboarding-create-rule"
            icon={<Plus className="h-3 w-3" />}
            onClick={onStartCreateRule}
          >
            {t('pulseDeck.onboardingCreateFromTemplate')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="pulse-onboarding-open-workflow"
            icon={<GitFork className="h-3 w-3" />}
            onClick={() => requestOpenWorkflowStudio()}
          >
            {t('pulseDeck.onboardingOpenWorkflow')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-border/60 pt-2.5 sm:grid-cols-3 sm:divide-x sm:divide-border/60">
        {steps.map((step, index) => (
          <div
            key={step.num}
            className={cn('space-y-0.5', index > 0 && 'sm:pl-3')}
          >
            <div className="font-medium text-foreground">
              <span className="mr-1 text-primary tabular-nums">{step.num}</span>
              {step.title}
            </div>
            <p className="text-[11px] text-muted-foreground">{step.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PulseDeckSourcesSection({
  addingSource,
  setAddingSource,
  sourceKind,
  setSourceKind,
  sourceTitle,
  setSourceTitle,
  signingSecret,
  setSigningSecret,
  savingSource,
  onSaveSource,
  displayedSources,
}: {
  addingSource: boolean;
  setAddingSource: (open: boolean) => void;
  sourceKind: EventSourceKind;
  setSourceKind: (kind: EventSourceKind) => void;
  sourceTitle: string;
  setSourceTitle: (value: string) => void;
  signingSecret: string;
  setSigningSecret: (value: string) => void;
  savingSource: boolean;
  onSaveSource: () => void;
  displayedSources: readonly PulseSourceView[];
}) {
  const { t } = useTranslation('panels');

  return (
    <div className="space-y-2.5">
      {addingSource ? (
        <section
          className="settings-surface space-y-2.5 rounded-lg border border-border bg-popover p-3"
          data-testid="pulse-deck-add-source-form"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-foreground">
              {t('pulseDeck.addSourceTitle')}
            </span>
            <div className="flex flex-wrap gap-1">
              {DEFAULT_SOURCE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  data-testid={`deck-source-kind-${kind}`}
                  onClick={() => setSourceKind(kind)}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                    sourceKind === kind
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(
                    `pulseDeck.sources.${kind.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11px]">
                {t('pulseDeck.sourceTitleLabel')}
              </Label>
              <Input
                aria-label={t('pulseDeck.sourceTitleLabel')}
                placeholder={t('pulseDeck.sourceTitlePlaceholder')}
                value={sourceTitle}
                onChange={(event) => setSourceTitle(event.target.value)}
                className="h-7 px-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">
                {t('pulseDeck.signingSecretLabel')}
              </Label>
              <Input
                type="password"
                aria-label={t('pulseDeck.signingSecretAria')}
                placeholder={t('pulseDeck.signingSecretPlaceholder')}
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
              {t('pulseDeck.composerCancel')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="primary"
              data-testid="pulse-deck-save-source-btn"
              disabled={!sourceTitle.trim() || savingSource}
              onClick={onSaveSource}
            >
              {savingSource
                ? t('pulseDeck.composerSaving')
                : t('pulseDeck.saveSource')}
            </Button>
          </div>
        </section>
      ) : null}

      <section
        aria-label={t('pulseDeck.sourcesStripAria')}
        className="flex flex-wrap items-center gap-1.5"
        data-testid="pulse-deck-sources-strip"
      >
        <span className="mr-1 text-[11px] font-medium text-muted-foreground">
          {t('pulseDeck.sourcesLabel')}
        </span>
        {displayedSources.map((source) => {
          const statusText = !source.enabled
            ? t('pulseDeck.sourceDisabled')
            : source.healthy
              ? t('pulseDeck.sourceHealthy')
              : t('pulseDeck.sourceUnhealthy');
          const hasCursor =
            Boolean(source.cursorWatermark) && source.cursorWatermark !== '0';
          const cursorTooltip = t('pulseDeck.sourceCursor', {
            cursor: source.cursorWatermark || '0',
          });

          return (
            <div
              key={source.id}
              data-testid={`pulse-source-card-${source.id}`}
              className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-0.5 text-[11px]"
            >
              <span
                data-testid={`pulse-source-health-${source.id}`}
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  !source.enabled
                    ? 'bg-muted-foreground'
                    : source.healthy
                      ? 'bg-success'
                      : 'bg-destructive'
                )}
                title={
                  !source.enabled
                    ? statusText
                    : source.healthy
                      ? statusText
                      : source.statusMessage || statusText
                }
              />
              <span className="font-medium text-foreground">
                {source.title}
              </span>
              <span
                className="text-muted-foreground tabular-nums"
                data-testid={`pulse-source-watermark-${source.id}`}
                title={cursorTooltip}
              >
                {hasCursor ? `${statusText} · ${cursorTooltip}` : statusText}
              </span>
              <span
                className="inline-flex items-center gap-1 border-l border-border pl-1.5 text-muted-foreground tabular-nums"
                data-testid={`pulse-source-counts-${source.id}`}
              >
                <span>
                  {t('pulseDeck.sourceReceived24h', {
                    count: source.receivedCount24h,
                  })}
                </span>
                {source.rejectedCount24h > 0 ? (
                  <span className="text-destructive">
                    {t('pulseDeck.sourceRejected24h', {
                      count: source.rejectedCount24h,
                    })}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </section>
    </div>
  );
}

export function PulseDeckRulesAndSubscriptions({
  rules,
  showRules,
  showSubscriptions,
  onToggleRuleEnabled,
  onSetRuleMode,
  subscriptions,
  subThreadKey,
  setSubThreadKey,
  subKind,
  setSubKind,
  subTargetId,
  setSubTargetId,
  subscribing,
  onSubscribeThread,
  onUnsubscribeThread,
}: {
  rules: readonly PulseRuleView[];
  showRules: boolean;
  showSubscriptions: boolean;
  onToggleRuleEnabled: (rule: PulseRuleView) => void;
  onSetRuleMode: (rule: PulseRuleView, mode: PulseEvalMode) => void;
  subscriptions: readonly PulseSubscriptionView[];
  subThreadKey: string;
  setSubThreadKey: (value: string) => void;
  subKind: PulseSubscriberKind;
  setSubKind: (kind: PulseSubscriberKind) => void;
  subTargetId: string;
  setSubTargetId: (value: string) => void;
  subscribing: boolean;
  onSubscribeThread: () => void;
  onUnsubscribeThread: (subscriptionId: string) => void;
}) {
  const { t } = useTranslation('panels');

  if (!showRules && !showSubscriptions) {
    return null;
  }

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4',
        showRules && showSubscriptions && 'lg:grid-cols-2'
      )}
    >
      {showRules ? (
        <section aria-label={t('pulseDeck.rulesAria')} className="space-y-2">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-primary" />
            {t('pulseDeck.rulesTitle')}
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground tabular-nums"
              data-testid="pulse-deck-rules-count"
            >
              {rules.length}
            </span>
          </h3>

          {rules.length === 0 ? (
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-muted-foreground">
              {t('pulseDeck.rulesEmpty')}
            </div>
          ) : (
            <div className="space-y-1.5" data-testid="pulse-deck-rules-list">
              {rules.map((rule) => {
                const workflowTarget = rule.spec.targets.find(
                  (target): target is Extract<
                    (typeof rule.spec.targets)[number],
                    { kind: 'workflow' }
                  > => target.kind === 'workflow'
                );

                return (
                  <div
                    key={rule.id}
                    data-testid={`pulse-deck-rule-${rule.id}`}
                    className="settings-surface flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-popover p-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={rule.enabled}
                        aria-label={t('pulseDeck.enableRuleAria', {
                          name: rule.spec.name,
                        })}
                        data-testid={`pulse-deck-rule-toggle-${rule.id}`}
                        onClick={() => onToggleRuleEnabled(rule)}
                        className={cn(
                          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                          rule.enabled ? 'bg-primary' : 'bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'inline-block h-3 w-3 rounded-full bg-background transition-transform',
                            rule.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                          )}
                        />
                      </button>

                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {rule.spec.name}
                        </p>
                        <p
                          className="mt-0.5 text-[11px] text-muted-foreground tabular-nums"
                          data-testid={`pulse-deck-rule-counts-${rule.id}`}
                        >
                          {t('pulseDeck.ruleCounts', {
                            matched: rule.matchedCount,
                            observed: rule.observedCount,
                          })}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {workflowTarget ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          data-testid={`pulse-deck-rule-open-workflow-${rule.id}`}
                          icon={<GitFork className="h-3 w-3" />}
                          onClick={() =>
                            requestOpenWorkflowStudio({
                              definitionId: workflowTarget.workflowId,
                            })
                          }
                        >
                          {t('pulseDeck.editWorkflowBtn')}
                        </Button>
                      ) : null}

                      <div
                        className="inline-flex shrink-0 rounded-md bg-muted/60 p-0.5"
                        role="group"
                        aria-label={t('pulseDeck.ruleModeAria', {
                          name: rule.spec.name,
                        })}
                      >
                        {EVAL_MODE_VALUES.map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            data-testid={`pulse-deck-rule-mode-${rule.id}-${mode}`}
                            onClick={() => onSetRuleMode(rule, mode)}
                            className={cn(
                              'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                              rule.spec.evalMode === mode
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                          >
                            {t(`pulseDeck.modes.${mode}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {showSubscriptions ? (
        <section
          aria-label={t('pulseDeck.subscriptionsAria')}
          className="space-y-2"
        >
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Link2 className="h-3.5 w-3.5 text-primary" />
            {t('pulseDeck.subscriptionsTitle')}
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
                aria-label={t('pulseDeck.subscriptionThreadKeyAria')}
                placeholder="jira:PROJ-123"
                value={subThreadKey}
                onChange={(event) => setSubThreadKey(event.target.value)}
                className="h-7 px-2 font-mono text-xs"
              />
              <div className="inline-flex rounded bg-muted/50 p-0.5">
                {SUBSCRIBER_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    data-testid={`deck-sub-kind-${kind}`}
                    onClick={() => setSubKind(kind)}
                    className={cn(
                      'flex-1 rounded px-1 py-0.5 text-[11px]',
                      subKind === kind
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground'
                    )}
                  >
                    {t(`pulseDeck.subscriberKinds.${kind}`)}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <Input
                  aria-label={t('pulseDeck.subscriberIdAria')}
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
                  onClick={onSubscribeThread}
                >
                  {t('pulseDeck.bindBtn')}
                </Button>
              </div>
            </div>

            {subscriptions.length === 0 ? (
              <p className="py-1 text-[11px] text-muted-foreground">
                {t('pulseDeck.subscriptionsEmpty')}
              </p>
            ) : (
              <div
                className="divide-y divide-border/60"
                data-testid="pulse-deck-subscriptions-list"
              >
                {subscriptions.map((sub) => (
                  <div
                    key={sub.id}
                    data-testid={`pulse-deck-subscription-${sub.id}`}
                    className="flex items-center justify-between gap-2 py-1.5"
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
                      aria-label={t('pulseDeck.unsubscribeAria', {
                        threadKey: sub.threadKey,
                      })}
                      data-testid={`pulse-deck-unsubscribe-${sub.id}`}
                      onClick={() => onUnsubscribeThread(sub.id)}
                    >
                      <Unlink className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
