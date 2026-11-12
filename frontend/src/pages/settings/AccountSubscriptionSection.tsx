import { useMemo } from 'react';
import {
  Activity,
  Coins,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  openAccountWebPath,
  useVibeXAccount,
  type AccountTier,
  type RouterCreditGrant,
} from '@/features/model-router';
import { cn } from '@/lib/utils';

const MICRO = 1_000_000;

type GrantLifecycleState = 'active' | 'used' | 'expired' | 'voided';

function formatCredits(micro: number, fractionDigits = 2): string {
  return (micro / MICRO).toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return value.toLocaleString('en-US');
}

function resolveGrantState(
  grant: RouterCreditGrant,
  nowIso: string
): GrantLifecycleState {
  if (grant.voided) return 'voided';
  if (grant.expiresAt && grant.expiresAt <= nowIso) return 'expired';
  return grant.remainingMicro > 0 ? 'active' : 'used';
}

function formatIsoDate(iso: string): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function AccountSubscriptionSection() {
  const { t } = useTranslation(['settings', 'common']);
  const { isSignedIn, overview, user, isLoading, isFetching, refresh } =
    useVibeXAccount();

  const nowIso = overview?.serverNow || new Date().toISOString();
  const balanceMicro = overview?.balanceMicro ?? 0;
  const grants = useMemo(() => overview?.grants ?? [], [overview?.grants]);

  const activeGrants = useMemo(
    () => grants.filter((g) => resolveGrantState(g, nowIso) === 'active'),
    [grants, nowIso]
  );

  const activeTotalMicro = useMemo(
    () => activeGrants.reduce((sum, g) => sum + g.amountMicro, 0),
    [activeGrants]
  );

  const activeRemainingMicro = useMemo(
    () => activeGrants.reduce((sum, g) => sum + g.remainingMicro, 0),
    [activeGrants]
  );

  const activeUsedMicro = Math.max(0, activeTotalMicro - activeRemainingMicro);
  const remainingPercent =
    activeTotalMicro > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((activeRemainingMicro / activeTotalMicro) * 100)
          )
        )
      : balanceMicro > 0
        ? 100
        : 0;
  const usedPercent = activeTotalMicro > 0 ? 100 - remainingPercent : 0;

  const soonestExpiring = useMemo(() => {
    if (activeGrants.length === 0) return null;
    return [...activeGrants].sort((a, b) =>
      a.expiresAt.localeCompare(b.expiresAt)
    )[0];
  }, [activeGrants]);

  const byModel = useMemo(
    () => overview?.usage30d?.byModel ?? [],
    [overview?.usage30d?.byModel]
  );

  const spent30dMicro = useMemo(
    () => byModel.reduce((sum, row) => sum + row.costMicro, 0),
    [byModel]
  );
  const requests30d = useMemo(
    () => byModel.reduce((sum, row) => sum + row.requests, 0),
    [byModel]
  );
  const tokens30d = useMemo(
    () => byModel.reduce((sum, row) => sum + row.tokens, 0),
    [byModel]
  );

  const modelNameMap = useMemo(() => {
    const map: Record<string, string> = {
      ...(overview?.usage30d?.modelNames ?? {}),
    };
    for (const model of overview?.models ?? []) {
      if (!map[model.id]) {
        map[model.id] = model.name;
      }
    }
    return map;
  }, [overview?.models, overview?.usage30d?.modelNames]);

  const tier: AccountTier = user?.tier ?? 'regular';
  const hasActiveCreditsOrTier =
    tier !== 'regular' || balanceMicro > 0 || activeGrants.length > 0;

  const planName = useMemo(() => {
    if (tier === 'subscriber') return t('settings:subscription.tierSubscriber');
    if (tier === 'sponsor') return t('settings:subscription.tierSponsor');
    if (tier === 'beta') return t('settings:subscription.tierBeta');
    if (tier === 'admin') return t('settings:subscription.tierAdmin');
    return hasActiveCreditsOrTier
      ? t('settings:subscription.tierPaygActive')
      : t('settings:subscription.tierFree');
  }, [hasActiveCreditsOrTier, t, tier]);

  if (!isSignedIn || (isLoading && !overview)) {
    return null;
  }

  const openPlanCenter = () => {
    void openAccountWebPath('/account/plan');
  };

  const openModelRouterStore = () => {
    void openAccountWebPath('/account/models');
  };

  return (
    <section
      id="account-subscription-section"
      data-testid="account-subscription-section"
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('settings:subscription.title')}
        </h3>
        <button
          type="button"
          onClick={openPlanCenter}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>{t('settings:subscription.headerPlanAction')}</span>
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      {!overview ? (
        <div
          data-testid="account-subscription-load-error"
          className="settings-card flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4"
        >
          <p className="text-xs text-muted-foreground">
            {t('settings:subscription.loadErrorDesc')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => void refresh()}
            className="h-8 shrink-0 gap-1.5 text-xs"
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
              aria-hidden="true"
            />
            <span>{t('settings:account.refresh')}</span>
          </Button>
        </div>
      ) : (
        <>
          {/* Card 1: VibeX Subscription Plan + Credits Usage */}
          <div
            data-testid="subscription-plan-credits-card"
            className="settings-card space-y-5 rounded-xl border border-border bg-card p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3.5">
                <div
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                >
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      data-testid="subscription-plan-name"
                      className="text-base font-semibold text-foreground"
                    >
                      {planName}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                        hasActiveCreditsOrTier
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-border bg-muted text-muted-foreground'
                      )}
                    >
                      {hasActiveCreditsOrTier
                        ? t('settings:subscription.planStatusActive')
                        : t('settings:subscription.planStatusOnDemand')}
                    </span>
                    {activeGrants.length > 0 ? (
                      <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                        {t('settings:subscription.activePacksBadge', {
                          count: activeGrants.length,
                        })}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:subscription.planDesc')}
                  </p>
                  {soonestExpiring ? (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t('settings:subscription.expiringNotice', {
                        amount: formatCredits(soonestExpiring.remainingMicro),
                        date: formatIsoDate(soonestExpiring.expiresAt),
                      })}
                    </p>
                  ) : null}
                </div>
              </div>

              <Button
                type="button"
                size="sm"
                onClick={openModelRouterStore}
                className="shrink-0 gap-1.5"
                data-testid="subscription-buy-credits-button"
              >
                <span>{t('settings:subscription.buyOrUpgrade')}</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>

            <div className="space-y-4 rounded-lg bg-muted/35 p-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Coins
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{t('settings:subscription.metricAvailable')}</span>
                  </div>
                  <div
                    data-testid="subscription-balance-value"
                    className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums"
                  >
                    {formatCredits(balanceMicro)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('settings:subscription.unitCredits')}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {t('settings:subscription.metricActiveQuota')}
                  </div>
                  <div className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums">
                    {formatCredits(
                      activeTotalMicro > 0 ? activeTotalMicro : balanceMicro
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {activeTotalMicro > 0
                      ? t('settings:subscription.metricUsedCaption', {
                          used: formatCredits(activeUsedMicro),
                        })
                      : t('settings:subscription.noActivePacksCaption')}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {t('settings:subscription.metricSpent30d')}
                  </div>
                  <div
                    data-testid="subscription-spent30d-value"
                    className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums"
                  >
                    {formatCredits(spent30dMicro)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('settings:subscription.unitCredits')}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {t('settings:subscription.metricActivity30d')}
                  </div>
                  <div className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums">
                    {requests30d.toLocaleString('en-US')}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {t('settings:subscription.metricTokensCaption', {
                      tokens: formatCompactCount(tokens30d),
                    })}
                  </div>
                </div>
              </div>

              {activeTotalMicro > 0 ? (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">
                      {t('settings:subscription.quotaProgressLabel')}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {t('settings:subscription.quotaProgressSummary', {
                        usedPercent,
                        remaining: formatCredits(activeRemainingMicro),
                        total: formatCredits(activeTotalMicro),
                      })}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={t('settings:subscription.quotaProgressLabel')}
                    aria-valuenow={usedPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-background/80"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${usedPercent}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {grants.length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {t('settings:subscription.creditPacksTitle')}
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-[11px] text-muted-foreground">
                        <th className="pb-2 font-medium">
                          {t('settings:subscription.packColSource')}
                        </th>
                        <th className="pb-2 text-right font-medium">
                          {t('settings:subscription.packColRemaining')}
                        </th>
                        <th className="pb-2 text-right font-medium">
                          {t('settings:subscription.packColExpires')}
                        </th>
                        <th className="pb-2 text-right font-medium">
                          {t('settings:subscription.packColStatus')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {grants.slice(0, 5).map((grant) => {
                        const state = resolveGrantState(grant, nowIso);
                        const sourceLabel = t(
                          `settings:subscription.packSource.${grant.source}`
                        );
                        const detail = grant.note || grant.orderNo;
                        return (
                          <tr
                            key={grant.id}
                            data-testid={`credit-grant-row-${grant.id}`}
                            className="text-foreground/90"
                          >
                            <td className="py-1.5 pr-3">
                              <span className="font-medium text-foreground">
                                {sourceLabel}
                              </span>
                              {detail ? (
                                <span className="ml-1.5 text-muted-foreground">
                                  · {detail}
                                </span>
                              ) : null}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                              <span className="text-foreground">
                                {formatCredits(grant.remainingMicro)}
                              </span>
                              <span className="text-muted-foreground">
                                {' / '}
                                {formatCredits(grant.amountMicro)}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-muted-foreground tabular-nums">
                              {formatIsoDate(grant.expiresAt)}
                            </td>
                            <td className="py-1.5 pl-2 text-right">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                                  state === 'active'
                                    ? 'bg-primary/10 text-primary'
                                    : state === 'voided'
                                      ? 'bg-destructive/10 text-destructive'
                                      : 'bg-muted text-muted-foreground'
                                )}
                              >
                                {t(`settings:subscription.packState.${state}`)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>

          {/* Card 2: Model Usage Overview (Last 30 Days) + Official Site Plan Handoff */}
          <div
            data-testid="subscription-model-overview-card"
            className="settings-card overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="space-y-3 p-5">
              <h4 className="text-xs font-medium text-muted-foreground">
                {t('settings:subscription.modelOverviewTitle')}
              </h4>

              {byModel.length === 0 ? (
                <div
                  data-testid="subscription-model-empty"
                  className="flex flex-col items-center justify-center gap-1.5 py-4 text-center"
                >
                  <Activity
                    className="h-5 w-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="text-xs font-medium text-foreground">
                    {t('settings:subscription.modelEmptyTitle')}
                  </div>
                  <p className="max-w-md text-xs text-muted-foreground">
                    {t('settings:subscription.modelEmptyDesc')}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-[11px] text-muted-foreground">
                        <th className="pb-2.5 font-medium">
                          {t('settings:subscription.modelColName')}
                        </th>
                        <th className="pb-2.5 text-right font-medium">
                          {t('settings:subscription.modelColRequests')}
                        </th>
                        <th className="pb-2.5 text-right font-medium">
                          {t('settings:subscription.modelColTokens')}
                        </th>
                        <th className="pb-2.5 text-right font-medium">
                          {t('settings:subscription.modelColCredits')}
                        </th>
                        <th className="pb-2.5 text-right font-medium">
                          {t('settings:subscription.modelColShare')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {byModel.map((row) => {
                        const share =
                          spent30dMicro > 0
                            ? Math.round((row.costMicro / spent30dMicro) * 100)
                            : 0;
                        return (
                          <tr
                            key={row.modelId}
                            data-testid={`model-usage-row-${row.modelId}`}
                          >
                            <td className="py-2 pr-3 font-medium text-foreground">
                              {modelNameMap[row.modelId] ?? row.modelId}
                            </td>
                            <td className="py-2 px-2 text-right font-mono text-muted-foreground tabular-nums">
                              {row.requests.toLocaleString('en-US')}
                            </td>
                            <td className="py-2 px-2 text-right font-mono text-muted-foreground tabular-nums">
                              {formatCompactCount(row.tokens)}
                            </td>
                            <td className="py-2 px-2 text-right font-mono font-medium text-foreground tabular-nums">
                              {formatCredits(row.costMicro, 4)}
                            </td>
                            <td className="py-2 pl-2 text-right font-mono text-muted-foreground tabular-nums">
                              {share}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/35 px-5 py-3.5">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {t('settings:subscription.sitePlanHint')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openPlanCenter}
                className="shrink-0 gap-1.5"
                data-testid="open-site-plan-details"
              >
                <span>{t('settings:subscription.sitePlanAction')}</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
