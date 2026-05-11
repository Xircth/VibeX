import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Clock3, CreditCard, RefreshCw } from 'lucide-react';
import {
  codexAccountApi,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const CODEX_RATE_LIMIT_STALE_TIME_MS = 60_000;
const CODEX_RATE_LIMIT_GC_TIME_MS = 5 * 60_000;

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatPlanType(value: string | null | undefined): string {
  if (!value) return '未知套餐';
  if (value.toLowerCase() === 'pro') return 'Pro';
  if (value.toLowerCase() === 'plus') return 'Plus';
  if (value.toLowerCase() === 'team') return 'Team';
  if (value.toLowerCase() === 'enterprise') return 'Enterprise';
  return value;
}

function formatResetTime(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const resetMs = value > 1_000_000_000_000 ? value : value * 1000;
  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) return '即将重置';

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟后重置`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} 小时后重置`;

  const days = Math.ceil(hours / 24);
  return `${days} 天后重置`;
}

function resolveSnapshot(
  response: Awaited<ReturnType<typeof codexAccountApi.getRateLimits>> | null
): CodexRateLimitSnapshot | null {
  if (!response) return null;
  return response.rateLimitsByLimitId?.codex ?? response.rateLimits ?? null;
}

function RateLimitRow({
  title,
  description,
  window,
}: {
  title: string;
  description: string;
  window: CodexRateLimitWindow | null | undefined;
}) {
  const usedPercent = clampPercent(window?.usedPercent);
  const resetLabel = formatResetTime(window?.resetsAt);
  const remainingPercent =
    usedPercent === null ? null : Math.max(0, 100 - usedPercent);

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-foreground">
            {usedPercent === null ? '--' : `${usedPercent}% 已用`}
          </div>
          <div className="text-xs text-muted-foreground">
            {remainingPercent === null ? '--' : `剩余 ${remainingPercent}%`}
          </div>
        </div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            usedPercent !== null && usedPercent >= 90
              ? 'bg-destructive'
              : usedPercent !== null && usedPercent >= 70
                ? 'bg-amber-500'
                : 'bg-primary'
          )}
          style={{ width: `${usedPercent ?? 0}%` }}
        />
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />
        <span>{resetLabel ?? '暂无重置时间'}</span>
      </div>
    </div>
  );
}

export function CodexPlanDashboard() {
  const rateLimitsQuery = useQuery({
    queryKey: ['codexAccountRateLimits'],
    queryFn: () => codexAccountApi.getRateLimits(),
    staleTime: CODEX_RATE_LIMIT_STALE_TIME_MS,
    gcTime: CODEX_RATE_LIMIT_GC_TIME_MS,
  });

  const snapshot = useMemo(
    () => resolveSnapshot(rateLimitsQuery.data ?? null),
    [rateLimitsQuery.data]
  );
  const planLabel = formatPlanType(snapshot?.planType);
  const limitName = snapshot?.limitName || snapshot?.limitId || 'codex';
  const credits = snapshot?.credits;
  const error =
    rateLimitsQuery.error instanceof Error
      ? rateLimitsQuery.error.message
      : rateLimitsQuery.error
        ? String(rateLimitsQuery.error)
        : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            Codex 套餐
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            读取 Codex 账号的实时限额，与 Codex app-server 的套餐数据保持一致。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void rateLimitsQuery.refetch()}
          disabled={rateLimitsQuery.isFetching}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw
            className={cn(
              'h-4 w-4',
              rateLimitsQuery.isFetching && 'animate-spin'
            )}
          />
          刷新
        </button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">无法读取 Codex 套餐限额</div>
            <div className="mt-1 opacity-90">{error}</div>
          </div>
        </div>
      ) : null}

      {rateLimitsQuery.isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-border bg-background p-10 text-sm text-muted-foreground">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          正在读取 Codex 套餐限额...
        </div>
      ) : null}

      {!rateLimitsQuery.isLoading && !snapshot && !error ? (
        <div className="flex items-center justify-center rounded-lg border border-border bg-background p-10 text-sm text-muted-foreground">
          暂无 Codex 套餐数据
        </div>
      ) : null}

      {snapshot ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-border bg-background p-4">
              <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                <CreditCard className="h-4 w-4" />
                当前套餐
              </div>
              <div className="text-2xl font-semibold text-foreground">
                {planLabel}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                限额桶：{limitName}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background p-4">
              <div className="mb-2 text-sm text-muted-foreground">Credits</div>
              <div className="text-2xl font-semibold text-foreground">
                {credits?.unlimited
                  ? 'Unlimited'
                  : credits?.balance !== null && credits?.balance !== undefined
                    ? credits.balance
                    : '--'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {credits?.hasCredits ? '账号包含 Credits' : '未启用 Credits'}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background p-4">
              <div className="mb-2 text-sm text-muted-foreground">限额状态</div>
              <div className="text-2xl font-semibold text-foreground">
                {snapshot.rateLimitReachedType ? '已触达' : '正常'}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {snapshot.rateLimitReachedType ?? '当前未触发限额拦截'}
              </div>
            </div>
          </div>

          <RateLimitRow
            title="5h limit"
            description="当前滚动会话窗口的 Codex 使用限额"
            window={snapshot.primary}
          />

          <RateLimitRow
            title="Weekly limit"
            description="每周 Codex 使用限额"
            window={snapshot.secondary}
          />
        </>
      ) : null}
    </div>
  );
}
