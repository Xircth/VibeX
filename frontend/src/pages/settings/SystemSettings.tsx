import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Download,
  ExternalLink,
  FileJson2,
  Gauge,
  Loader2,
  Network,
  PackageCheck,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { type Config } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  backupApi,
  configApi,
  systemSettingsApi,
  type BackupPreview,
  type SystemProxySettings,
  type SystemRenderingSettings,
  type SystemMaintenanceStatus,
} from '@/lib/api';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { ConversationBundlePanel } from '@/features/conversation/ConversationBundle';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';

import { SettingsSection } from './SettingsUi';
import { AppUpdaterSection } from '@/components/settings/AppUpdaterSection';

type SystemSettingsConfig = Config;

const DEFAULT_PROXY_SETTINGS: SystemProxySettings = {
  enabled: false,
  proxy_url: null,
};
const DEFAULT_RENDERING_SETTINGS: SystemRenderingSettings = {
  acceleration_mode: 'auto',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Partial<T>[]
): T {
  const result = { ...target };

  for (const source of sources) {
    for (const key of Object.keys(source) as (keyof T)[]) {
      const srcVal = source[key];
      const tgtVal = result[key];

      if (
        srcVal &&
        typeof srcVal === 'object' &&
        !Array.isArray(srcVal) &&
        tgtVal &&
        typeof tgtVal === 'object' &&
        !Array.isArray(tgtVal)
      ) {
        (result as Record<string, unknown>)[key as string] = deepMerge(
          tgtVal as Record<string, unknown>,
          srcVal as Record<string, unknown>
        );
      } else {
        (result as Record<string, unknown>)[key as string] = srcVal;
      }
    }
  }

  return result;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sanitizeDraft(draft: SystemSettingsConfig): SystemSettingsConfig {
  return {
    ...draft,
    editor: {
      ...draft.editor,
      remote_ssh_host: null,
      remote_ssh_user: null,
    },
  };
}

export function SystemSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config, loading, updateAndSaveConfig } = useUserSystem();

  const [draft, setDraft] = useState<SystemSettingsConfig | null>(() =>
    config ? structuredClone(config as SystemSettingsConfig) : null
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isClearingLocalData, setIsClearingLocalData] = useState(false);
  const [maintenanceStatus, setMaintenanceStatus] =
    useState<SystemMaintenanceStatus | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [proxySettings, setProxySettings] = useState<SystemProxySettings>(
    DEFAULT_PROXY_SETTINGS
  );
  const [proxyDraft, setProxyDraft] = useState<SystemProxySettings>(
    DEFAULT_PROXY_SETTINGS
  );
  const [proxyLoading, setProxyLoading] = useState(true);
  const [proxySaving, setProxySaving] = useState(false);
  const [renderingSettings, setRenderingSettings] =
    useState<SystemRenderingSettings>(DEFAULT_RENDERING_SETTINGS);
  const [renderingDraft, setRenderingDraft] = useState<SystemRenderingSettings>(
    DEFAULT_RENDERING_SETTINGS
  );
  const [renderingLoading, setRenderingLoading] = useState(true);
  const [renderingSaving, setRenderingSaving] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [restorePath, setRestorePath] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  // The preview's already_exists flag is only meaningful for an inspect/restore
  // preview (on a create preview every entry trivially exists), so track the source.
  const [previewIsRestore, setPreviewIsRestore] = useState(false);
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
    null
  );
  const [backupPreviewPath, setBackupPreviewPath] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [settingsPath, setSettingsPath] = useState('~/.vibex/settings.json');

  useEffect(() => {
    if (!config || dirty) {
      return;
    }

    setDraft(structuredClone(config as SystemSettingsConfig));
  }, [config, dirty]);

  const refreshMaintenanceStatus = useCallback(async () => {
    setMaintenanceLoading(true);
    try {
      const status = await configApi.getSystemMaintenanceStatus();
      setMaintenanceStatus(status);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('system.maintenanceCheckFailed')
      );
    } finally {
      setMaintenanceLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshMaintenanceStatus();
  }, [refreshMaintenanceStatus]);

  const refreshSystemSettings = useCallback(async () => {
    setProxyLoading(true);
    setRenderingLoading(true);

    try {
      const [proxy, rendering] = await Promise.all([
        systemSettingsApi.getProxy(),
        systemSettingsApi.getRendering(),
      ]);
      setProxySettings(proxy);
      setProxyDraft(proxy);
      setRenderingSettings(rendering);
      setRenderingDraft(rendering);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.loadSettingsFailed')
      );
    } finally {
      setProxyLoading(false);
      setRenderingLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshSystemSettings();
  }, [refreshSystemSettings]);

  useEffect(() => {
    let cancelled = false;
    void configApi
      .getSettingsPath()
      .then((path) => {
        if (!cancelled) setSettingsPath(path);
      })
      .catch(() => {
        // Keep the canonical fallback visible if path resolution fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !config) {
      return false;
    }

    return !deepEqual(draft, config);
  }, [config, draft]);

  const proxyDirty = useMemo(
    () => !deepEqual(proxyDraft, proxySettings),
    [proxyDraft, proxySettings]
  );

  const renderingDirty = useMemo(
    () => !deepEqual(renderingDraft, renderingSettings),
    [renderingDraft, renderingSettings]
  );

  useEffect(() => {
    const refreshOnFocus = () => {
      if (!proxyDirty && !renderingDirty) void refreshSystemSettings();
    };
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener(SETTINGS_CHANGED_EVENT, refreshOnFocus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refreshOnFocus);
    };
  }, [proxyDirty, refreshSystemSettings, renderingDirty]);

  const updateDraft = useCallback(
    (patch: Partial<SystemSettingsConfig>) => {
      setDraft((previous) => {
        if (!previous) {
          return previous;
        }

        const next = deepMerge({} as SystemSettingsConfig, previous, patch);
        if (!deepEqual(next, config)) {
          setDirty(true);
        }
        return next;
      });
    },
    [config]
  );

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const handleSaveProxy = async () => {
    setProxySaving(true);
    try {
      const saved = await systemSettingsApi.updateProxy(proxyDraft);
      setProxySettings(saved);
      setProxyDraft(saved);
      toast.success(t('system.proxySaved'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.proxySaveFailed')
      );
    } finally {
      setProxySaving(false);
    }
  };

  const handleSaveRendering = async () => {
    setRenderingSaving(true);
    try {
      const saved = await systemSettingsApi.updateRendering(renderingDraft);
      setRenderingSettings(saved);
      setRenderingDraft(saved);
      toast.success(t('system.renderingSaved'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.renderingSaveFailed')
      );
    } finally {
      setRenderingSaving(false);
    }
  };

  const handleCreateBackup = async () => {
    const path = backupPath.trim();
    if (!path) {
      toast.error(t('system.backupPathRequired'));
      return;
    }

    setBackupBusy(true);
    const toastId = toast.loading(t('system.backupExporting'));
    try {
      const preview = await backupApi.create({
        path,
        passphrase: backupPassphrase.trim() || null,
      });
      setBackupPreview(preview);
      setBackupPreviewPath(path);
      setPreviewIsRestore(false);
      toast.success(t('system.backupExported'), { id: toastId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.backupExportFailed'),
        {
          id: toastId,
        }
      );
    } finally {
      setBackupBusy(false);
    }
  };

  const handleInspectBackup = async () => {
    const path = restorePath.trim();
    if (!path) {
      toast.error(t('system.restorePathRequired'));
      return;
    }

    setRestoreBusy(true);
    try {
      const preview = await backupApi.inspect({
        path,
        passphrase: restorePassphrase.trim() || null,
      });
      setBackupPreview(preview);
      setBackupPreviewPath(path);
      setPreviewIsRestore(true);
      toast.success(t('system.backupPreviewLoaded'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.backupPreviewFailed')
      );
    } finally {
      setRestoreBusy(false);
    }
  };

  const restoreInspectedBackup = async () => {
    const path = restorePath.trim();
    if (!path || !backupPreview || backupPreviewPath !== path) {
      toast.error(t('system.previewBeforeRestore'));
      return;
    }

    setRestoreBusy(true);
    const toastId = toast.loading(t('system.backupRestoring'));
    try {
      const result = await backupApi.restoreStage({
        path,
        passphrase: restorePassphrase.trim() || null,
        confirmed: true,
      });
      setBackupPreview(result.preview);
      setBackupPreviewPath(path);
      setPreviewIsRestore(true);
      toast.success(
        result.requires_reload
          ? t('system.backupRestoredReload')
          : t('system.backupRestored'),
        { id: toastId }
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('system.backupRestoreFailed'),
        {
          id: toastId,
        }
      );
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleRestoreBackup = () => {
    if (
      !restorePath.trim() ||
      !backupPreview ||
      backupPreviewPath !== restorePath.trim()
    ) {
      toast.error(t('system.previewBeforeRestore'));
      return;
    }

    const toastId = toast.warning(t('system.confirmRestore'), {
      duration: 8000,
      action: {
        label: t('system.restore'),
        onClick: () => {
          toast.dismiss(toastId);
          void restoreInspectedBackup();
        },
      },
      cancel: {
        label: t('common:cancel'),
        onClick: () => toast.dismiss(toastId),
      },
    });
  };

  const handleSave = async () => {
    if (!draft) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const sanitized = sanitizeDraft(draft);
      const saved = await updateAndSaveConfig(sanitized);

      if (saved) {
        setDraft(structuredClone(sanitized));
        setDirty(false);
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Failed to save settings'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) {
      return;
    }

    setDraft(structuredClone(config as SystemSettingsConfig));
    setDirty(false);
    setSaveError(null);
  };

  const confirmClearLocalData = useCallback(async () => {
    setIsClearingLocalData(true);
    const toastId = toast.loading(t('system.clearingLocalData'));

    try {
      const result = await configApi.clearLocalData();
      useWindowProjectsStore.getState().resetProjectWindowState();
      toast.success(t('system.localDataCleared'), { id: toastId });
      if (
        result.requires_reload &&
        !window.location.pathname.startsWith('/settings')
      ) {
        window.setTimeout(() => window.location.reload(), 700);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('system.clearLocalDataFailed'),
        {
          id: toastId,
        }
      );
    } finally {
      setIsClearingLocalData(false);
    }
  }, [t]);

  const handleClearLocalData = useCallback(() => {
    const toastId = toast.warning(t('system.confirmClearLocalData'), {
      duration: 8000,
      action: {
        label: t('system.clear'),
        onClick: () => {
          toast.dismiss(toastId);
          void confirmClearLocalData();
        },
      },
      cancel: {
        label: t('common:cancel'),
        onClick: () => toast.dismiss(toastId),
      },
    });
  }, [confirmClearLocalData, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!config || !draft) {
    return null;
  }

  return (
    <div className="settings-content">
      <div className="space-y-7">
        <SettingsSection
          icon={FileJson2}
          title={t('system.jsonTitle')}
          description={t('system.jsonDescription')}
        >
          <div className="settings-row block px-4 py-3">
            <code className="select-all break-all font-mono text-xs text-foreground">
              {settingsPath}
            </code>
          </div>
        </SettingsSection>

        <AppUpdaterSection />
        <SettingsSection
          icon={PackageCheck}
          title={t('system.localEnvTitle')}
          description={t('system.localEnvDescription')}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="auto-update-enabled"
                  className="cursor-pointer text-xs"
                >
                  {t('system.autoCheckUpdate')}
                </Label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('system.autoCheckUpdateDesc')}
                </p>
              </div>
              <Switch
                id="auto-update-enabled"
                className="settings-switch"
                checked={draft.auto_update_enabled ?? true}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ auto_update_enabled: checked })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="auto-install-local-dependencies"
                  className="cursor-pointer text-xs"
                >
                  {t('system.autoMaintainDeps')}
                </Label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('system.autoMaintainDepsDesc')}
                </p>
              </div>
              <Switch
                id="auto-install-local-dependencies"
                className="settings-switch"
                checked={draft.auto_install_local_dependencies ?? true}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ auto_install_local_dependencies: checked })
                }
              />
            </div>

            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">
                    {t('system.appVersion')}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {t('system.currentVersion', {
                      version:
                        maintenanceStatus?.app.current_version ??
                        t('system.checking'),
                    })}
                    {maintenanceStatus?.app.latest_version
                      ? t('system.latestVersionSuffix', {
                          version: maintenanceStatus.app.latest_version,
                        })
                      : ''}
                  </div>
                  {maintenanceStatus?.app.update_available ? (
                    <div className="settings-status-warning mt-1 text-[11px] font-medium">
                      {t('system.updateAvailable')}
                    </div>
                  ) : maintenanceStatus?.app.checked ? (
                    <div className="settings-status-success mt-1 text-[11px]">
                      {t('system.appUpToDate')}
                    </div>
                  ) : maintenanceStatus?.app.error ? (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {maintenanceStatus.app.error}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {maintenanceStatus?.app.release_url ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() =>
                        window.open(
                          maintenanceStatus.app.release_url!,
                          '_blank',
                          'noopener,noreferrer'
                        )
                      }
                    >
                      <ExternalLink className="mr-1 h-3.5 w-3.5" />
                      Release
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => void refreshMaintenanceStatus()}
                    disabled={maintenanceLoading}
                  >
                    <RefreshCw
                      className={`mr-1 h-3.5 w-3.5 ${
                        maintenanceLoading ? 'animate-spin' : ''
                      }`}
                    />
                    {t('system.check')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Network}
          title={t('system.proxyTitle')}
          description={t('system.proxyDescription')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="system-proxy-enabled" className="text-xs">
                  {t('system.enableProxy')}
                </Label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('system.proxyValidateHint')}
                </p>
              </div>
              <Switch
                id="system-proxy-enabled"
                className="settings-switch"
                checked={proxyDraft.enabled}
                disabled={proxyLoading || proxySaving}
                onCheckedChange={(checked: boolean) =>
                  setProxyDraft((previous) => ({
                    ...previous,
                    enabled: checked,
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="system-proxy-url"
                className="text-xs font-medium text-muted-foreground"
              >
                {t('system.proxyUrl')}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="system-proxy-url"
                  value={proxyDraft.proxy_url ?? ''}
                  placeholder="http://127.0.0.1:7890"
                  disabled={proxyLoading || proxySaving}
                  onChange={(event) =>
                    setProxyDraft((previous) => ({
                      ...previous,
                      proxy_url: event.target.value,
                    }))
                  }
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => void handleSaveProxy()}
                  disabled={proxyLoading || proxySaving || !proxyDirty}
                >
                  {proxySaving ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('common:save')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('system.proxyProtocolHint')}
              </p>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Gauge}
          title={t('system.renderingTitle')}
          description={t('system.renderingDescription')}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-xs">{t('system.accelerationMode')}</Label>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('system.accelerationModeDesc')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={renderingDraft.acceleration_mode}
                onValueChange={(
                  value: SystemRenderingSettings['acceleration_mode']
                ) =>
                  setRenderingDraft({
                    acceleration_mode: value,
                  })
                }
                disabled={renderingLoading || renderingSaving}
              >
                <SelectTrigger className="!w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="auto">
                    {t('system.accelerationAuto')}
                  </SelectItem>
                  <SelectItem value="force_gpu">
                    {t('system.accelerationForceGpu')}
                  </SelectItem>
                  <SelectItem value="disable_gpu">
                    {t('system.accelerationDisableGpu')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void handleSaveRendering()}
                disabled={
                  renderingLoading || renderingSaving || !renderingDirty
                }
              >
                {renderingSaving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {t('common:save')}
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Archive}
          title={t('system.backupTitle')}
          description={t('system.backupDescription')}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-xs font-semibold">
                {t('system.exportBackup')}
              </div>
              <div className="flex gap-2">
                <Input
                  value={backupPath}
                  placeholder="C:\\Users\\Administrator\\Desktop\\vibex-backup.vibexbak"
                  onChange={(event) => setBackupPath(event.target.value)}
                  disabled={backupBusy}
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => void handleCreateBackup()}
                  disabled={backupBusy}
                >
                  {backupBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('system.export')}
                </Button>
              </div>
              <Input
                type="password"
                value={backupPassphrase}
                placeholder={t('system.encryptPassphrasePlaceholder')}
                onChange={(event) => setBackupPassphrase(event.target.value)}
                disabled={backupBusy}
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold">
                {t('system.restoreBackup')}
              </div>
              <div className="flex gap-2">
                <Input
                  value={restorePath}
                  placeholder={t('system.restorePathPlaceholder')}
                  onChange={(event) => setRestorePath(event.target.value)}
                  disabled={restoreBusy}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => void handleInspectBackup()}
                  disabled={restoreBusy}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  {t('system.preview')}
                </Button>
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={handleRestoreBackup}
                  disabled={
                    restoreBusy ||
                    !backupPreview ||
                    backupPreviewPath !== restorePath.trim()
                  }
                >
                  {restoreBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Archive className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('system.restore')}
                </Button>
              </div>
              <Input
                type="password"
                value={restorePassphrase}
                placeholder={t('system.decryptPassphrasePlaceholder')}
                onChange={(event) => setRestorePassphrase(event.target.value)}
                disabled={restoreBusy}
              />
            </div>

            {backupPreview ? (
              <div className="settings-inline-group p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold">
                      {t('system.backupPreviewTitle')}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {backupPreviewPath}
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-muted-foreground">
                    <div>
                      {t('system.fileCount', {
                        count: backupPreview.manifest.entry_count,
                      })}
                    </div>
                    <div>{formatBytes(backupPreview.manifest.total_bytes)}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                  <div>
                    {t('system.formatLabel', {
                      format: backupPreview.manifest.format,
                    })}
                  </div>
                  <div>
                    {t('system.versionLabel', {
                      version: backupPreview.manifest.version,
                    })}
                  </div>
                  <div>
                    {t('system.appLabel', {
                      version: backupPreview.manifest.app_version,
                    })}
                  </div>
                  <div>
                    {t('system.createdLabel', {
                      date: new Date(
                        backupPreview.manifest.created_at
                      ).toLocaleString(),
                    })}
                  </div>
                </div>
                <div className="mt-3 max-h-32 overflow-y-auto rounded-md border border-border/70">
                  {backupPreview.entries.slice(0, 8).map((entry) => (
                    <div
                      key={entry.path}
                      className="flex items-center justify-between gap-3 px-2 py-1.5 text-[11px]"
                    >
                      <span className="min-w-0 truncate">{entry.path}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                        {previewIsRestore && entry.already_exists ? (
                          <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">
                            {t('system.willOverwrite')}
                          </span>
                        ) : null}
                        {formatBytes(entry.size_bytes)}
                      </span>
                    </div>
                  ))}
                  {backupPreview.entries.length > 8 ? (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {t('system.moreEntries', {
                        count: backupPreview.entries.length - 8,
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            <ConversationBundlePanel />
          </div>
        </SettingsSection>

        <SettingsSection icon={Trash2} title={t('system.clearLocalDataTitle')}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">
              {t('system.clearLocalDataLabel')}
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleClearLocalData}
              disabled={isClearingLocalData}
            >
              {isClearingLocalData ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t('system.clear')}
            </Button>
          </div>
        </SettingsSection>
      </div>

      {hasUnsavedChanges ? (
        <div className="settings-action-bar sticky bottom-0 z-10 mt-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t('common:settingsChanged')}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleDiscard}
                disabled={saving}
              >
                <Undo2 className="mr-1 h-3 w-3" />
                {t('common:cancel')}
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Save className="mr-1 h-3 w-3" />
                )}
                {t('system.saveSettings')}
              </Button>
            </div>
          </div>
          {saveError ? (
            <p className="mt-2 text-xs text-destructive">{saveError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
