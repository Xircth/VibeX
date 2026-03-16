/**
 * System Settings page.
 *
 * Migrated from GeneralSettings with codeg-style section UI.
 * Sections: Appearance, Interaction, Editor, Git, Pull Requests, Notifications, Tags, Security.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cloneDeep, merge, isEqual } from 'lodash';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  FolderOpen,
  Loader2,
  Volume2,
  Save,
  Sun,
  Keyboard,
  Code2,
  GitBranch,
  GitPullRequest,
  Bell,
  Tag,
  Undo2,
} from 'lucide-react';
import {
  DEFAULT_COMMIT_REMINDER_PROMPT,
  DEFAULT_PR_DESCRIPTION_PROMPT,
  EditorType,
  SoundFile,
  ThemeMode,
  type Config,
  type SendMessageShortcut,
} from 'shared/types';

import { toPrettyCase } from '@/utils/string';
import { useEditorAvailability } from '@/hooks/useEditorAvailability';
import { EditorAvailabilityIndicator } from '@/components/EditorAvailabilityIndicator';
import { useTheme } from '@/components/ThemeProvider';
import { useUserSystem } from '@/components/ConfigProvider';
import { TagManager } from '@/components/TagManager';
import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
import {
  TERMINAL_SHELL_OPTIONS,
  getDefaultTerminalShell,
  normalizeTerminalShell,
} from '@/lib/terminalPreferences';

const SEND_MESSAGE_SHORTCUT_OPTIONS: Array<{
  value: SendMessageShortcut;
  label: string;
  helper: string;
}> = [
  {
    value: 'ModifierEnter',
    label: 'Ctrl / Cmd + Enter',
    helper: '使用 Ctrl / Cmd + Enter 发送消息，Enter 仅换行。',
  },
  {
    value: 'Enter',
    label: 'Enter',
    helper: '使用 Enter 直接发送消息，Shift + Enter 换行。',
  },
];

type SystemSettingsConfig = Config & {
  default_terminal_shell?: string | null;
};

const SYSTEM_TERMINAL_SETTING_VALUE = '__system__';

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

// ─── Section wrapper ──────────────────────────────────────────

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
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground leading-5">
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

// ─── Main Component ───────────────────────────────────────────

export function SystemSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const { setTheme } = useTheme();

  const [draft, setDraft] = useState<SystemSettingsConfig | null>(() =>
    config ? cloneDeep(config as SystemSettingsConfig) : null
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(
    null
  );

  const editorAvailability = useEditorAvailability(draft?.editor.editor_type);

  const validateBranchPrefix = useCallback((prefix: string): string | null => {
    if (!prefix) return null;
    if (prefix.includes('/')) return "前缀不能包含 '/'。";
    if (prefix.startsWith('.')) return "前缀不能以 '.' 开头。";
    if (prefix.endsWith('.') || prefix.endsWith('.lock'))
      return "前缀不能以 '.' 或 '.lock' 结尾。";
    if (prefix.includes('..') || prefix.includes('@{'))
      return '包含无效序列（..、@{）。';
    if (/[ \t~^:?*[\\]/.test(prefix)) return '包含无效字符。';
    for (let i = 0; i < prefix.length; i++) {
      const code = prefix.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return '包含控制字符。';
    }
    return null;
  }, []);

  useEffect(() => {
    if (!config) return;
    if (!dirty) {
      setDraft(cloneDeep(config as SystemSettingsConfig));
    }
  }, [config, dirty]);

  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !config) return false;
    return !isEqual(draft, config);
  }, [draft, config]);

  const updateDraft = useCallback(
    (patch: Partial<SystemSettingsConfig>) => {
      setDraft((prev: SystemSettingsConfig | null) => {
        if (!prev) return prev;
        const next = merge({}, prev, patch);
        if (!isEqual(next, config)) {
          setDirty(true);
        }
        return next;
      });
    },
    [config]
  );

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const playSound = async (soundFile: SoundFile) => {
    const audio = new Audio(`/api/sounds/${soundFile}`);
    try {
      await audio.play();
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const sanitized = sanitizeDraft(draft);
      const saved = await updateAndSaveConfig(sanitized);
      if (saved) {
        setTheme(sanitized.theme);
        setDraft(cloneDeep(sanitized));
        setDirty(false);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) return;
    setDraft(cloneDeep(config as SystemSettingsConfig));
    setDirty(false);
  };

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: draft?.workspace_dir ?? '',
      title: '选择工作区目录',
      description:
        '选择一个目录。工作区将在其中的 .vibe-ultra-workspaces 子目录中创建。',
    });
    if (result) {
      updateDraft({ workspace_dir: result });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!config || !draft) {
    return (
      <div className="max-w-2xl mx-auto py-6 px-4">
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          加载配置失败。
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold">系统设置</h2>
        <p className="text-xs text-muted-foreground mt-1">
          外观、交互、编辑器、Git、通知等应用偏好配置。
        </p>
      </div>

      <div className="space-y-3">
        {/* ── Appearance ────────────────────────────────────────── */}
        <SettingsSection
          icon={Sun}
          title="外观"
          description="自定义应用程序的外观和感觉。"
        >
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              主题
            </label>
            <Select
              value={draft.theme}
              onValueChange={(value: ThemeMode) =>
                updateDraft({ theme: value })
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="选择主题" />
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

        {/* ── Interaction ───────────────────────────────────────── */}
        <SettingsSection
          icon={Keyboard}
          title="交互"
          description="配置设置页和任务输入区的核心交互行为。"
        >
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              发送快捷键
            </label>
            <Select
              value={draft.send_message_shortcut}
              onValueChange={(value: SendMessageShortcut) =>
                updateDraft({ send_message_shortcut: value })
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {SEND_MESSAGE_SHORTCUT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {
                SEND_MESSAGE_SHORTCUT_OPTIONS.find(
                  (o) => o.value === draft.send_message_shortcut
                )?.helper
              }
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              默认终端
            </label>
            <Select
              value={
                getDefaultTerminalShell(draft) || SYSTEM_TERMINAL_SETTING_VALUE
              }
              onValueChange={(value: string) =>
                updateDraft({
                  default_terminal_shell:
                    value === SYSTEM_TERMINAL_SETTING_VALUE
                      ? null
                      : normalizeTerminalShell(value),
                })
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value={SYSTEM_TERMINAL_SETTING_VALUE}>
                  系统默认
                </SelectItem>
                {TERMINAL_SHELL_OPTIONS.filter((o) => o.value).map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              为新建终端指定默认 shell。终端栏顶部下拉仍可临时覆盖当前会话的选择。
            </p>
          </div>
        </SettingsSection>

        {/* ── Editor ────────────────────────────────────────────── */}
        <SettingsSection
          icon={Code2}
          title="编辑器"
          description="配置您的代码编辑体验。"
        >
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              编辑器类型
            </label>
            <Select
              value={draft.editor.editor_type}
              onValueChange={(value: EditorType) =>
                updateDraft({
                  editor: { ...draft.editor, editor_type: value },
                })
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {Object.values(EditorType).map((editor) => (
                  <SelectItem key={editor} value={editor}>
                    {toPrettyCase(editor)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draft.editor.editor_type !== EditorType.CUSTOM && (
              <EditorAvailabilityIndicator availability={editorAvailability} />
            )}
          </div>

          {draft.editor.editor_type === EditorType.CUSTOM && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                自定义编辑器命令
              </label>
              <Input
                placeholder="例如：code、subl、vim"
                value={draft.editor.custom_command || ''}
                onChange={(e) =>
                  updateDraft({
                    editor: {
                      ...draft.editor,
                      custom_command: e.target.value || null,
                    },
                  })
                }
                className="h-8 text-xs"
              />
            </div>
          )}
        </SettingsSection>

        {/* ── Git ───────────────────────────────────────────────── */}
        <SettingsSection
          icon={GitBranch}
          title="Git"
          description="配置 git 分支命名偏好和工作区目录。"
        >
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              分支前缀
            </label>
            <Input
              placeholder="vk"
              value={draft.git_branch_prefix ?? ''}
              onChange={(e) => {
                const value = e.target.value.trim();
                updateDraft({ git_branch_prefix: value });
                setBranchPrefixError(validateBranchPrefix(value));
              }}
              aria-invalid={!!branchPrefixError}
              className={`h-8 text-xs ${branchPrefixError ? 'border-destructive' : ''}`}
            />
            {branchPrefixError && (
              <p className="text-[11px] text-destructive">
                {branchPrefixError}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              预览：{' '}
              <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
                {draft.git_branch_prefix
                  ? `${draft.git_branch_prefix}/1a2b-task-name`
                  : '1a2b-task-name'}
              </code>
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              工作区目录
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="~/"
                value={draft.workspace_dir ?? ''}
                onChange={(e) =>
                  updateDraft({ workspace_dir: e.target.value || null })
                }
                className="h-8 text-xs flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={handleBrowseWorkspaceDir}
              >
                <FolderOpen className="h-3.5 w-3.5 mr-1" />
                浏览
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              工作区将在此路径内的 .vibe-ultra-workspaces 子目录中创建。
            </p>
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
                className="text-xs cursor-pointer"
              >
                AI 提交消息生成
              </Label>
            </div>
            {draft.commit_reminder_enabled && (
              <div className="ml-5 space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="use-custom-commit-prompt"
                    checked={draft.commit_reminder_prompt != null}
                    onCheckedChange={(checked: boolean) => {
                      updateDraft({
                        commit_reminder_prompt: checked
                          ? DEFAULT_COMMIT_REMINDER_PROMPT
                          : null,
                      });
                    }}
                  />
                  <Label
                    htmlFor="use-custom-commit-prompt"
                    className="text-xs cursor-pointer"
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
                  onChange={(e) =>
                    updateDraft({ commit_reminder_prompt: e.target.value })
                  }
                  className={`min-h-20 font-mono text-xs ${
                    draft.commit_reminder_prompt == null
                      ? 'opacity-50 cursor-not-allowed'
                      : ''
                  }`}
                />
              </div>
            )}
          </div>
        </SettingsSection>

        {/* ── Pull Requests ─────────────────────────────────────── */}
        <SettingsSection
          icon={GitPullRequest}
          title="拉取请求"
          description="配置 PR 创建行为。"
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
                className="text-xs cursor-pointer"
              >
                默认自动生成 PR 描述
              </Label>
            </div>
            <p className="text-[11px] text-muted-foreground ml-5">
              启用后，AI 代理将在创建 PR 后自动更新标题和描述。
            </p>
          </div>

          <div className="space-y-2 ml-5">
            <div className="flex items-center gap-2">
              <Checkbox
                id="use-custom-pr-prompt"
                checked={draft.pr_auto_description_prompt != null}
                onCheckedChange={(checked: boolean) => {
                  updateDraft({
                    pr_auto_description_prompt: checked
                      ? DEFAULT_PR_DESCRIPTION_PROMPT
                      : null,
                  });
                }}
              />
              <Label
                htmlFor="use-custom-pr-prompt"
                className="text-xs cursor-pointer"
              >
                使用自定义提示
              </Label>
            </div>
            <Textarea
              value={
                draft.pr_auto_description_prompt ?? DEFAULT_PR_DESCRIPTION_PROMPT
              }
              disabled={draft.pr_auto_description_prompt == null}
              onChange={(e) =>
                updateDraft({ pr_auto_description_prompt: e.target.value })
              }
              className={`min-h-20 font-mono text-xs ${
                draft.pr_auto_description_prompt == null
                  ? 'opacity-50 cursor-not-allowed'
                  : ''
              }`}
            />
            <p className="text-[11px] text-muted-foreground">
              使用 {'{pr_number}'} 和 {'{pr_url}'} 作为占位符。
            </p>
          </div>
        </SettingsSection>

        {/* ── Notifications ─────────────────────────────────────── */}
        <SettingsSection
          icon={Bell}
          title="通知"
          description="控制何时以及如何接收通知。"
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
              <Label
                htmlFor="sound-enabled"
                className="text-xs cursor-pointer"
              >
                声音通知
              </Label>
            </div>
            {draft.notifications.sound_enabled && (
              <div className="ml-5 space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  声音
                </label>
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
                      {Object.values(SoundFile).map((sf) => (
                        <SelectItem key={sf} value={sf}>
                          {toPrettyCase(sf)}
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
            )}

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
                className="text-xs cursor-pointer"
              >
                推送通知
              </Label>
            </div>
          </div>
        </SettingsSection>

        {/* ── Tags ──────────────────────────────────────────────── */}
        <SettingsSection
          icon={Tag}
          title="标签"
          description="创建可使用 #tag_name 插入到任务描述中的可重用文本片段。"
        >
          <TagManager />
        </SettingsSection>

      </div>

      {/* ── Sticky Save Bar ────────────────────────────────────── */}
      {hasUnsavedChanges && (
        <div className="sticky bottom-0 z-10 mt-4 -mx-4 px-4 py-3 bg-background/80 backdrop-blur-sm border-t">
          <div className="max-w-2xl mx-auto flex items-center justify-between">
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
                <Undo2 className="h-3 w-3 mr-1" />
                放弃
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSave}
                disabled={saving || !!branchPrefixError}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Save className="h-3 w-3 mr-1" />
                )}
                保存设置
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
