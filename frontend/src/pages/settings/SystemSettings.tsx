import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Lightbulb,
  Loader2,
  Save,
  Sun,
  Tag,
  Trash2,
  Undo2,
  Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_COMMIT_REMINDER_PROMPT,
  DEFAULT_PR_DESCRIPTION_PROMPT,
  SoundFile,
  ThemeMode,
  type Config,
} from 'shared/types';
import { TagManager } from '@/components/TagManager';
import { useTheme } from '@/components/ThemeProvider';
import { useUserSystem } from '@/components/ConfigProvider';
import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { configApi } from '@/lib/api';
import { tauriEmit } from '@/lib/tauriApi';
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

const CLEAR_LOCAL_DATA_TITLE =
  '\u6e05\u9664 VibeUltra \u672c\u5730\u6570\u636e';

const CLEAR_LOCAL_DATA_DESCRIPTION =
  '\u53ea\u4f1a\u6e05\u9664 VibeUltra \u5f53\u524d\u672c\u5730\u7684\u914d\u7f6e\u3001\u6570\u636e\u5e93\u3001\u7f13\u5b58\u4e0e\u672c\u5730\u8bb0\u5f55\uff0c\u4e0d\u4f1a\u5220\u9664\u9879\u76ee\u6587\u4ef6\u6216 Git Worktree \u76ee\u5f55\u3002';

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
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </section>
  );
}

