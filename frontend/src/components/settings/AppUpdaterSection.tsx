import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  DownloadCloud,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { ReleaseNotes } from '@/components/settings/ReleaseNotes';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  CHECK_TTL_MS,
  checkAppUpdate,
  installSignedUpdate,
  readCachedAppUpdate,
  relaunchApp,
  subscribeAppUpdate,
  getAppUpdateState,
  subscribeAppUpdateState,
  type AppUpdateLifecycleState,
  type AppUpdateSnapshot,
} from '@/lib/appUpdate';
import { openInSystemBrowser } from '@/hooks/useOpenLink';
import { SettingsSection } from '@/pages/settings/SettingsUi';

type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'error';

interface AppUpdaterSectionProps {
  autoUpdateEnabled: boolean;
  onAutoUpdateChange: (enabled: boolean) => void;
}

function snapshotState(snapshot: AppUpdateSnapshot): UpdaterState {
  if (snapshot.error && !snapshot.checked) return 'error';
  if (snapshot.update) return 'available';
  if (snapshot.checked) return 'up-to-date';
  return 'idle';
}

export function AppUpdaterSection({
  autoUpdateEnabled,
  onAutoUpdateChange,
}: AppUpdaterSectionProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(() =>
    readCachedAppUpdate()
  );
  const [state, setState] = useState<UpdaterState>(() =>
    snapshot ? snapshotState(snapshot) : 'idle'
  );
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');

  const applySnapshot = useCallback((next: AppUpdateSnapshot) => {
    setSnapshot(next);
    setMessage(next.error ?? '');
    setState((current) =>
      current === 'downloading' || current === 'ready'
        ? current
        : snapshotState(next)
    );
  }, []);

  useEffect(() => subscribeAppUpdate(applySnapshot), [applySnapshot]);

  useEffect(() => {
    const syncLifecycle = (lifecycle: AppUpdateLifecycleState) => {
      if (
        lifecycle.status === 'downloading' ||
        lifecycle.status === 'installing'
      ) {
        setState('downloading');
        if (lifecycle.total && lifecycle.total > 0) {
          setProgress(
            Math.min(
              100,
              Math.round((lifecycle.downloaded / lifecycle.total) * 100)
            )
          );
        } else if (lifecycle.status === 'installing') {
          setProgress(100);
        }
      } else if (
        lifecycle.status === 'ready_to_restart' ||
        lifecycle.status === 'restarting'
      ) {
        setState('ready');
        setProgress(100);
      } else if (lifecycle.status === 'error') {
        setState('error');
        setMessage(lifecycle.error ?? '');
      }
    };

    const currentLifecycle = getAppUpdateState?.();
    if (currentLifecycle && currentLifecycle.status !== 'idle') {
      syncLifecycle(currentLifecycle);
    }

    return subscribeAppUpdateState?.(syncLifecycle);
  }, []);

  const checkForUpdate = useCallback(
    async (force: boolean) => {
      if (!force) {
        const cached = readCachedAppUpdate();
        if (
          cached &&
          Date.now() - cached.lastCheckedAt < CHECK_TTL_MS &&
          (cached.checked || cached.update)
        ) {
          applySnapshot(cached);
          return;
        }
      }
      setState('checking');
      setMessage('');
      try {
        const next = await checkAppUpdate({ force });
        applySnapshot(next);
      } catch (error) {
        setState('error');
        setMessage(String(error));
      }
    },
    [applySnapshot]
  );

  useEffect(() => {
    const cached = readCachedAppUpdate();
    if (cached) applySnapshot(cached);
    void checkForUpdate(false);
  }, [applySnapshot, checkForUpdate]);

  const downloadAndInstall = async () => {
    setState('downloading');
    setProgress(0);
    try {
      await installSignedUpdate(setProgress);
      setState('ready');
    } catch (error) {
      setState('error');
      setMessage(String(error));
    }
  };

  const formattedLastCheckedAt = useMemo(() => {
    if (!snapshot?.lastCheckedAt) return null;
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(snapshot.lastCheckedAt));
  }, [i18n.language, snapshot?.lastCheckedAt]);

  const formattedReleaseDate = useMemo(() => {
    if (!snapshot?.update?.date) return null;
    const parsed = new Date(snapshot.update.date);
    if (Number.isNaN(parsed.getTime())) return snapshot.update.date;
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
    }).format(parsed);
  }, [i18n.language, snapshot?.update?.date]);

  const currentVersion = snapshot?.currentVersion;
  const update = snapshot?.update;
  const diagnostic = snapshot?.diagnostic ?? null;
  const releaseUrl =
    update?.releaseUrl ??
    diagnostic?.fallbackReleaseUrl ??
    (state === 'error'
      ? 'https://github.com/DimoADE/Dimo/releases/latest'
      : null);
  const busy = state === 'checking' || state === 'downloading';

  const copyDiagnostics = useCallback(async () => {
    const lines = [
      '===== Dimo App Update Diagnostics =====',
      `current_version: ${currentVersion || 'unknown'}`,
      `state: ${state}`,
      diagnostic ? `stage: ${diagnostic.stage}` : null,
      diagnostic?.httpStatus != null
        ? `http_status: ${diagnostic.httpStatus}`
        : null,
      diagnostic?.proxySource
        ? `proxy_source: ${diagnostic.proxySource}`
        : null,
      diagnostic?.endpoint ? `endpoint: ${diagnostic.endpoint}` : null,
      diagnostic?.signedError
        ? `signed_feed_error: ${diagnostic.signedError}`
        : null,
      diagnostic?.githubError
        ? `github_release_error: ${diagnostic.githubError}`
        : null,
      message ? `error: ${message}` : null,
      diagnostic?.checkedAt
        ? `checked_at: ${diagnostic.checkedAt}`
        : snapshot?.lastCheckedAt
          ? `checked_at: ${new Date(snapshot.lastCheckedAt).toISOString()}`
          : null,
      releaseUrl ? `release_url: ${releaseUrl}` : null,
    ].filter((line): line is string => line !== null);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(t('appUpdater.diagnosticsCopied'));
    } catch {
      toast.error(t('appUpdater.diagnosticsCopyFailed'));
    }
  }, [
    currentVersion,
    diagnostic,
    message,
    releaseUrl,
    snapshot?.lastCheckedAt,
    state,
    t,
  ]);

  return (
    <SettingsSection
      icon={DownloadCloud}
      title={t('appUpdater.title')}
      description={t('appUpdater.description')}
    >
      <div className="settings-subrows">
        <div className="settings-row">
          <div>
            <Label htmlFor="auto-update-enabled" className="cursor-pointer">
              {t('system.autoCheckUpdate')}
            </Label>
            <p className="settings-row__description">
              {t('system.autoCheckUpdateDesc')}
            </p>
          </div>
          <Switch
            id="auto-update-enabled"
            className="settings-switch"
            checked={autoUpdateEnabled}
            onCheckedChange={onAutoUpdateChange}
          />
        </div>

        <div className="settings-row">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {currentVersion
                ? t('appUpdater.currentVersion', { version: currentVersion })
                : t('system.checking')}
              {update
                ? t('appUpdater.latestVersionSuffix', {
                    version: update.version,
                  })
                : ''}
            </div>
            {formattedLastCheckedAt ? (
              <p className="settings-row__description">
                {t('appUpdater.lastChecked', { time: formattedLastCheckedAt })}
              </p>
            ) : (
              <p className="settings-row__description">
                {t('appUpdater.neverChecked')}
              </p>
            )}
            {state === 'up-to-date' ? (
              <p className="settings-status-success mt-1 text-xs">
                {t('appUpdater.upToDate')}
              </p>
            ) : null}
            {state === 'available' && update ? (
              <p className="settings-status-warning mt-1 text-xs font-medium">
                {formattedReleaseDate
                  ? t('appUpdater.newVersionDated', {
                      version: update.version,
                      date: formattedReleaseDate,
                    })
                  : t('appUpdater.newVersionFound', {
                      version: update.version,
                    })}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {releaseUrl ? (
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void openInSystemBrowser(releaseUrl)}
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                {t('appUpdater.viewRelease')}
              </Button>
            ) : null}
            {state === 'ready' ? (
              <Button className="shrink-0" onClick={() => void relaunchApp()}>
                {t('appUpdater.restartNow')}
              </Button>
            ) : state === 'downloading' ||
              (state === 'available' && update?.canInstall) ? (
              <Button
                className="shrink-0"
                onClick={() => void downloadAndInstall()}
                disabled={busy}
              >
                {state === 'downloading' ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('appUpdater.downloadAndInstall')}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void checkForUpdate(true)}
                disabled={busy}
              >
                {state === 'checking' ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t('appUpdater.checkForUpdate')}
              </Button>
            )}
          </div>
        </div>

        {update ? (
          <div className="settings-row settings-row--stacked pb-3">
            <div className="text-sm font-medium">
              {t('appUpdater.releaseNotes')}
            </div>
            <ReleaseNotes
              notes={update.body}
              locale={i18n.language}
              label={t('appUpdater.releaseNotes')}
              emptyLabel={t('appUpdater.noReleaseNotes')}
            />
          </div>
        ) : null}

        {state === 'downloading' ? (
          <div className="settings-row settings-row--stacked pb-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="settings-row__description">
              {t('appUpdater.downloadingProgress', { progress })}
            </p>
          </div>
        ) : null}

        {state === 'ready' ? (
          <div className="settings-row pb-3">
            <p className="settings-row__description">
              {t('appUpdater.updateInstalled')}
            </p>
          </div>
        ) : null}

        {state === 'error' && message ? (
          <div className="settings-row settings-row--stacked pb-3">
            <div className="flex w-full items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="break-words text-sm text-destructive">
                  {t('appUpdater.updateFailed', { error: message })}
                </p>
                {diagnostic ? (
                  <p className="settings-row__description flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
                    <span>
                      {t(`appUpdater.diagnosticStage.${diagnostic.stage}`, {
                        defaultValue: diagnostic.stage,
                      })}
                    </span>
                    {diagnostic.httpStatus != null ? (
                      <span>
                        {t('appUpdater.diagnosticHttpStatus', {
                          status: diagnostic.httpStatus,
                        })}
                      </span>
                    ) : null}
                    {diagnostic.proxySource ? (
                      <span>
                        {t('appUpdater.diagnosticProxy', {
                          source: diagnostic.proxySource,
                        })}
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void copyDiagnostics()}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t('appUpdater.copyDiagnostics')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
