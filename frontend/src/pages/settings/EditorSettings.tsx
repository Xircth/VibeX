import { useCallback, useEffect, useState } from 'react';
import {
  Code2,
  Eye,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Loader2,
  Save,
  Terminal,
  Type,
  Undo2,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useUserSystem } from '@/components/ConfigProvider';
import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
import { useEditorAvailability } from '@/hooks/useEditorAvailability';
import { EditorAvailabilityIndicator } from '@/components/EditorAvailabilityIndicator';
import {
  DEFAULT_COMMIT_REMINDER_PROMPT,
  DEFAULT_PR_DESCRIPTION_PROMPT,
  EditorType,
  type Config,
} from 'shared/types';
import {
  normalizeTerminalShell,
  TERMINAL_SHELL_OPTIONS,
  getDefaultTerminalShell,
} from '@/lib/terminalPreferences';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';

type EditorSettingsConfig = Config & {
  default_terminal_shell?: string | null;
  files_changed_default_collapsed?: boolean;
};

const SYSTEM_TERMINAL_SETTING_VALUE = '__system__';

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

export function EditorSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const [draft, setDraft] = useState<EditorSettingsConfig | null>(() =>
    config ? structuredClone(config as EditorSettingsConfig) : null
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(
    null
  );
  const previewFontSize = useEditorSettingsStore(
    (state) => state.previewFontSize
  );
  const setPreviewFontSize = useEditorSettingsStore(
    (state) => state.setPreviewFontSize
  );
  const editorAvailability = useEditorAvailability(draft?.editor.editor_type);

  useEffect(() => {
    if (config && !dirty) {
      setDraft(structuredClone(config as EditorSettingsConfig));
    }
  }, [config, dirty]);

  const updateDraft = useCallback((patch: Partial<EditorSettingsConfig>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      setDirty(true);
      return {
        ...prev,
        ...patch,
      };
    });
  }, []);

  const validateBranchPrefix = useCallback((prefix: string): string | null => {
    if (!prefix) return null;
    if (prefix.includes('/')) return "分支前缀不能包含 '/'。";
    if (prefix.startsWith('.')) return "分支前缀不能以 '.' 开头。";
    if (prefix.endsWith('.') || prefix.endsWith('.lock')) {
      return "分支前缀不能以 '.' 或 '.lock' 结尾。";
    }
    if (prefix.includes('..') || prefix.includes('@{')) {
      return "分支前缀不能包含 '..' 或 '@{'。";
    }
    if (/[ \t~^:?*[\\]/.test(prefix)) return '分支前缀包含非法字符。';

    for (let i = 0; i < prefix.length; i += 1) {
      const code = prefix.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return '分支前缀包含控制字符。';
    }

    return null;
  }, []);

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: draft?.workspace_dir ?? '',
      title: '选择工作区目录',
      description:
        '选择用于存放工作区和 worktree 的根目录，默认会在其中创建 .vibex-workspaces 目录。',
    });

    if (result) {
      updateDraft({ workspace_dir: result });
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await updateAndSaveConfig(draft);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) return;
    setDraft(structuredClone(config as EditorSettingsConfig));
    setDirty(false);
    setBranchPrefixError(null);
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold">编辑设置</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          配置输入交互、编辑器、终端、Git 与文件预览显示效果。
        </p>
      </div>

      <div className="space-y-7">
        <SettingsSection
          icon={Terminal}
          title="终端"
          description="配置编辑工作区内置终端的默认启动方式。"
        >
          <div className="flex items-center justify-between gap-4">
            <Label className="text-xs font-medium text-muted-foreground">
              默认终端
            </Label>
            <Select
              value={
                getDefaultTerminalShell(draft) || SYSTEM_TERMINAL_SETTING_VALUE
              }
              onValueChange={(value) =>
                updateDraft({
                  default_terminal_shell:
                    value === SYSTEM_TERMINAL_SETTING_VALUE
                      ? null
                      : normalizeTerminalShell(value),
                })
              }
            >
              <SelectTrigger className="!w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value={SYSTEM_TERMINAL_SETTING_VALUE}>
                  系统默认
                </SelectItem>
                {TERMINAL_SHELL_OPTIONS.filter((opt) => opt.value).map(
                  (opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Code2}
          title="编辑器"
          description="配置外部编辑器与文件预览标签页显示偏好。"
        >
          <div className="flex items-center justify-between gap-6">
            <Label className="text-xs font-medium text-muted-foreground">
              编辑器类型
            </Label>
            <div className="flex items-center gap-3">
              <Select
                value={draft.editor.editor_type}
                onValueChange={(value: EditorType) =>
                  updateDraft({
                    editor: { ...draft.editor, editor_type: value },
                  })
                }
              >
                <SelectTrigger className="!w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {Object.values(EditorType).map((editor) => (
                    <SelectItem key={editor} value={editor}>
                      {editor}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {draft.editor.editor_type !== EditorType.CUSTOM ? (
                <EditorAvailabilityIndicator
                  availability={editorAvailability}
                />
              ) : null}
            </div>
          </div>

          {draft.editor.editor_type === EditorType.CUSTOM ? (
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                自定义编辑器命令
              </Label>
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
                className="h-8 text-xs"
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Type className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs font-medium text-muted-foreground">
                文件预览标签页字号
              </Label>
            </div>
            <div className="flex items-center justify-end gap-3">
              <Input
                type="number"
                min={10}
                max={24}
                value={previewFontSize}
                onChange={(event) =>
                  setPreviewFontSize(
                    Number(event.target.value || previewFontSize)
                  )
                }
                className="h-8 w-28 text-xs"
              />
              <span className="text-xs text-muted-foreground">px</span>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={GitBranch}
          title="Git"
          description="配置分支前缀、工作区目录和提交提醒。"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label className="text-xs font-medium text-muted-foreground">
                分支前缀
              </Label>
              {branchPrefixError ? (
                <p className="mt-1 text-[11px] text-destructive">
                  {branchPrefixError}
                </p>
              ) : null}
            </div>
            <Input
              placeholder="vu"
              value={draft.git_branch_prefix ?? ''}
              onChange={(event) => {
                const value = event.target.value.trim();
                updateDraft({ git_branch_prefix: value });
                setBranchPrefixError(validateBranchPrefix(value));
              }}
              aria-invalid={!!branchPrefixError}
              className={`h-8 w-24 text-xs ${
                branchPrefixError ? 'border-destructive' : ''
              }`}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label className="shrink-0 text-xs font-medium text-muted-foreground">
              工作区目录
            </Label>
            <div className="flex min-w-0 flex-1 justify-end gap-2">
              <Input
                placeholder="~/"
                value={draft.workspace_dir ?? ''}
                onChange={(event) =>
                  updateDraft({ workspace_dir: event.target.value || null })
                }
                className="h-8 max-w-sm text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={handleBrowseWorkspaceDir}
              >
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                浏览
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="commit-reminder-enabled"
                className="cursor-pointer text-xs font-medium text-muted-foreground"
              >
                AI 提交消息生成
              </Label>
              <Switch
                id="commit-reminder-enabled"
                className="settings-switch"
                checked={draft.commit_reminder_enabled ?? true}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ commit_reminder_enabled: checked })
                }
              />
            </div>
            {draft.commit_reminder_enabled ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <Label
                    htmlFor="use-custom-commit-prompt"
                    className="cursor-pointer text-xs font-medium text-muted-foreground"
                  >
                    自定义提交提示词
                  </Label>
                  <Switch
                    id="use-custom-commit-prompt"
                    className="settings-switch"
                    checked={draft.commit_reminder_prompt != null}
                    onCheckedChange={(checked: boolean) =>
                      updateDraft({
                        commit_reminder_prompt: checked
                          ? DEFAULT_COMMIT_REMINDER_PROMPT
                          : null,
                      })
                    }
                  />
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
                  className={`min-h-28 font-mono text-xs ${
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
          title="PR 描述"
          description="配置 PR 描述自动生成与提示词。"
        >
          <div className="flex items-center justify-between gap-4">
            <Label
              htmlFor="pr-auto-description"
              className="cursor-pointer text-xs font-medium text-muted-foreground"
            >
              默认自动生成 PR 描述
            </Label>
            <Switch
              id="pr-auto-description"
              className="settings-switch"
              checked={draft.pr_auto_description_enabled ?? false}
              onCheckedChange={(checked: boolean) =>
                updateDraft({ pr_auto_description_enabled: checked })
              }
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="use-custom-pr-prompt"
                className="cursor-pointer text-xs font-medium text-muted-foreground"
              >
                自定义 PR 提示词
              </Label>
              <Switch
                id="use-custom-pr-prompt"
                className="settings-switch"
                checked={draft.pr_auto_description_prompt != null}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    pr_auto_description_prompt: checked
                      ? DEFAULT_PR_DESCRIPTION_PROMPT
                      : null,
                  })
                }
              />
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
              className={`min-h-28 font-mono text-xs ${
                draft.pr_auto_description_prompt == null
                  ? 'cursor-not-allowed opacity-50'
                  : ''
              }`}
            />
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Eye}
          title="预览"
          description="配置编辑区文件预览和会话文件变更显示偏好。"
        >
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">
                `files changed` 默认折叠
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
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
        </SettingsSection>
      </div>

      {dirty ? (
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
        </div>
      ) : null}
    </div>
  );
}
