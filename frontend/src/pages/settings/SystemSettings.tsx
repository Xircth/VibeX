import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Download,
  ExternalLink,
  Lightbulb,
  Loader2,
  PackageCheck,
  RefreshCw,
  Save,
  Tag,
  Trash2,
  Undo2,
  Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import { SoundFile, type Config } from 'shared/types';
import { TagManager } from '@/components/TagManager';
import { useUserSystem } from '@/components/ConfigProvider';
import { LocalDependencyStatusBadge } from '@/components/settings/LocalDependencyStatusBadge';
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
import { Textarea } from '@/components/ui/textarea';
import {
  configApi,
  type LocalToolStatus,
  type SystemMaintenanceStatus,
} from '@/lib/api';
import {
  getLocalDependencyStatusPresentation,
  getLocalDependencyVersionSummary,
} from '@/lib/localDependencyMaintenance';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { toPrettyCase } from '@/utils/string';

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

function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
      <div className="settings-card overflow-hidden rounded-xl border">
        {children}
      </div>
    </section>
  );
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
      toast.error(
        error instanceof Error
          ? error.message
          : '本地环境检查失败'
      );
    } finally {
      setMaintenanceLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMaintenanceStatus();
  }, [refreshMaintenanceStatus]);

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
          error instanceof Error
            ? error.message
            : '本地依赖安装失败',
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
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold">系统设置</h2>
      </div>

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

            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold">应用版本</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    当前版本：{' '}
                    {maintenanceStatus?.app.current_version ?? '检查中...'}
                    {maintenanceStatus?.app.latest_version
                      ? ` / 最新版本：${maintenanceStatus.app.latest_version}`
                      : ''}
                  </div>
                  {maintenanceStatus?.app.update_available ? (
                    <div className="mt-1 text-[11px] font-medium text-amber-600">
                      检测到新版本。请打开 Release 页面更新应用安装包。
                    </div>
                  ) : maintenanceStatus?.app.checked ? (
                    <div className="mt-1 text-[11px] text-emerald-600">
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

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">本地依赖</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    npm:{' '}
                    {maintenanceStatus?.npm.available
                      ? maintenanceStatus.npm.path
                      : maintenanceStatus?.npm.message ?? '未检查'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() =>
                      void installDependencies({
                        forceUpdate: false,
                        loadingMessage: '正在安装缺失的本地依赖...',
                        successMessage: '缺失依赖已补齐。',
                        emptyMessage: '当前没有缺失依赖。',
                      })
                    }
                    disabled={
                      dependencyInstallRunning ||
                      maintenanceLoading ||
                      maintenanceStatus?.npm.available === false
                    }
                  >
                    {dependencyInstallRunning ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-1 h-3.5 w-3.5" />
                    )}
                    安装缺失
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() =>
                      void installDependencies({
                        forceUpdate: true,
                        loadingMessage: '正在更新全部本地依赖...',
                        successMessage: '可见依赖及其隐藏依赖已全部更新。',
                        emptyMessage: '本地依赖已是最新状态。',
                      })
                    }
                    disabled={
                      dependencyInstallRunning ||
                      maintenanceLoading ||
                      maintenanceStatus?.npm.available === false
                    }
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    全部更新
                  </Button>
                </div>
              </div>

              <div className="divide-y rounded-lg border">
                {visibleMaintenanceTools.map((tool) => {
                  const presentation = getLocalDependencyStatusPresentation(tool);

                  return (
                    <div
                      key={tool.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="truncate text-xs font-medium">
                            {tool.label}
                          </div>
                          <LocalDependencyStatusBadge tool={tool} />
                        </div>
                        <div className="mt-1 break-words text-[11px] text-muted-foreground">
                          {getLocalDependencyVersionSummary(tool)}
                        </div>
                      </div>
                      <div className="shrink-0">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => void handleInstallDependencyGroup(tool)}
                          disabled={
                            dependencyInstallRunning ||
                            maintenanceLoading ||
                            maintenanceStatus?.npm.available === false ||
                            !presentation.actionLabel
                          }
                        >
                          {dependencyInstallRunning &&
                          presentation.actionLabel ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : presentation.actionLabel === '安装' ? (
                            <Download className="mr-1 h-3 w-3" />
                          ) : presentation.actionLabel ? (
                            <RefreshCw className="mr-1 h-3 w-3" />
                          ) : null}
                          {presentation.actionLabel ?? '已兼容'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!maintenanceStatus && !maintenanceLoading ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    尚未检查本地环境。
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Lightbulb}
          title="提示词优化"
          description="配置输入框提示词优化功能和使用的 OpenCode 模型。"
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="prompt-enhancement-enabled"
                className="cursor-pointer text-xs"
              >
                启用提示词优化按钮
              </Label>
              <Switch
                id="prompt-enhancement-enabled"
                className="settings-switch"
                checked={draft.prompt_enhancement_enabled ?? false}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ prompt_enhancement_enabled: checked })
                }
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              在会话输入框中显示提示词优化入口，帮助改写当前输入。
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label className="shrink-0 text-xs font-medium text-muted-foreground">
              OpenCode 模型
            </Label>
            <div className="flex items-center justify-end gap-2">
              <Select
                value={draft.prompt_enhancement_model}
                onValueChange={(value: string) =>
                  updateDraft({ prompt_enhancement_model: value })
                }
                disabled={promptEnhancementModels.length === 0}
              >
                <SelectTrigger className="!w-72">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent align="start" className="max-h-72">
                  {promptEnhancementModels.map((model) => {
                    const isFree = isFreeOpenCodeModel(model);

                    return (
                      <SelectItem
                        key={model}
                        value={model}
                        textValue={model}
                        className={
                          isFree
                            ? 'font-medium text-emerald-700 focus:text-emerald-800'
                            : undefined
                        }
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{model}</span>
                          {isFree ? (
                            <span className="shrink-0 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-emerald-700">
                              FREE
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => void refreshOpencodeModels()}
                disabled={opencodeModelsLoading}
                title="刷新模型列表"
                aria-label="刷新模型列表"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${
                    opencodeModelsLoading ? 'animate-spin' : ''
                  }`}
                />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="use-custom-pe-prompt"
                className="cursor-pointer text-xs"
              >
                使用自定义优化提示词
              </Label>
              <Switch
                id="use-custom-pe-prompt"
                className="settings-switch"
                checked={draft.prompt_enhancement_prompt != null}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    prompt_enhancement_prompt: checked
                      ? DEFAULT_PROMPT_ENHANCEMENT_PROMPT
                      : null,
                  })
                }
              />
            </div>
            <Textarea
              value={
                draft.prompt_enhancement_prompt ??
                DEFAULT_PROMPT_ENHANCEMENT_PROMPT
              }
              disabled={draft.prompt_enhancement_prompt == null}
              onChange={(event) =>
                updateDraft({
                  prompt_enhancement_prompt: event.target.value,
                })
              }
              placeholder="输入提示词优化系统提示词"
              className={`min-h-32 font-mono text-xs ${
                draft.prompt_enhancement_prompt == null
                  ? 'cursor-not-allowed opacity-50'
                  : ''
              }`}
            />
            <p className="text-[11px] text-muted-foreground">
              关闭自定义时使用内置默认提示词；开启后可直接编辑。
            </p>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bell}
          title="通知"
          description="配置声音和系统推送通知。"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="sound-enabled" className="cursor-pointer text-xs">
                声音通知
              </Label>
              <Switch
                id="sound-enabled"
                className="settings-switch"
                checked={draft.notifications.sound_enabled}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    notifications: {
                      ...draft.notifications,
                      sound_enabled: checked,
                    },
                  })
                }
              />
            </div>

            {draft.notifications.sound_enabled ? (
              <div className="flex items-center justify-between gap-4">
                <Label className="shrink-0 text-xs font-medium text-muted-foreground">
                  声音
                </Label>
                <div className="flex items-center justify-end gap-2">
                  <Select
                    value={draft.notifications.sound_file}
                    onValueChange={(value: SoundFile) =>
                      updateDraft({
                        notifications: {
                          ...draft.notifications,
                          sound_file: value,
                        },
                      })
                    }
                  >
                    <SelectTrigger className="!w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {Object.values(SoundFile).map((soundFile) => (
                        <SelectItem key={soundFile} value={soundFile}>
                          {toPrettyCase(soundFile)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => playSound(draft.notifications.sound_file)}
                  >
                    <Volume2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="push-notifications"
                className="cursor-pointer text-xs"
              >
                系统推送通知
              </Label>
              <Switch
                id="push-notifications"
                className="settings-switch"
                checked={draft.notifications.push_enabled}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    notifications: {
                      ...draft.notifications,
                      push_enabled: checked,
                    },
                  })
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Tag}
          title="标签提示词"
          description="管理可通过 `#tag_name` 插入任务输入框的复用片段。"
        >
          <TagManager />
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
        <div className="sticky bottom-0 z-10 mt-4 -mx-4 border-t bg-background/80 px-4 py-3 backdrop-blur-sm">
          <div className="mx-auto flex max-w-2xl items-center justify-between">
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
