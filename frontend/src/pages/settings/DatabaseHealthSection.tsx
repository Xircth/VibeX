import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  dbHealthApi,
  formatStorageBytes,
  type DbHealthApi,
  type DbHealthReport,
  type DbOptimizeReport,
  type EventFoldReport,
} from '@/lib/dbHealthApi';

const FRAGMENTATION_ADVISORY_THRESHOLD = 0.3;

export interface DatabaseHealthSectionProps {
  api?: DbHealthApi;
  initialReport?: DbHealthReport;
}

export function DatabaseHealthSection({
  api = dbHealthApi,
  initialReport,
}: DatabaseHealthSectionProps) {
  const { t } = useTranslation(['settings']);
  const [report, setReport] = useState<DbHealthReport | null>(
    () => initialReport ?? null
  );
  const [isLoading, setIsLoading] = useState(!initialReport);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isFolding, setIsFolding] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<DbOptimizeReport | null>(
    null
  );
  const [foldResult, setFoldResult] = useState<EventFoldReport | null>(null);

  const loadHealth = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const next = await api.getHealthReport();
      setReport(next);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (initialReport) return;
    void loadHealth();
  }, [initialReport, loadHealth]);

  const handleOptimize = async () => {
    setIsOptimizing(true);
    setLoadError(null);
    try {
      const result = await api.optimizeDatabase();
      setOptimizeResult(result);
      const refreshed = await api.getHealthReport();
      setReport(refreshed);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleFoldEvents = async () => {
    setIsFolding(true);
    setLoadError(null);
    try {
      const result = await api.triggerEventFolding();
      setFoldResult(result);
      const refreshed = await api.getHealthReport();
      setReport(refreshed);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFolding(false);
    }
  };

  const sortedTables = useMemo(() => {
    if (!report) return [];
    const entries = Object.entries(report.tableSizes).sort(
      (a, b) => b[1] - a[1]
    );
    const totalRows = entries.reduce((sum, [, count]) => sum + count, 0);
    return entries.map(([name, count]) => ({
      name,
      count,
      sharePercent:
        totalRows > 0 ? Math.min(100, Math.round((count / totalRows) * 100)) : 0,
    }));
  }, [report]);

  const fragmentationPercent = report
    ? `${(report.fragmentationRatio * 100).toFixed(1)}%`
    : '0.0%';
  const showFragmentationAdvisory = Boolean(
    report && report.fragmentationRatio > FRAGMENTATION_ADVISORY_THRESHOLD
  );

  return (
    <section
      data-testid="database-health-section"
      className="space-y-4 rounded-xl border border-border bg-card/50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">
            {t('settings:databaseHealth.title')}
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isLoading || isOptimizing || isFolding}
            onClick={() => void loadHealth()}
            data-testid="db-health-refresh-btn"
            className="h-7 gap-1 px-2 text-xs"
          >
            <RefreshCw
              className={
                isLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'
              }
            />
            <span>{t('settings:databaseHealth.refresh')}</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isFolding || isOptimizing}
            onClick={() => void handleFoldEvents()}
            data-testid="db-fold-events-btn"
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            {isFolding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Layers className="h-3.5 w-3.5" />
            )}
            <span>
              {isFolding
                ? t('settings:databaseHealth.folding')
                : t('settings:databaseHealth.foldButton')}
            </span>
          </Button>

          <Button
            type="button"
            size="sm"
            disabled={isOptimizing || isFolding}
            onClick={() => void handleOptimize()}
            data-testid="db-optimize-btn"
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            {isOptimizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            <span>
              {isOptimizing
                ? t('settings:databaseHealth.optimizing')
                : t('settings:databaseHealth.optimizeButton')}
            </span>
          </Button>
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          data-testid="db-health-error"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {t('settings:databaseHealth.loadFailed', { error: loadError })}
        </div>
      ) : null}

      {optimizeResult ? (
        <div
          role="status"
          data-testid="db-optimize-result"
          className="flex items-center gap-2 rounded-lg border border-[hsl(var(--success))]/35 bg-[hsl(var(--success))]/10 px-3 py-2 text-xs text-foreground tabular-nums"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[hsl(var(--success))]" />
          <span>
            {t('settings:databaseHealth.optimizeResult', {
              reclaimed: formatStorageBytes(optimizeResult.bytesReclaimed),
              before: formatStorageBytes(optimizeResult.walSizeBefore),
              after: formatStorageBytes(optimizeResult.walSizeAfter),
            })}
          </span>
        </div>
      ) : null}

      {foldResult ? (
        <div
          role="status"
          data-testid="db-fold-result"
          className="flex items-center gap-2 rounded-lg border border-[hsl(var(--success))]/35 bg-[hsl(var(--success))]/10 px-3 py-2 text-xs text-foreground tabular-nums"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[hsl(var(--success))]" />
          <span>
            {t('settings:databaseHealth.foldResult', {
              operations: foldResult.foldOperations.toLocaleString(),
              conversations: foldResult.conversationsScanned.toLocaleString(),
              before: foldResult.eventsBefore.toLocaleString(),
              after: foldResult.eventsAfter.toLocaleString(),
              reclaimed: formatStorageBytes(foldResult.bytesReclaimed),
            })}
          </span>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-background/70 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">
                {t('settings:databaseHealth.totalSize')}
              </div>
              <div
                data-testid="db-total-size-stat"
                className="mt-1 text-sm font-semibold text-foreground tabular-nums"
              >
                {formatStorageBytes(report.totalDbSizeBytes)}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/70 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">
                {t('settings:databaseHealth.walSize')}
              </div>
              <div
                data-testid="db-wal-size-stat"
                className="mt-1 text-sm font-semibold text-foreground tabular-nums"
              >
                {formatStorageBytes(report.walSizeBytes)}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/70 px-3 py-2.5">
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-[11px] text-muted-foreground">
                  {t('settings:databaseHealth.fragmentation')}
                </span>
                {showFragmentationAdvisory ? (
                  <span
                    data-testid="db-fragmentation-advisory"
                    className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    <span>
                      {t('settings:databaseHealth.fragmentationAdvisory')}
                    </span>
                  </span>
                ) : null}
              </div>
              <div
                data-testid="db-fragmentation-stat"
                className="mt-1 text-sm font-semibold text-foreground tabular-nums"
              >
                {fragmentationPercent}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/70 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">
                {t('settings:databaseHealth.foldedEvents')}
              </div>
              <div
                data-testid="db-folded-events-stat"
                className="mt-1 text-sm font-semibold text-foreground tabular-nums"
              >
                {report.foldedEventCount.toLocaleString()} /{' '}
                {report.eventCount.toLocaleString()}
              </div>
            </div>
          </div>

          {sortedTables.length > 0 ? (
            <div className="space-y-2 rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs font-medium text-foreground">
                {t('settings:databaseHealth.tableBreakdown')}
              </div>
              <div data-testid="db-table-sizes" className="space-y-1.5">
                {sortedTables.map((table) => (
                  <div key={table.name} className="space-y-1 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-foreground">
                        {table.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {table.count.toLocaleString()} ({table.sharePercent}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/75"
                        style={{ width: `${table.sharePercent}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : isLoading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('settings:databaseHealth.loading')}</span>
        </div>
      ) : null}
    </section>
  );
}
