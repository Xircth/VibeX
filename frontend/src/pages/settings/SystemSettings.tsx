import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { type Config } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import {
  pickHostDirectory,
  pickHostFile,
  pickHostSavePath,
} from '@/lib/hostFs';
import { formatStorageBytes } from '@/lib/dbHealthApi';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { ConversationBundlePanel } from '@/features/conversation/ConversationBundle';
import { getInvokeErrorMessage } from '@/lib/errors';
import {
  SETTINGS_CHANGED_EVENT,
  clearLocalFrontendStorage,
} from '@/lib/frontendPreferences';
import { cancelPendingCanvasPersist } from '@/components/kanban/canvas/canvasStorage';
import { clearAllBrowserSurfaces } from '@/features/host-browser/browserPanelLifetime';
import { useLocalDesktopHost } from '@/lib/desktopShell';

import { SettingsSection } from './SettingsUi';
import { DatabaseHealthSection } from './DatabaseHealthSection';
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
const BACKUP_EXTENSION = 'dimobak';

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
  const [backupBusy, setBackupBusy] = useState(false);
  const [settingsPath, setSettingsPath] = useState('~/.dimo/settings.json');
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

    try {
      const dataDirSettings = await systemSettingsApi.getDataDir?.();
      if (dataDirSettings?.current_data_dir) {
        setDataDir(dataDirSettings.current_data_dir);
        setSavedDataDir(dataDirSettings.current_data_dir);
      }
    } catch {
      // Optional during backend transition or mocked environments.
    }
  }, [proxyHoldingRef, renderingHoldingRef, t]);

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

  const handleExportBackup = async () => {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    let path: string | null;
    try {
      path = await pickHostSavePath({
        title: t('system.exportBackup'),
        defaultName: `dimo-backup-${date}.${BACKUP_EXTENSION}`,
        extensions: [BACKUP_EXTENSION],
      });
    } catch (error) {
      toast.error(
        getInvokeErrorMessage(error).trim() || t('system.backupExportFailed')
      );
      return;
    }
    if (!path) return;

    setBackupBusy(true);
    const toastId = toast.loading(t('system.backupExporting'));
    try {
      await backupApi.create({ path });
      toast.success(t('system.backupExported'), {
        id: toastId,
        description: path,
      });
    } catch (error) {
      toast.error(
        getInvokeErrorMessage(error).trim() || t('system.backupExportFailed'),
        { id: toastId }
      );
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async (path: string) => {
    setBackupBusy(true);
    const toastId = toast.loading(t('system.backupRestoring'));
    try {
      const result = await backupApi.restoreStage({ path, confirmed: true });
      toast.success(
        result.requires_reload
          ? t('system.backupRestoredReload')
          : t('system.backupRestored'),
        { id: toastId }
      );
    } catch (error) {
      toast.error(
        getInvokeErrorMessage(error).trim() || t('system.backupRestoreFailed'),
        { id: toastId }
      );
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackup = async () => {
    let path: string | null = null;
    let preview: BackupPreview;
    try {
      path = await pickHostFile({
        title: t('system.importBackup'),
        extensions: [BACKUP_EXTENSION],
      });
      if (!path) return;
      setBackupBusy(true);
      preview = await backupApi.inspect({ path });
    } catch (error) {
      toast.error(
        getInvokeErrorMessage(error).trim() || t('system.backupReadFailed')
      );
      return;
    } finally {
      setBackupBusy(false);
    }

    const restorePath = path;
    const toastId = toast.warning(t('system.confirmRestore'), {
      duration: 12000,
      description: t('system.confirmRestoreDetail', {
        count: preview.manifest.entry_count,
        size: formatStorageBytes(preview.manifest.total_bytes),
        date: new Date(preview.manifest.created_at).toLocaleString(),
      }),
      action: {
        label: t('system.restore'),
        onClick: () => {
          toast.dismiss(toastId);
          void restoreBackup(restorePath);
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
      cancelPendingCanvasPersist();
      const result = await configApi.clearLocalData();
      cancelPendingCanvasPersist();
      clearAllBrowserSurfaces();
      clearLocalFrontendStorage();
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
      const toastId = toast.loading(t('system.dataDirMigrating'));
      try {
        const result = await systemSettingsApi.updateDataDir(trimmed);
        setDataDir(result.current_data_dir);
        setSavedDataDir(result.current_data_dir);
        toast.success(
          result.requires_reload
            ? t('system.dataDirSavedReload')
            : t('system.dataDirSaved'),
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
        toast.error(message || t('system.dataDirSaveFailed'), { id: toastId });
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

      const toastId = toast.warning(t('system.confirmDataDirChange'), {
        duration: 8000,
        action: {
          label: t('system.confirmMigrate'),
          onClick: () => {
            toast.dismiss(toastId);
            void applyDataDirChange(trimmed);
          },
        },
        cancel: {
          label: t('common:cancel'),
          onClick: () => toast.dismiss(toastId),
        },
      });
    },
    [applyDataDirChange, savedDataDir, t]
  );

  const handlePickDataDir = useCallback(async () => {
    try {
      const selected = await pickHostDirectory({
        title: t('system.dataDirTitle'),
        value: dataDir,
      });
      if (selected && selected.trim()) {
        setDataDir(selected.trim());
        handleConfirmDataDirChange(selected.trim());
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('system.dataDirSaveFailed')
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
        <SettingsSection icon={HardDrive} title={t('system.storageTitle')}>
          <div className="settings-row settings-row--stacked">
            <div className="settings-row__stack">
              <Label className="settings-row__label">
                {t('system.dataDirTitle')}
              </Label>
              <p className="settings-row__description">
                {t('system.dataDirDescription')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <TextInput
                label={t('system.dataDirTitle')}
                isLabelHidden
                value={dataDir}
                placeholder="~/.dimo"
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
                  {t('system.applyDataDir')}
                </Button>
              ) : null}
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void handlePickDataDir()}
                disabled={dataDirBusy}
              >
                {t('system.changeDataDir')}
              </Button>
              {localDesktopHost ? (
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    const target = dataDir.trim();
                    if (!target) return;
                    void desktopApi
                      .revealInFileManager(target)
                      .catch((error) => {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : t('system.openInFolderFailed')
                        );
                      });
                  }}
                  disabled={!dataDir.trim() || dataDirBusy}
                >
                  <FolderOpen className="mr-1 h-3.5 w-3.5" />
                  {t('system.openInFolder')}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="settings-row settings-row--stacked">
            <div className="settings-row__stack">
              <Label className="settings-row__label">
                {t('system.jsonTitle')}
              </Label>
              <p className="settings-row__description">
                {t('system.jsonDescription')}
              </p>
            </div>
            <code className="select-all break-all font-mono text-xs text-foreground">
              {settingsPath}
            </code>
          </div>

          <DatabaseHealthSection />
        </SettingsSection>

        <AppUpdaterSection
          autoUpdateEnabled={draft.auto_update_enabled ?? true}
          onAutoUpdateChange={(checked) =>
            updateDraft({ auto_update_enabled: checked })
          }
        />

        <SettingsSection icon={Cpu} title={t('system.featuresTitle')}>
          <div className="settings-row">
            <div className="min-w-0">
              <Label htmlFor="system-proxy-mode">
                {t('system.proxyTitle')}
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
            <div className="settings-row settings-row--stacked">
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

          {localDesktopHost ? (
            <div className="settings-row">
              <div className="min-w-0">
                <Label htmlFor="system-acceleration-mode">
                  {t('system.renderingTitle')}
                </Label>
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
                <SelectTrigger id="system-acceleration-mode" className="!w-40">
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
          ) : null}
        </SettingsSection>

        {localDesktopHost ? (
          <SettingsSection icon={Archive} title={t('system.backupTitle')}>
            <div className="settings-row">
              <div className="min-w-0">
                <Label className="settings-row__label">
                  {t('system.backupDataLabel')}
                </Label>
                <p className="settings-row__description">
                  {t('system.backupDescription')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => void handleExportBackup()}
                  disabled={backupBusy}
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  {t('system.exportBackup')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleImportBackup()}
                  disabled={backupBusy}
                >
                  {backupBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('system.importBackup')}
                </Button>
              </div>
            </div>
            <ConversationBundlePanel />
          </SettingsSection>
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
      </div>
    </div>
  );
}
