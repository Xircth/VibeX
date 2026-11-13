import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Bug,
  Download,
  FileJson2,
  FolderOpen,
  Gauge,
  Loader2,
  Network,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { type Config } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
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
} from '@/lib/api';
import { desktopApi } from '@/lib/api/misc';
import { pickHostDirectory } from '@/lib/hostFs';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { ConversationBundlePanel } from '@/features/conversation/ConversationBundle';
import { getInvokeErrorMessage } from '@/lib/errors';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';
import { useLocalDesktopHost, useTauriClient } from '@/lib/desktopShell';

import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';
import { AppUpdaterSection } from '@/components/settings/AppUpdaterSection';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';

type SystemSettingsConfig = Config;

const DEFAULT_PROXY_SETTINGS: SystemProxySettings = {
  mode: 'auto',
  proxy_url: null,
  detected_url: null,
  detected_source: null,
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

function proxyDetectionCopy(
  settings: SystemProxySettings,
  t: (key: string, options?: Record<string, string>) => string
): string {
  const detected = settings.detected_url?.trim();
  if (!detected) {
    return t('system.proxyDetectedNone');
  }
  if (settings.detected_source === 'pac') {
    return t('system.proxyDetectedPac', { url: detected });
  }
  return t('system.proxyDetected', { url: detected });
}

function sanitizeDraft(draft: SystemSettingsConfig): SystemSettingsConfig {
  return {
    ...draft,
    editor: {
      ...draft.editor,
    },
  };
}

export function SystemSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const localDesktopHost = useLocalDesktopHost();
  const tauriClient = useTauriClient();

  const [draft, setDraft] = useState<SystemSettingsConfig | null>(() =>
    config ? structuredClone(config as SystemSettingsConfig) : null
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [isClearingLocalData, setIsClearingLocalData] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<SystemProxySettings>(
    DEFAULT_PROXY_SETTINGS
  );
  const proxyDraftRef = useRef(proxyDraft);
  proxyDraftRef.current = proxyDraft;
  const [proxyLoading, setProxyLoading] = useState(true);
  const [renderingDraft, setRenderingDraft] = useState<SystemRenderingSettings>(
    DEFAULT_RENDERING_SETTINGS
  );
  const renderingDraftRef = useRef(renderingDraft);
  renderingDraftRef.current = renderingDraft;
  const [renderingLoading, setRenderingLoading] = useState(true);
  const [developerMode, setDeveloperMode] = useState(false);
  const [developerModeLoading, setDeveloperModeLoading] = useState(tauriClient);
  const developerModeHoldingRef = useRef(false);
  const { writeNow, holding } = useLiveSettingsCommit(
    async (next: SystemSettingsConfig) => {
      const saved = await updateAndSaveConfig(sanitizeDraft(next));
      if (!saved) {
        toast.error(t('general.saveFailed'));
      }
    }
  );
  const {
    writeNow: writeProxyNow,
    writeSettled: writeProxySettled,
    flush: flushProxy,
    holdingRef: proxyHoldingRef,
  } = useLiveSettingsCommit(async (next: SystemProxySettings) => {
    try {
      const saved = await systemSettingsApi.updateProxy(next);
      if (
        proxyDraftRef.current.mode === next.mode &&
        (proxyDraftRef.current.proxy_url ?? '') === (next.proxy_url ?? '')
      ) {
        proxyDraftRef.current = saved;
        setProxyDraft(saved);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.proxySaveFailed')
      );
    }
  });
  const { writeNow: writeRenderingNow, holdingRef: renderingHoldingRef } =
    useLiveSettingsCommit(async (next: SystemRenderingSettings) => {
      try {
        const saved = await systemSettingsApi.updateRendering(next);
        renderingDraftRef.current = saved;
        setRenderingDraft(saved);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('system.renderingSaveFailed')
        );
      }
    });
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
  const [dataDir, setDataDir] = useState('');
  const [savedDataDir, setSavedDataDir] = useState('');
  const [dataDirBusy, setDataDirBusy] = useState(false);

  const appliedConfig = useRef(config);
  useEffect(() => {
    if (!config || holding) return;
    if (config === appliedConfig.current) return;
    appliedConfig.current = config;
    const next = structuredClone(config as SystemSettingsConfig);
    draftRef.current = next;
    setDraft(next);
  }, [config, holding]);

  const refreshSystemSettings = useCallback(async () => {
    setProxyLoading(true);
    setRenderingLoading(true);

    try {
      const [proxy, rendering] = await Promise.all([
        systemSettingsApi.getProxy(),
        systemSettingsApi.getRendering(),
      ]);
      if (!proxyHoldingRef.current) {
        proxyDraftRef.current = proxy;
        setProxyDraft(proxy);
      }
      if (!renderingHoldingRef.current) {
        renderingDraftRef.current = rendering;
        setRenderingDraft(rendering);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.loadSettingsFailed')
      );
    } finally {
      setProxyLoading(false);
      setRenderingLoading(false);
    }

    if (tauriClient) {
      try {
        const enabled = await desktopApi.getDeveloperMode();
        if (!developerModeHoldingRef.current) {
          setDeveloperMode(enabled);
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('system.developerModeSaveFailed')
        );
      } finally {
        setDeveloperModeLoading(false);
      }
    }

    try {
      const dataDirSettings = await systemSettingsApi.getDataDir?.();
      if (dataDirSettings?.current_data_dir) {
        setDataDir(dataDirSettings.current_data_dir);
        setSavedDataDir(dataDirSettings.current_data_dir);
      }
    } catch {
      // Optional during backend transition or mocked environments.
    }
  }, [proxyHoldingRef, renderingHoldingRef, t, tauriClient]);

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

  useEffect(() => {
    const refreshOnFocus = () => {
      void refreshSystemSettings();
    };
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener(SETTINGS_CHANGED_EVENT, refreshOnFocus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refreshOnFocus);
    };
  }, [refreshSystemSettings]);

  const updateDraft = useCallback(
    (patch: Partial<SystemSettingsConfig>) => {
      const previous = draftRef.current;
      if (!previous) return;
      const next = deepMerge({} as SystemSettingsConfig, previous, patch);
      draftRef.current = next;
      setDraft(next);
      writeNow(next);
    },
    [writeNow]
  );

  const updateProxyDraft = (next: SystemProxySettings, settle = false) => {
    proxyDraftRef.current = next;
    setProxyDraft(next);
    if (settle) writeProxySettled(next);
    else writeProxyNow(next);
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
      const message = getInvokeErrorMessage(error).trim();
      toast.error(message || t('system.clearLocalDataFailed'), {
        id: toastId,
      });
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

  const applyDataDirChange = useCallback(
    async (targetDir: string) => {
      const trimmed = targetDir.trim();
      if (!trimmed || trimmed === savedDataDir) return;

      setDataDirBusy(true);
      const toastId = toast.loading(
        t('system.dataDirMigrating', '正在迁移数据并切换存储位置...')
      );
      try {
        const result = await systemSettingsApi.updateDataDir(trimmed);
        setDataDir(result.current_data_dir);
        setSavedDataDir(result.current_data_dir);
        toast.success(
          result.requires_reload
            ? t('system.dataDirSavedReload', '数据存储位置已更新，建议重启应用')
            : t('system.dataDirSaved', '数据存储位置已更新'),
          { id: toastId }
        );
        if (
          result.requires_reload &&
          !window.location.pathname.startsWith('/settings')
        ) {
          window.setTimeout(() => window.location.reload(), 700);
        }
      } catch (error) {
        const message = getInvokeErrorMessage(error).trim();
        toast.error(
          message || t('system.dataDirSaveFailed', '数据存储位置更新失败'),
          { id: toastId }
        );
      } finally {
        setDataDirBusy(false);
      }
    },
    [savedDataDir, t]
  );

  const handleConfirmDataDirChange = useCallback(
    (targetDir: string) => {
      const trimmed = targetDir.trim();
      if (!trimmed || trimmed === savedDataDir) return;

      const toastId = toast.warning(
        t(
          'system.confirmDataDirChange',
          '确认将数据存储位置更改并迁移至新目录？'
        ),
        {
          duration: 8000,
          action: {
            label: t('system.confirmMigrate', '确认迁移'),
            onClick: () => {
              toast.dismiss(toastId);
              void applyDataDirChange(trimmed);
            },
          },
          cancel: {
            label: t('common:cancel'),
            onClick: () => toast.dismiss(toastId),
          },
        }
      );
    },
    [applyDataDirChange, savedDataDir, t]
  );

  const handlePickDataDir = useCallback(async () => {
    try {
      const selected = await pickHostDirectory({
        title: t('system.dataDirTitle', '数据存储位置'),
        value: dataDir,
      });
      if (selected && selected.trim()) {
        setDataDir(selected.trim());
        handleConfirmDataDirChange(selected.trim());
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('system.dataDirSaveFailed', '数据存储位置更新失败')
      );
    }
  }, [dataDir, handleConfirmDataDirChange, t]);

  if (loading) {
    return <SurfaceLoading />;
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

        <SettingsSection
          icon={FolderOpen}
          title={t('system.dataDirTitle', '数据存储位置')}
          description={t(
            'system.dataDirDescription',
            'VibeX 本地数据库、协作空间与附件统一保存在此目录。更改后将自动迁移现有数据。'
          )}
        >
          <div className="flex items-center gap-2">
            <TextInput
              label={t('system.dataDirTitle', '数据存储位置')}
              isLabelHidden
              value={dataDir}
              placeholder="~/.vibex"
              onChange={setDataDir}
              isDisabled={dataDirBusy}
              width="100%"
              className="[&_input]:font-mono [&_input]:text-xs"
            />
            {dataDir.trim() && dataDir.trim() !== savedDataDir ? (
              <Button
                className="shrink-0"
                onClick={() => handleConfirmDataDirChange(dataDir)}
                disabled={dataDirBusy}
              >
                {dataDirBusy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('system.applyDataDir', '迁移并应用')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => void handlePickDataDir()}
              disabled={dataDirBusy}
            >
              {t('system.changeDataDir', '更改目录…')}
            </Button>
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => {
                if (dataDir.trim()) {
                  void desktopApi.revealInFileManager(dataDir.trim());
                }
              }}
              disabled={!dataDir.trim() || dataDirBusy}
            >
              <FolderOpen className="mr-1 h-3.5 w-3.5" />
              {t('system.openInFolder', '在文件夹中打开')}
            </Button>
          </div>
        </SettingsSection>

        <AppUpdaterSection
          autoUpdateEnabled={draft.auto_update_enabled ?? true}
          onAutoUpdateChange={(checked) =>
            updateDraft({ auto_update_enabled: checked })
          }
        />

        <SettingsSection
          icon={Network}
          title={t('system.proxyTitle')}
          description={t('system.proxyDescription')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="system-proxy-mode">
                  {t('system.proxyMode')}
                </Label>
                <p className="settings-row__description">
                  {proxyDraft.mode === 'auto'
                    ? proxyDetectionCopy(proxyDraft, t)
                    : t('system.proxyManualHint')}
                </p>
              </div>
              <Select
                value={proxyDraft.mode}
                onValueChange={(value: SystemProxySettings['mode']) => {
                  const previous = proxyDraftRef.current;
                  updateProxyDraft({
                    ...previous,
                    mode: value,
                    proxy_url:
                      value === 'manual' &&
                      !previous.proxy_url?.trim() &&
                      previous.detected_source !== 'pac'
                        ? (previous.detected_url ?? previous.proxy_url)
                        : previous.proxy_url,
                  });
                }}
                disabled={proxyLoading}
              >
                <SelectTrigger id="system-proxy-mode" className="!w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="auto">
                    {t('system.proxyModeAuto')}
                  </SelectItem>
                  <SelectItem value="manual">
                    {t('system.proxyModeManual')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {proxyDraft.mode === 'manual' ? (
              <div className="space-y-1.5">
                <Label>{t('system.proxyUrl')}</Label>
                <TextInput
                  label={t('system.proxyUrl')}
                  isLabelHidden
                  value={proxyDraft.proxy_url ?? ''}
                  placeholder="http://127.0.0.1:7890"
                  isDisabled={proxyLoading}
                  onChange={(value) =>
                    updateProxyDraft(
                      {
                        ...proxyDraftRef.current,
                        proxy_url: value,
                      },
                      true
                    )
                  }
                  onBlur={() => void flushProxy()}
                  width="100%"
                  className="[&_input]:text-sm"
                />
                <p className="settings-row__description">
                  {t('system.proxyProtocolHint')}
                </p>
              </div>
            ) : null}
          </div>
        </SettingsSection>

        {localDesktopHost ? (
          <>
            <SettingsSection
              icon={Gauge}
              title={t('system.renderingTitle')}
              description={t('system.renderingDescription')}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>{t('system.accelerationMode')}</Label>
                  <p className="settings-row__description">
                    {t('system.accelerationModeDesc')}
                  </p>
                </div>
                <Select
                  value={renderingDraft.acceleration_mode}
                  onValueChange={(
                    value: SystemRenderingSettings['acceleration_mode']
                  ) => {
                    const next = { acceleration_mode: value };
                    renderingDraftRef.current = next;
                    setRenderingDraft(next);
                    writeRenderingNow(next);
                  }}
                  disabled={renderingLoading}
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
              </div>
            </SettingsSection>

            <SettingsSection
              icon={Archive}
              title={t('system.backupTitle')}
              description={t('system.backupDescription')}
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm">{t('system.exportBackup')}</Label>
                  <div className="flex gap-2">
                    <TextInput
                      label="C:\\Users\\Administrator\\Desktop\\vibex-backup.vibexbak"
                      isLabelHidden
                      value={backupPath}
                      placeholder="C:\\Users\\Administrator\\Desktop\\vibex-backup.vibexbak"
                      onChange={setBackupPath}
                      isDisabled={backupBusy}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                    <Button
                      className="shrink-0"
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
                  <TextInput
                    label={t('system.encryptPassphrasePlaceholder')}
                    isLabelHidden
                    type="password"
                    value={backupPassphrase}
                    placeholder={t('system.encryptPassphrasePlaceholder')}
                    onChange={setBackupPassphrase}
                    isDisabled={backupBusy}
                    width="100%"
                    className="[&_input]:text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">{t('system.restoreBackup')}</Label>
                  <div className="flex gap-2">
                    <TextInput
                      label={t('system.restorePathPlaceholder')}
                      isLabelHidden
                      value={restorePath}
                      placeholder={t('system.restorePathPlaceholder')}
                      onChange={setRestorePath}
                      isDisabled={restoreBusy}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                    <Button
                      variant="outline"
                      className="shrink-0"
                      onClick={() => void handleInspectBackup()}
                      disabled={restoreBusy}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                      {t('system.preview')}
                    </Button>
                    <Button
                      className="shrink-0"
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
                  <TextInput
                    label={t('system.decryptPassphrasePlaceholder')}
                    isLabelHidden
                    type="password"
                    value={restorePassphrase}
                    placeholder={t('system.decryptPassphrasePlaceholder')}
                    onChange={setRestorePassphrase}
                    isDisabled={restoreBusy}
                    width="100%"
                    className="[&_input]:text-sm"
                  />
                </div>

                {backupPreview ? (
                  <div className="settings-inline-group p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">
                          {t('system.backupPreviewTitle')}
                        </div>
                        <div className="settings-row__description">
                          {backupPreviewPath}
                        </div>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        <div>
                          {t('system.fileCount', {
                            count: backupPreview.manifest.entry_count,
                          })}
                        </div>
                        <div>
                          {formatBytes(backupPreview.manifest.total_bytes)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
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
                          className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs"
                        >
                          <span className="min-w-0 truncate">{entry.path}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                            {previewIsRestore && entry.already_exists ? (
                              <span className="rounded bg-warning/15 px-1 py-0.5 text-xs text-warning">
                                {t('system.willOverwrite')}
                              </span>
                            ) : null}
                            {formatBytes(entry.size_bytes)}
                          </span>
                        </div>
                      ))}
                      {backupPreview.entries.length > 8 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
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
          </>
        ) : null}

        <SettingsSection icon={Trash2} title={t('system.clearLocalDataTitle')}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">
              {t('system.clearLocalDataLabel')}
            </span>
            <Button
              variant="destructive"
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

        {tauriClient ? (
          <SettingsSection
            icon={Bug}
            title={t('system.developerMode')}
            description={t('system.developerModeDescription')}
            bare={!developerMode}
            action={
              <Switch
                aria-label={t('system.developerMode')}
                checked={developerMode}
                disabled={developerModeLoading}
                onCheckedChange={(checked) => {
                  const previous = developerMode;
                  developerModeHoldingRef.current = true;
                  setDeveloperMode(checked);
                  void desktopApi
                    .setDeveloperMode(checked)
                    .then((saved) => {
                      setDeveloperMode(saved);
                    })
                    .catch((error: unknown) => {
                      setDeveloperMode(previous);
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : t('system.developerModeSaveFailed')
                      );
                    })
                    .finally(() => {
                      developerModeHoldingRef.current = false;
                    });
                }}
              />
            }
          >
            {developerMode ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    void desktopApi
                      .openDeveloperTools()
                      .catch((error: unknown) => {
                        toast.error(
                          getInvokeErrorMessage(error) ||
                            t('system.developerModeSaveFailed')
                        );
                      });
                  }}
                >
                  {t('system.openDeveloperTools')}
                </Button>
              </div>
            ) : null}
          </SettingsSection>
        ) : null}
      </div>
    </div>
  );
}
