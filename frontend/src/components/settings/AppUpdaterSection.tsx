import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadCloud, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import { ReleaseNotes } from '@/components/settings/ReleaseNotes';
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
  type AppUpdateSnapshot,
} from '@/lib/appUpdate';
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
  const busy = state === 'checking' || state === 'downloading';

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
            {update?.releaseUrl ? (
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() =>
                  window.open(
                    update.releaseUrl!,
                    '_blank',
                    'noopener,noreferrer'
                  )
                }
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
          <div className="settings-row pb-3">
            <p className="text-sm text-destructive">
              {t('appUpdater.updateFailed', { error: message })}
            </p>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
