import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Bell,
  Download,
  ExternalLink,
  Gauge,
  Lightbulb,
  Loader2,
  Network,
  PackageCheck,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
  Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import { SoundFile, type Config } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { LocalDependencyStatusBadge } from '@/components/settings/LocalDependencyStatusBadge';
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
import { Textarea } from '@/components/ui/textarea';
import {
  backupApi,
  configApi,
  systemSettingsApi,
  type BackupPreview,
  type LocalToolStatus,
  type SystemProxySettings,
  type SystemRenderingSettings,
  type SystemMaintenanceStatus,
} from '@/lib/api';
import {
  getLocalDependencyStatusPresentation,
  getLocalDependencyVersionSummary,
} from '@/lib/localDependencyMaintenance';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { toPrettyCase } from '@/utils/string';

import { SettingsSection } from './settings-ui';

type SystemSettingsConfig = Config;

const DEFAULT_PROMPT_ENHANCEMENT_PROMPT = `You are PromptEnhance (PE).

Your job is to rewrite the user's draft prompt into a clearer, tighter, more actionable prompt.

Rules:
1. Be fast: do not explain your reasoning, just produce the optimized prompt.
2. Be accurate: use the recent conversation context only when it materially improves the prompt.
3. Optimize the prompt itself, not the conversation summary.
4. Do not echo or expose session context unless the user's prompt is clearly ambiguous without it.
5. Do not add sections like "related context" unless absolutely necessary.
6. Follow basic prompt design principles: clearly state the task, goal, constraints, and any helpful decomposition.
7. Avoid bloated prompt frameworks, unnecessary ceremony, and redundant wording.
8. Keep the user's original intent unchanged.
9. Output JSON only, with exactly one top-level field named EnhancedPrompt.
10. Do not return Markdown fences, commentary, or any extra fields.

Output shape:
{"EnhancedPrompt":"..."}`;

const FALLBACK_OPENCODE_MODELS = [
  'opencode/claude-opus-4-7',
  'opencode/claude-opus-4-6',
  'opencode/claude-opus-4-5',
  'opencode/claude-opus-4-1',
  'opencode/claude-sonnet-4-6',
  'opencode/claude-sonnet-4-5',
  'opencode/claude-sonnet-4',
  'opencode/claude-haiku-4-5',
  'opencode/gemini-3.1-pro',
  'opencode/gemini-3-flash',
  'opencode/gpt-5.5',
  'opencode/gpt-5.5-pro',
  'opencode/gpt-5.4',
  'opencode/gpt-5.4-pro',
  'opencode/gpt-5.4-mini',
  'opencode/gpt-5.4-nano',
  'opencode/gpt-5.3-codex-spark',
  'opencode/gpt-5.3-codex',
  'opencode/gpt-5.2',
  'opencode/gpt-5.2-codex',
  'opencode/gpt-5.1',
  'opencode/gpt-5.1-codex-max',
  'opencode/gpt-5.1-codex',
  'opencode/gpt-5.1-codex-mini',
  'opencode/gpt-5',
  'opencode/gpt-5-codex',
  'opencode/gpt-5-nano',
  'opencode/glm-5.1',
  'opencode/glm-5',
  'opencode/minimax-m2.7',
  'opencode/minimax-m2.5',
  'opencode/kimi-k2.6',
  'opencode/kimi-k2.5',
  'opencode/qwen3.6-plus',
  'opencode/qwen3.5-plus',
  'opencode/big-pickle',
  'opencode/minimax-m2.5-free',
  'opencode/hy3-preview-free',
  'opencode/ling-2.6-flash-free',
  'opencode/trinity-large-preview-free',
  'opencode/nemotron-3-super-free',
] as const;

function isFreeOpenCodeModel(model: string): boolean {
  return model.toLowerCase().includes('-free');
}

