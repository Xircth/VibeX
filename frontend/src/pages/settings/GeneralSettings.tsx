import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bell,
  Check,
  Code2,
  Eye,
  Lightbulb,
  Loader2,
  RefreshCw,
  Terminal,
  Type,
  Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import { EditorType, SoundFile, type Config } from 'shared/types';

import { IdeIcon } from '@/components/ide/IdeIcon';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { configApi } from '@/lib/api';
import {
  getDefaultTerminalShell,
  TERMINAL_SHELL_OPTIONS,
} from '@/lib/terminalPreferences';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';
import { toPrettyCase } from '@/utils/string';
import { SettingsActionBar, SettingsSection } from './SettingsUi';

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('mac');

interface EditorOption {
  value: EditorType;
  label: string;
  hint: string;
}

const EDITOR_OPTIONS: EditorOption[] = [
  { value: EditorType.VS_CODE, label: 'Visual Studio Code', hint: 'code' },
  {
    value: EditorType.VS_CODE_INSIDERS,
    label: 'VS Code Insiders',
    hint: 'code-insiders',
  },
  { value: EditorType.CURSOR, label: 'Cursor', hint: 'cursor' },
  { value: EditorType.WINDSURF, label: 'Windsurf', hint: 'windsurf' },
  { value: EditorType.INTELLI_J, label: 'IntelliJ IDEA', hint: 'idea' },
  { value: EditorType.ZED, label: 'Zed', hint: 'zed' },
  { value: EditorType.XCODE, label: 'Xcode', hint: 'xed' },
  {
    value: EditorType.GOOGLE_ANTIGRAVITY,
    label: 'Google Antigravity',
    hint: 'antigravity',
  },
  {
    value: EditorType.FILE_MANAGER,
    label: isMac ? '访达（Finder）' : '文件资源管理器',
    hint: '系统文件管理器',
  },
  { value: EditorType.CUSTOM, label: '自定义命令', hint: '自定义命令' },
];

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

function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

