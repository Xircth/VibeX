import { Fragment, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowUpCircle,
  Check,
  ExternalLink,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useUserSystem } from '@/components/ConfigProvider';
import { ReleaseNotes } from '@/components/settings/ReleaseNotes';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  checkAppUpdate,
  dismissAppUpdateVersion,
  getAppUpdateState,
  getDismissedAppUpdateVersion,
  readCachedAppUpdate,
  relaunchApp,
  startAppUpdate,
  subscribeAppUpdate,
  subscribeAppUpdateState,
  subscribeDismissedAppUpdateVersion,
  type AppUpdateInfo,
  type AppUpdateLifecycleState,
} from '@/lib/appUpdate';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatReleaseDate(
  value: string | null | undefined,
  locale: string
): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(parsed);
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

const STEPS = ['download', 'install', 'restart'] as const;
type Step = (typeof STEPS)[number];

function StepRail({
  active,
  labels,
}: {
  active: Step;
  labels: Record<Step, string>;
}) {
  const activeIndex = STEPS.indexOf(active);
  return (
    <div className="flex items-center gap-2 text-xs">
      {STEPS.map((step, index) => {
        const done = index < activeIndex;
        const current = index === activeIndex;
        return (
          <Fragment key={step}>
            {index > 0 ? (
              <span
                className={cn('h-px w-3', done ? 'bg-primary/50' : 'bg-border')}
              />
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-1',
                current
                  ? 'font-medium text-primary'
                  : done
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground/50'
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  current
                    ? 'animate-pulse bg-primary'
                    : done
                      ? 'bg-primary/50'
                      : 'bg-border'
                )}
              />
              {labels[step]}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function UpdateAvailableBadge() {
  const { t, i18n } = useTranslation('statusbar');
  const { config } = useUserSystem();
  const autoUpdateEnabled = config?.auto_update_enabled ?? true;
  const cached = readCachedAppUpdate();
  const [currentVersion, setCurrentVersion] = useState<string | null>(
    () => cached?.currentVersion ?? null
  );
  const [available, setAvailable] = useState<AppUpdateInfo | null>(
    () => cached?.update ?? null
  );
  const [state, setState] = useState<AppUpdateLifecycleState>(() =>
    getAppUpdateState()
  );
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    getDismissedAppUpdateVersion()
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsubscribeSnapshot = subscribeAppUpdate((snapshot) => {
      setCurrentVersion(snapshot.currentVersion || null);
      setAvailable(snapshot.update);
    });
    const unsubscribeState = subscribeAppUpdateState(setState);
    const unsubscribeDismissed =
      subscribeDismissedAppUpdateVersion(setDismissedVersion);

    return () => {
      unsubscribeSnapshot();
      unsubscribeState();
      unsubscribeDismissed();
    };
  }, []);

  useEffect(() => {
    if (!autoUpdateEnabled) return;

    let cancelled = false;

    const runCheck = async (force = false) => {
      try {
        const snapshot = await checkAppUpdate({ force });
        if (!cancelled) {
          setCurrentVersion(snapshot.currentVersion || null);
          setAvailable(snapshot.update);
        }
      } catch {
        // Silent in status bar.
      }
    };

    void runCheck(false);
    const timer = window.setInterval(
      () => void runCheck(true),
      POLL_INTERVAL_MS
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [autoUpdateEnabled]);

  const downloading = state.status === 'downloading';
  const installing = state.status === 'installing';
  const isUpdating = downloading || installing;
  const ready = state.status === 'ready_to_restart';
  const restarting = state.status === 'restarting';
  const failed = state.status === 'error';
  const offering = !isUpdating && !ready && !restarting;

  if (!available && !isUpdating && !ready && !restarting) {
    return null;
  }

  const percent =
    downloading && state.total && state.total > 0
      ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
      : null;

  const muted = Boolean(available && dismissedVersion === available.version);
  const showAvailable = offering && available !== null;
  const canInstall = Boolean(available?.canInstall);

  const handleDismiss = () => {
    if (available) {
      dismissAppUpdateVersion(available.version);
    }
    setOpen(false);
  };

  const handleStartUpdate = () => {
    void Promise.resolve(startAppUpdate()).catch(() => {
      // Error is captured in shared lifecycleState and rendered in the popover.
    });
  };

  const handleRestart = () => {
    void Promise.resolve(relaunchApp()).catch(() => {
      // Error is captured in shared lifecycleState and rendered in the popover.
    });
  };

  const handleViewRelease = () => {
    if (!available?.releaseUrl) return;
    setOpen(false);
    void openExternalUrl(available.releaseUrl);
  };

  const formattedDate = formatReleaseDate(available?.date, i18n.language);
  const targetVersion = state.version ?? available?.version ?? null;
  const activeStep: Step = downloading
    ? 'download'
    : installing
      ? 'install'
      : 'restart';

  const triggerBadgeLabel = available
    ? t('update.newVersionBadge', { version: available.version })
    : t('updateAvailableTitle');

  const triggerLabel = restarting
    ? t('update.restarting')
    : ready
      ? t('update.restartToUpdate')
      : isUpdating
        ? downloading && percent !== null
          ? `${t('update.downloading')} ${percent}%`
          : downloading
            ? t('update.downloading')
            : t('update.updating')
        : triggerBadgeLabel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground',
            ((showAvailable && !muted) || ready) &&
              'text-primary hover:text-primary'
          )}
          title={showAvailable && muted ? triggerBadgeLabel : undefined}
          aria-label={triggerLabel}
        >
          {restarting ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span>{triggerLabel}</span>
            </>
          ) : ready ? (
            <>
              <ArrowUpCircle className="size-3" />
              <span>{t('update.restartToUpdate')}</span>
            </>
          ) : isUpdating ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span>{triggerLabel}</span>
            </>
          ) : showAvailable && muted ? (
            <ArrowUpCircle className="size-3" />
          ) : showAvailable ? (
            <>
              <Sparkles className="size-3" />
              <span>{triggerBadgeLabel}</span>
            </>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="flex w-80 flex-col gap-3 rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
      >
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {ready
              ? t('update.updateReadyHint')
              : offering
                ? t('update.updateAvailableTitle')
                : t('update.updateTitle')}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-mono">
              {currentVersion && targetVersion
                ? `v${currentVersion} → v${targetVersion}`
                : targetVersion
                  ? `v${targetVersion}`
                  : null}
            </span>
            {formattedDate ? <span>{formattedDate}</span> : null}
          </div>
        </div>

        {restarting || ready || isUpdating ? (
          <div className="space-y-2">
            <StepRail
              active={activeStep}
              labels={{
                download: t('update.stepDownload'),
                install: t('update.stepInstall'),
                restart: t('update.stepRestart'),
              }}
            />
            {downloading ? (
              <div className="space-y-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  {percent !== null ? (
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-200"
                      style={{ width: `${percent}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                  )}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {state.total && state.total > 0
                    ? `${formatBytes(state.downloaded)} / ${formatBytes(state.total)}`
                    : formatBytes(state.downloaded)}
                </div>
              </div>
            ) : installing ? (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
              </div>
            ) : restarting ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span>{t('update.restarting')}</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-foreground">
                <Check className="size-3.5 shrink-0 text-primary" />
                <span>{t('update.updateReadyHint')}</span>
              </div>
            )}
          </div>
        ) : null}

        {failed && state.error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {t('update.installFailed', { message: state.error })}
            </span>
          </div>
        ) : null}

        {available && available.body.trim().length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">
              {t('update.releaseNotesTitle')}
            </div>
            <ReleaseNotes
              notes={available.body}
              locale={i18n.language}
              label={t('update.releaseNotesTitle')}
              className="status-bar-release-notes max-h-48 text-xs"
            />
          </div>
        ) : null}

        {ready || (offering && (canInstall || available?.releaseUrl)) ? (
          <div className="flex items-center justify-end gap-2">
            {showAvailable ? (
              <Button variant="ghost" size="xs" onClick={handleDismiss}>
                {t('update.remindLater')}
              </Button>
            ) : null}
            {ready ? (
              <Button size="xs" onClick={handleRestart}>
                {t('update.restartToUpdate')}
              </Button>
            ) : failed && canInstall ? (
              <Button size="xs" onClick={handleStartUpdate}>
                {t('update.retry')}
              </Button>
            ) : offering && canInstall && available ? (
              <Button size="xs" onClick={handleStartUpdate}>
                {t('update.upgradeTo', { version: available.version })}
              </Button>
            ) : offering && available?.releaseUrl ? (
              <Button size="xs" variant="outline" onClick={handleViewRelease}>
                {t('update.viewRelease', { version: available.version })}
                <ExternalLink className="ml-1 size-3" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