const CLEAR_LOCAL_DATA_TITLE = '清除 VibeX 本地数据';
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
  const { config, loading, updateAndSaveConfig } = useUserSystem();

  const [draft, setDraft] = useState<SystemSettingsConfig | null>(() =>
    config ? structuredClone(config as SystemSettingsConfig) : null
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [opencodeModels, setOpencodeModels] = useState<string[]>([]);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);
  const [isClearingLocalData, setIsClearingLocalData] = useState(false);
  const [maintenanceStatus, setMaintenanceStatus] =
    useState<SystemMaintenanceStatus | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [dependencyInstallRunning, setDependencyInstallRunning] =
    useState(false);
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
  const [renderingDraft, setRenderingDraft] =
    useState<SystemRenderingSettings>(DEFAULT_RENDERING_SETTINGS);
  const [renderingLoading, setRenderingLoading] = useState(true);
  const [renderingSaving, setRenderingSaving] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [restorePath, setRestorePath] = useState('');
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
    null
  );
  const [backupPreviewPath, setBackupPreviewPath] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  useEffect(() => {
    if (!config || dirty) {
      return;
    }

    setDraft(structuredClone(config as SystemSettingsConfig));
  }, [config, dirty]);

  const refreshOpencodeModels = useCallback(async () => {
    setOpencodeModelsLoading(true);

    try {
      const result = await configApi.listOpencodeModels();
      setOpencodeModels(result.models);
      toast.success('模型列表已刷新');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '读取模型列表失败，请稍后重试'
      );
    } finally {
      setOpencodeModelsLoading(false);
    }
  }, []);

  const refreshMaintenanceStatus = useCallback(async () => {
    setMaintenanceLoading(true);
    try {
      const status = await configApi.getSystemMaintenanceStatus();
      setMaintenanceStatus(status);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '本地环境检查失败');
    } finally {
      setMaintenanceLoading(false);
    }
  }, []);

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
      toast.error(error instanceof Error ? error.message : '系统设置读取失败');
    } finally {
      setProxyLoading(false);
      setRenderingLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSystemSettings();
  }, [refreshSystemSettings]);

  const installDependencies = useCallback(
    async ({
      forceUpdate,
      toolIds,
      loadingMessage,
      successMessage,
      emptyMessage,
    }: {
      forceUpdate: boolean;
      toolIds?: string[];
      loadingMessage: string;
      successMessage: string;
      emptyMessage: string;
    }) => {
      setDependencyInstallRunning(true);
      const toastId = toast.loading(loadingMessage);

      try {
        const result = await configApi.installSystemDependencies(
          forceUpdate,
          toolIds
        );
        setMaintenanceStatus(result.status);
        const count = result.installed_or_updated.length;
        toast.success(count > 0 ? successMessage : emptyMessage, {
          id: toastId,
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : '本地依赖安装失败',
          { id: toastId }
        );
      } finally {
        setDependencyInstallRunning(false);
      }
    },
    []
  );

  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !config) {
      return false;
    }

    return !deepEqual(draft, config);
  }, [config, draft]);

  const promptEnhancementModels = useMemo(() => {
    const models = [...opencodeModels, ...FALLBACK_OPENCODE_MODELS];
    const current = draft?.prompt_enhancement_model?.trim();
    const uniqueModels: string[] = [];

    for (const model of models) {
      if (model && !uniqueModels.includes(model)) {
        uniqueModels.push(model);
      }
    }

    if (current && !uniqueModels.includes(current)) {
      uniqueModels.push(current);
    }

    return uniqueModels.sort((a, b) => {
      const aIsFree = isFreeOpenCodeModel(a);
      const bIsFree = isFreeOpenCodeModel(b);

      if (aIsFree !== bIsFree) {
        return aIsFree ? -1 : 1;
      }

      return a.localeCompare(b);
    });
  }, [draft?.prompt_enhancement_model, opencodeModels]);

  const visibleMaintenanceTools = useMemo(
    () => (maintenanceStatus?.tools ?? []).filter((tool) => tool.user_visible),
    [maintenanceStatus?.tools]
  );

  const proxyDirty = useMemo(
    () => !deepEqual(proxyDraft, proxySettings),
    [proxyDraft, proxySettings]
  );

  const renderingDirty = useMemo(
    () => !deepEqual(renderingDraft, renderingSettings),
    [renderingDraft, renderingSettings]
  );

  const handleInstallDependencyGroup = useCallback(
    async (tool: LocalToolStatus) => {
      await installDependencies({
        forceUpdate: false,
        toolIds: [tool.id],
        loadingMessage: `正在处理 ${tool.label}...`,
        successMessage: `${tool.label} 及隐藏依赖已更新。`,
        emptyMessage: `${tool.label} 当前无需处理。`,
      });
    },
    [installDependencies]
  );

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

  const playSound = async (soundFile: SoundFile) => {
    try {
      await configApi.playNotificationSound(soundFile);
    } catch (error) {
      console.error('Failed to play notification sound:', error);
    }
  };

  const handleSaveProxy = async () => {
    setProxySaving(true);
    try {
      const saved = await systemSettingsApi.updateProxy(proxyDraft);
      setProxySettings(saved);
      setProxyDraft(saved);
      toast.success('网络代理设置已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '网络代理设置保存失败');
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
      toast.success('渲染设置已保存，重启应用后完全生效');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '渲染设置保存失败');
    } finally {
      setRenderingSaving(false);
    }
  };

  const handleCreateBackup = async () => {
    const path = backupPath.trim();
    if (!path) {
      toast.error('请填写备份导出路径');
      return;
    }

    setBackupBusy(true);
    const toastId = toast.loading('正在导出 VibeX 备份...');
    try {
      const preview = await backupApi.create({ path });
      setBackupPreview(preview);
      setBackupPreviewPath(path);
      toast.success('备份已导出', { id: toastId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份导出失败', {
        id: toastId,
      });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleInspectBackup = async () => {
    const path = restorePath.trim();
    if (!path) {
      toast.error('请填写备份文件路径');
      return;
    }

    setRestoreBusy(true);
    try {
      const preview = await backupApi.inspect({ path, passphrase: null });
      setBackupPreview(preview);
      setBackupPreviewPath(path);
      toast.success('备份预览已读取');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份预览失败');
    } finally {
      setRestoreBusy(false);
    }
  };

  const restoreInspectedBackup = async () => {
    const path = restorePath.trim();
    if (!path || !backupPreview || backupPreviewPath !== path) {
      toast.error('请先预览要恢复的备份');
      return;
    }

    setRestoreBusy(true);
    const toastId = toast.loading('正在恢复 VibeX 备份...');
    try {
      const result = await backupApi.restoreStage({
        path,
        passphrase: null,
        confirmed: true,
      });
      setBackupPreview(result.preview);
      setBackupPreviewPath(path);
      toast.success(
        result.requires_reload
          ? '备份已恢复，建议重启应用'
          : '备份已恢复',
        { id: toastId }
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份恢复失败', {
        id: toastId,
      });
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
      toast.error('请先预览要恢复的备份');
      return;
    }

    const toastId = toast.warning('确认从备份恢复 VibeX 数据？', {
      duration: 8000,
      action: {
        label: '恢复',
        onClick: () => {
          toast.dismiss(toastId);
          void restoreInspectedBackup();
        },
      },
      cancel: {
        label: '取消',
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
    const toastId = toast.loading('正在清除本地数据...');

    try {
      const result = await configApi.clearLocalData();
      useWindowProjectsStore.getState().resetProjectWindowState();
      toast.success('本地数据已清除', { id: toastId });
      if (
        result.requires_reload &&
        !window.location.pathname.startsWith('/settings')
      ) {
        window.setTimeout(() => window.location.reload(), 700);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清除本地数据失败', {
        id: toastId,
      });
    } finally {
      setIsClearingLocalData(false);
    }
  }, []);

  const handleClearLocalData = useCallback(() => {
    const toastId = toast.warning('确认清除本地数据？', {
      duration: 8000,
      action: {
        label: '清除',
        onClick: () => {
          toast.dismiss(toastId);
          void confirmClearLocalData();
        },
      },
      cancel: {
        label: '取消',
        onClick: () => toast.dismiss(toastId),
      },
    });
  }, [confirmClearLocalData]);

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
          icon={PackageCheck}
          title="本地环境"
          description="检查应用更新，并维护代理运行所需的本地依赖。"
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="auto-update-enabled"
                  className="cursor-pointer text-xs"
                >
                  自动检查应用更新
                </Label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  VibeX 启动时检查当前远程仓库是否有新版本。
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
                  自动维护本地依赖
                </Label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  启动时检查并按需安装或更新受支持的本地依赖。
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

            <div className="settings-inline-group p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">应用版本</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    当前版本：{' '}
                    {maintenanceStatus?.app.current_version ?? '检查中...'}
                    {maintenanceStatus?.app.latest_version
                      ? ` / 最新版本：${maintenanceStatus.app.latest_version}`
                      : ''}
                  </div>
                  {maintenanceStatus?.app.update_available ? (
                    <div className="settings-status-warning mt-1 text-[11px] font-medium">
                      检测到新版本。请打开 Release 页面更新应用安装包。
                    </div>
                  ) : maintenanceStatus?.app.checked ? (
                    <div className="settings-status-success mt-1 text-[11px]">
                      应用已是最新版本。
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
                    检查
                  </Button>
                </div>
              </div>
            </div>

          </div>
        </SettingsSection>

        <SettingsSection
          icon={Network}
          title="网络代理"
          description="配置 VibeX 后端网络请求和新启动进程可继承的代理地址。"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="system-proxy-enabled" className="text-xs">
                  启用代理
                </Label>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  保存前会校验代理地址格式。
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
                代理地址
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
                  保存
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                支持 HTTP、HTTPS 和 SOCKS 代理；已运行的代理进程可能需要重启后继承。
              </p>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Gauge}
          title="渲染加速"
          description="控制 WebView 渲染策略；部分平台需要重启应用后完全生效。"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-xs">加速模式</Label>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Windows 上可在 GPU 驱动异常时切换为禁用 GPU。
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
                  <SelectItem value="auto">自动</SelectItem>
                  <SelectItem value="force_gpu">强制 GPU</SelectItem>
                  <SelectItem value="disable_gpu">禁用 GPU</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void handleSaveRendering()}
                disabled={renderingLoading || renderingSaving || !renderingDirty}
              >
                {renderingSaving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                保存
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Archive}
          title="备份与恢复"
          description="导出一份可移动的 VibeX 数据备份，或在预览后从备份恢复。"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-xs font-semibold">导出备份</div>
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
                  导出
                </Button>
              </div>
              <Input
                type="password"
                value=""
                placeholder="加密口令：当前构建仅支持未加密备份"
                disabled
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold">恢复备份</div>
              <div className="flex gap-2">
                <Input
                  value={restorePath}
                  placeholder="选择或粘贴 .vibexbak 文件路径"
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
                  预览
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
                  恢复
                </Button>
              </div>
              <Input
                type="password"
                value=""
                placeholder="解密口令：当前构建仅支持未加密备份"
                disabled
              />
            </div>

            {backupPreview ? (
              <div className="settings-inline-group p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold">备份预览</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {backupPreviewPath}
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-muted-foreground">
                    <div>{backupPreview.manifest.entry_count} 个文件</div>
                    <div>{formatBytes(backupPreview.manifest.total_bytes)}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                  <div>格式：{backupPreview.manifest.format}</div>
                  <div>版本：{backupPreview.manifest.version}</div>
                  <div>应用：{backupPreview.manifest.app_version}</div>
                  <div>
                    创建：{new Date(backupPreview.manifest.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="mt-3 max-h-32 overflow-y-auto rounded-md border border-border/70">
                  {backupPreview.entries.slice(0, 8).map((entry) => (
                    <div
                      key={entry.path}
                      className="flex items-center justify-between gap-3 px-2 py-1.5 text-[11px]"
                    >
                      <span className="min-w-0 truncate">{entry.path}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatBytes(entry.size_bytes)}
                      </span>
                    </div>
                  ))}
                  {backupPreview.entries.length > 8 ? (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      还有 {backupPreview.entries.length - 8} 个条目未显示
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection icon={Trash2} title={CLEAR_LOCAL_DATA_TITLE}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">清除本机配置和缓存</span>
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
              清除
            </Button>
          </div>
        </SettingsSection>
      </div>

      {hasUnsavedChanges ? (
        <div className="settings-action-bar sticky bottom-0 z-10 mt-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              设置已修改，保存后生效。
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
                取消
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
                保存设置
              </Button>
            </div>
          </div>
          {saveError ? (
            <p className="mx-auto mt-2 max-w-2xl text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