export function GeneralSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? cloneConfig(config) : null
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewFontSize = useEditorSettingsStore(
    (state) => state.previewFontSize
  );
  const setPreviewFontSize = useEditorSettingsStore(
    (state) => state.setPreviewFontSize
  );

  // Availability per editor option (file manager included; custom isn't checked).
  const [editorAvailability, setEditorAvailability] = useState<
    Partial<Record<EditorType, boolean>>
  >({});

  const [opencodeModels, setOpencodeModels] = useState<string[]>([]);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);

  useEffect(() => {
    if (config && !dirty) {
      setDraft(cloneConfig(config));
    }
  }, [config, dirty]);

  useEffect(() => {
    let alive = true;
    void Promise.all(
      EDITOR_OPTIONS.filter((option) => option.value !== EditorType.CUSTOM).map(
        async (option) => {
          try {
            const result = await configApi.checkEditorAvailability(
              option.value
            );
            return [option.value, result.available] as const;
          } catch {
            return [option.value, false] as const;
          }
        }
      )
    ).then((entries) => {
      if (alive) setEditorAvailability(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, []);

  const updateDraft = useCallback((patch: Partial<Config>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      setDirty(true);
      return { ...prev, ...patch };
    });
  }, []);

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

  const playSound = async (soundFile: SoundFile) => {
    try {
      await configApi.playNotificationSound(soundFile);
    } catch (error) {
      console.error('Failed to play notification sound:', error);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    try {
      setSaving(true);
      const saved = await updateAndSaveConfig(draft);
      if (!saved) {
        throw new Error('无法保存常规设置。');
      }
      setDirty(false);
      toast.success('设置已保存', { description: '常规设置已更新。' });
    } catch (error) {
      toast.error('保存失败', {
        description:
          error instanceof Error ? error.message : '无法保存常规设置。',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!config) return;
    setDraft(cloneConfig(config));
    setDirty(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!draft) {
    return null;
  }

  const selectedEditor = EDITOR_OPTIONS.find(
    (option) => option.value === draft.editor.editor_type
  );
  const selectedAvailability =
    draft.editor.editor_type === EditorType.CUSTOM
      ? null
      : editorAvailability[draft.editor.editor_type];

  return (
    <div className="settings-content">
      <div className="settings-sections">
        <SettingsSection
          icon={Terminal}
          title="终端"
          description="选择内置终端新会话使用的默认 Shell。"
        >
          <div className="settings-row">
            <div>
              <Label>默认 Shell</Label>
              <p className="settings-row__description">
                新建终端会话时使用的命令环境。
              </p>
            </div>
            <Select
              value={getDefaultTerminalShell(draft)}
              onValueChange={(value) =>
                updateDraft({ default_terminal_shell: value })
              }
            >
              <SelectTrigger className="!w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {TERMINAL_SHELL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Code2}
          title="外部编辑器"
          description="选择从任务、文件和代码定位入口打开使用的外部编辑器或文件管理器。"
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>外部编辑器</Label>
                <p className="settings-row__description">
                  {selectedAvailability === false
                    ? '当前选择在 PATH 中未找到，可能无法打开。'
                    : '从下拉中选择编辑器，列表会标注其可用状态。'}
                </p>
              </div>
              <Select
                value={draft.editor.editor_type}
                onValueChange={(value) =>
                  updateDraft({
                    editor: {
                      ...draft.editor,
                      editor_type: value as EditorType,
                    },
                  })
                }
              >
                <SelectTrigger className="!w-64">
                  <SelectValue placeholder="选择编辑器" />
                </SelectTrigger>
                <SelectContent align="start" className="max-h-80">
                  {EDITOR_OPTIONS.map((option) => {
                    const available =
                      option.value === EditorType.CUSTOM
                        ? null
                        : editorAvailability[option.value];
                    return (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex min-w-0 items-center gap-2">
                          <IdeIcon
                            editorType={option.value}
                            className="h-4 w-4 shrink-0"
                          />
                          <span className="truncate">{option.label}</span>
                          {available === true ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                          ) : available === false ? (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {selectedEditor &&
            draft.editor.editor_type !== EditorType.CUSTOM ? (
              <p className="text-[11px] text-muted-foreground">
                命令：<code className="font-mono">{selectedEditor.hint}</code>
                {selectedAvailability === true
                  ? ' · 已就绪'
                  : selectedAvailability === false
                    ? ' · 未在 PATH 中找到'
                    : ''}
              </p>
            ) : null}

            {draft.editor.editor_type === EditorType.CUSTOM ? (
              <div className="settings-row settings-row--stacked">
                <div>
                  <Label>自定义编辑器命令</Label>
                  <p className="settings-row__description">
                    输入可在终端中执行的编辑器命令。
                  </p>
                </div>
                <Input
                  placeholder="例如 code、subl、vim"
                  value={draft.editor.custom_command || ''}
                  onChange={(event) =>
                    updateDraft({
                      editor: {
                        ...draft.editor,
                        custom_command: event.target.value || null,
                      },
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Lightbulb}
          title="提示词优化"
          description="配置输入框提示词优化功能和使用的 OpenCode 模型。"
        >
          <div className="space-y-4">
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
                              ? 'settings-status-free font-medium focus:text-[hsl(var(--success))]'
                              : undefined
                          }
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{model}</span>
                            {isFree ? (
                              <span className="settings-status-free-badge shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none">
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
          icon={Eye}
          title="预览"
          description="设置文件预览和会话文件变更摘要的显示偏好。"
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div className="flex items-center gap-2">
                <Type className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <Label>预览字体大小</Label>
                  <p className="settings-row__description">
                    当前为 {previewFontSize}px。
                  </p>
                </div>
              </div>
              <div className="settings-inline-group">
                <Input
                  type="number"
                  min={10}
                  max={24}
                  value={previewFontSize}
                  onChange={(event) =>
                    setPreviewFontSize(Number(event.target.value))
                  }
                  className="w-24"
                />
                <span className="text-xs text-muted-foreground">px</span>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <Label>`files changed` 默认折叠</Label>
                <p className="settings-row__description">
                  控制新的会话 Hook 文件变更摘要是否默认折叠。
                </p>
              </div>
              <Switch
                className="settings-switch"
                checked={draft.files_changed_default_collapsed ?? false}
                onCheckedChange={(checked) =>
                  updateDraft({ files_changed_default_collapsed: checked })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label>AI 消息默认折叠</Label>
                <p className="settings-row__description">
                  包含命令输出的 AI 最终消息默认只显示结果。
                </p>
              </div>
              <Switch
                className="settings-switch"
                checked={draft.ai_message_default_collapsed ?? false}
                onCheckedChange={(checked) =>
                  updateDraft({ ai_message_default_collapsed: checked })
                }
              />
            </div>
          </div>
        </SettingsSection>
      </div>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={handleReset}
        onSave={handleSave}
      />
    </div>
  );
}