export function SystemSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const { setTheme } = useTheme();

  const [draft, setDraft] = useState<SystemSettingsConfig | null>(() =>
    config ? structuredClone(config as SystemSettingsConfig) : null
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(
    null
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [opencodeModels, setOpencodeModels] = useState<string[]>([]);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);
  const [opencodeModelsError, setOpencodeModelsError] = useState<string | null>(
    null
  );
  const [isClearingLocalData, setIsClearingLocalData] = useState(false);

  const validateBranchPrefix = useCallback((prefix: string): string | null => {
    if (!prefix) return null;
    if (prefix.includes('/')) return "前缀不能包含 '/'。";
    if (prefix.startsWith('.')) return "前缀不能以 '.' 开头。";
    if (prefix.endsWith('.') || prefix.endsWith('.lock')) {
      return "前缀不能以 '.' 或 '.lock' 结尾。";
    }
    if (prefix.includes('..') || prefix.includes('@{')) {
      return "包含无效序列 '..' 或 '@{'。";
    }
    if (/[ \t~^:?*[\\]/.test(prefix)) return '包含无效字符。';

    for (let i = 0; i < prefix.length; i += 1) {
      const code = prefix.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return '包含控制字符。';
    }

    return null;
  }, []);

  useEffect(() => {
    if (!config || dirty) {
      return;
    }

    setDraft(structuredClone(config as SystemSettingsConfig));
  }, [config, dirty]);

  useEffect(() => {
    let cancelled = false;

    const loadOpencodeModels = async () => {
      setOpencodeModelsLoading(true);
      setOpencodeModelsError(null);

      try {
        const result = await configApi.listOpencodeModels();
        if (!cancelled) {
          setOpencodeModels(result.models);
        }
      } catch (error) {
        if (!cancelled) {
          setOpencodeModelsError(
            error instanceof Error ? error.message : 'Failed to load models'
          );
        }
      } finally {
        if (!cancelled) {
          setOpencodeModelsLoading(false);
        }
      }
    };

    void loadOpencodeModels();

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

  const promptEnhancementModels = useMemo(() => {
    const models = [...opencodeModels];
    const current = draft?.prompt_enhancement_model?.trim();

    if (current && !models.includes(current)) {
      models.unshift(current);
    }

    return models;
  }, [draft?.prompt_enhancement_model, opencodeModels]);

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
        setTheme(sanitized.theme);
        tauriEmit('theme-changed', { theme: sanitized.theme });
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
    setBranchPrefixError(null);
  };

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: draft?.workspace_dir ?? '',
      title: '选择工作区目录',
      description:
        '选择一个目录，工作区会创建在该目录下的 .vibe-ultra-workspaces 子目录中。',
    });

    if (result) {
      updateDraft({ workspace_dir: result });
    }
  };

  const confirmClearLocalData = useCallback(async () => {
    setIsClearingLocalData(true);
    const toastId = toast.loading('\u6b63\u5728\u6e05\u9664\u672c\u5730\u6570\u636e...');

    try {
      const result = await configApi.clearLocalData();
      useWindowProjectsStore.getState().resetProjectWindowState();
      toast.success('\u672c\u5730\u6570\u636e\u5df2\u6e05\u9664', { id: toastId });
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
          : '\u6e05\u9664\u672c\u5730\u6570\u636e\u5931\u8d25',
        { id: toastId }
      );
    } finally {
      setIsClearingLocalData(false);
    }
  }, []);

  const handleClearLocalData = useCallback(() => {
    let toastId: string | number;
    toastId = toast.warning('\u786e\u8ba4\u6e05\u9664\u672c\u5730\u6570\u636e\uff1f', {
      duration: 8000,
      action: {
        label: '\u6e05\u9664',
        onClick: () => {
          toast.dismiss(toastId);
          void confirmClearLocalData();
        },
      },
      cancel: {
        label: '\u53d6\u6d88',
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
        <p className="mt-1 text-xs text-muted-foreground">
          配置外观、Git、PR、通知和提示词相关的系统偏好。
        </p>
      </div>

      <div className="space-y-3">
        <SettingsSection
          icon={Sun}
          title="外观"
          description="自定义应用程序的外观和感觉。"
        >
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              主题
            </Label>
            <Select
              value={draft.theme}
              onValueChange={(value: ThemeMode) =>
                updateDraft({ theme: value })
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {Object.values(ThemeMode).map((theme) => (
                  <SelectItem key={theme} value={theme}>
                    {toPrettyCase(theme)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={GitBranch}
          title="Git"
          description="配置分支前缀、工作区目录和提交提醒。"
        >
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              分支前缀
            </Label>
            <Input
              placeholder="vu"
              value={draft.git_branch_prefix ?? ''}
              onChange={(event) => {
                const value = event.target.value.trim();
                updateDraft({ git_branch_prefix: value });
                setBranchPrefixError(validateBranchPrefix(value));
              }}
              aria-invalid={!!branchPrefixError}
              className={`h-8 text-xs ${
                branchPrefixError ? 'border-destructive' : ''
              }`}
            />
            {branchPrefixError ? (
              <p className="text-[11px] text-destructive">
                {branchPrefixError}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              工作区目录
            </Label>
            <div className="flex gap-2">
              <Input
                placeholder="~/"
                value={draft.workspace_dir ?? ''}
                onChange={(event) =>
                  updateDraft({ workspace_dir: event.target.value || null })
                }
                className="h-8 flex-1 text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={handleBrowseWorkspaceDir}
              >
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                浏览
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="commit-reminder-enabled"
                checked={draft.commit_reminder_enabled ?? true}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ commit_reminder_enabled: checked })
                }
              />
              <Label
                htmlFor="commit-reminder-enabled"
                className="cursor-pointer text-xs"
              >
                启用 AI 提交消息生成
              </Label>
            </div>
            {draft.commit_reminder_enabled ? (
              <div className="ml-5 space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="use-custom-commit-prompt"
                    checked={draft.commit_reminder_prompt != null}
                    onCheckedChange={(checked: boolean) =>
                      updateDraft({
                        commit_reminder_prompt: checked
                          ? DEFAULT_COMMIT_REMINDER_PROMPT
                          : null,
                      })
                    }
                  />
                  <Label
                    htmlFor="use-custom-commit-prompt"
                    className="cursor-pointer text-xs"
                  >
                    使用自定义提交提示词
                  </Label>
                </div>
                <Textarea
                  value={
                    draft.commit_reminder_prompt ??
                    DEFAULT_COMMIT_REMINDER_PROMPT
                  }
                  disabled={draft.commit_reminder_prompt == null}
                  onChange={(event) =>
                    updateDraft({ commit_reminder_prompt: event.target.value })
                  }
                  className={`min-h-20 font-mono text-xs ${
                    draft.commit_reminder_prompt == null
                      ? 'cursor-not-allowed opacity-50'
                      : ''
                  }`}
                />
              </div>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={GitPullRequest}
          title="拉取请求"
          description="配置 PR 自动描述生成行为。"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pr-auto-description"
                checked={draft.pr_auto_description_enabled ?? false}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ pr_auto_description_enabled: checked })
                }
              />
              <Label
                htmlFor="pr-auto-description"
                className="cursor-pointer text-xs"
              >
                默认自动生成 PR 描述
              </Label>
            </div>
          </div>

          <div className="ml-5 space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="use-custom-pr-prompt"
                checked={draft.pr_auto_description_prompt != null}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    pr_auto_description_prompt: checked
                      ? DEFAULT_PR_DESCRIPTION_PROMPT
                      : null,
                  })
                }
              />
              <Label
                htmlFor="use-custom-pr-prompt"
                className="cursor-pointer text-xs"
              >
                使用自定义提示词
              </Label>
            </div>
            <Textarea
              value={
                draft.pr_auto_description_prompt ??
                DEFAULT_PR_DESCRIPTION_PROMPT
              }
              disabled={draft.pr_auto_description_prompt == null}
              onChange={(event) =>
                updateDraft({ pr_auto_description_prompt: event.target.value })
              }
              className={`min-h-20 font-mono text-xs ${
                draft.pr_auto_description_prompt == null
                  ? 'cursor-not-allowed opacity-50'
                  : ''
              }`}
            />
          </div>
        </SettingsSection>

        <SettingsSection icon={Lightbulb} title="提示词优化">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="prompt-enhancement-enabled"
                checked={draft.prompt_enhancement_enabled ?? false}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ prompt_enhancement_enabled: checked })
                }
              />
              <Label
                htmlFor="prompt-enhancement-enabled"
                className="cursor-pointer text-xs"
              >
                启用提示词优化功能
              </Label>
            </div>
            <p className="text-[11px] text-muted-foreground">
              开启后，右侧执行区输入框会显示提示词优化按钮。
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              OpenCode 模型
            </Label>
            <Select
              value={draft.prompt_enhancement_model}
              onValueChange={(value: string) =>
                updateDraft({ prompt_enhancement_model: value })
              }
              disabled={
                opencodeModelsLoading || promptEnhancementModels.length === 0
              }
            >
              <SelectTrigger className="w-80">
                <SelectValue
                  placeholder={
                    opencodeModelsLoading ? '正在读取本机模型...' : '选择模型'
                  }
                />
              </SelectTrigger>
              <SelectContent align="start">
                {promptEnhancementModels.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={draft.prompt_enhancement_model}
              onChange={(event) =>
                updateDraft({
                  prompt_enhancement_model: event.target.value,
                })
              }
              placeholder="例如：opencode/minimax-m2.5-free"
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              模型列表读取自本机 `opencode models opencode`，也可以手动填写
              `provider/model`。
            </p>
            {opencodeModelsLoading ? (
              <p className="text-[11px] text-muted-foreground">
                正在读取本机 OpenCode 模型列表...
              </p>
            ) : null}
            {opencodeModelsError ? (
              <p className="text-[11px] text-destructive">
                读取模型列表失败：{opencodeModelsError}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="use-custom-pe-prompt"
                checked={draft.prompt_enhancement_prompt != null}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    prompt_enhancement_prompt: checked
                      ? DEFAULT_PROMPT_ENHANCEMENT_PROMPT
                      : null,
                  })
                }
              />
              <Label
                htmlFor="use-custom-pe-prompt"
                className="cursor-pointer text-xs"
              >
                使用自定义优化系统提示词
              </Label>
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
              placeholder="不自定义时，会使用当前默认的优化提示词。"
              className={`min-h-32 font-mono text-xs ${
                draft.prompt_enhancement_prompt == null
                  ? 'cursor-not-allowed opacity-50'
                  : ''
              }`}
            />
            <p className="text-[11px] text-muted-foreground">
              不自定义则使用当前默认的优化提示词。
            </p>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bell}
          title="通知"
          description="控制声音和推送通知。"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="sound-enabled"
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
              <Label htmlFor="sound-enabled" className="cursor-pointer text-xs">
                声音通知
              </Label>
            </div>

            {draft.notifications.sound_enabled ? (
              <div className="ml-5 space-y-2">
                <Label className="text-xs font-medium text-muted-foreground">
                  声音
                </Label>
                <div className="flex gap-2">
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
                    <SelectTrigger className="w-40">
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

            <div className="flex items-center gap-2">
              <Checkbox
                id="push-notifications"
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
              <Label
                htmlFor="push-notifications"
                className="cursor-pointer text-xs"
              >
                推送通知
              </Label>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Tag}
          title="标签提示词"
          description="管理 `#tag_name` 插入时使用的内容。"
        >
          <TagManager />
        </SettingsSection>
        <SettingsSection
          icon={Trash2}
          title={CLEAR_LOCAL_DATA_TITLE}
          description={CLEAR_LOCAL_DATA_DESCRIPTION}
        >
          <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-4">
            <p className="text-xs leading-5 text-muted-foreground">
              {
                '\u6e05\u9664\u540e\u4f1a\u91cd\u7f6e\u7cfb\u7edf\u8bbe\u7f6e\u3001\u672c\u5730\u6570\u636e\u5e93\u3001\u7f13\u5b58\u56fe\u50cf\u3001\u672c\u5730\u7edf\u8ba1\u4e0e\u5176\u4ed6\u5e94\u7528\u79c1\u6709\u6570\u636e\u3002'
              }
            </p>
            <div className="mt-3">
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
                {'\u6e05\u9664\u672c\u5730\u6570\u636e'}
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>

      {hasUnsavedChanges ? (
        <div className="sticky bottom-0 z-10 mt-4 -mx-4 border-t bg-background/80 px-4 py-3 backdrop-blur-sm">
          <div className="mx-auto flex max-w-2xl items-center justify-between">
            <span className="text-xs text-muted-foreground">
              有未保存的更改
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
                放弃更改
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSave}
                disabled={saving || !!branchPrefixError}
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
