import { useCallback, useEffect, useMemo, useState } from 'react';
import { cloneDeep, merge, isEqual } from 'lodash';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { FolderOpen, Loader2, Volume2 } from 'lucide-react';
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

type GeneralSettingsConfig = Config & {
  default_terminal_shell?: string | null;
};

const SYSTEM_TERMINAL_SETTING_VALUE = '__system__';

function sanitizeGeneralSettingsDraft(
  draft: GeneralSettingsConfig
): GeneralSettingsConfig {
  return {
    ...draft,
    editor: {
      ...draft.editor,
      remote_ssh_host: null,
      remote_ssh_user: null,
    },
  };
}

export function GeneralSettings() {
  const {
    config,
    loading,
    updateAndSaveConfig, // Use this on Save
  } = useUserSystem();

  // Draft state management
  const [draft, setDraft] = useState<GeneralSettingsConfig | null>(() =>
    config ? cloneDeep(config as GeneralSettingsConfig) : null
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(
    null
  );
  const { setTheme } = useTheme();

  // Check editor availability when draft editor changes
  const editorAvailability = useEditorAvailability(draft?.editor.editor_type);

  const validateBranchPrefix = useCallback((prefix: string): string | null => {
    if (!prefix) return null; // empty allowed
    if (prefix.includes('/')) return "前缀不能包含 '/'。";
    if (prefix.startsWith('.')) return "前缀不能以 '.' 开头。";
    if (prefix.endsWith('.') || prefix.endsWith('.lock'))
      return "前缀不能以 '.' 或 '.lock' 结尾。";
    if (prefix.includes('..') || prefix.includes('@{'))
      return '包含无效序列（..、@{）。';
    if (/[ \t~^:?*[\\]/.test(prefix)) return '包含无效字符。';
    // Control chars check
    for (let i = 0; i < prefix.length; i++) {
      const code = prefix.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return '包含控制字符。';
    }
    return null;
  }, []);

  // When config loads or changes externally, update draft only if not dirty
  useEffect(() => {
    if (!config) return;
    if (!dirty) {
      setDraft(cloneDeep(config as GeneralSettingsConfig));
    }
  }, [config, dirty]);

  // Check for unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !config) return false;
    return !isEqual(draft, config);
  }, [draft, config]);

  // Generic draft update helper
  const updateDraft = useCallback(
    (patch: Partial<GeneralSettingsConfig>) => {
      setDraft((prev: GeneralSettingsConfig | null) => {
        if (!prev) return prev;
        const next = merge({}, prev, patch);
        // Mark dirty if changed
        if (!isEqual(next, config)) {
          setDirty(true);
        }
        return next;
      });
    },
    [config]
  );

  // Optional: warn on tab close/navigation with unsaved changes
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
    } catch (err) {
      console.error('Failed to play sound:', err);
    }
  };

  const handleSave = async () => {
    if (!draft) return;

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const sanitizedDraft = sanitizeGeneralSettingsDraft(draft);
      const saved = await updateAndSaveConfig(sanitizedDraft);

      if (!saved) {
        setError('保存设置失败');
        return;
      }

      setTheme(sanitizedDraft.theme);
      setDraft(cloneDeep(sanitizedDraft));
      setDirty(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError('保存设置失败');
      console.error('Error saving config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) return;
    setDraft(cloneDeep(config as GeneralSettingsConfig));
    setDirty(false);
  };

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: draft?.workspace_dir ?? '',
      title: '选择工作区目录',
      description:
        '选择一个目录。工作区将在其中的 .vibe-kanban-workspaces 子目录中创建。',
    });
    if (result) {
      updateDraft({ workspace_dir: result });
    }
  };

  const resetDisclaimer = async () => {
    if (!config) return;
    const saved = await updateAndSaveConfig({ disclaimer_acknowledged: false });
    if (!saved) {
      setError('重置免责声明失败');
    }
  };

  const resetOnboarding = async () => {
    if (!config) return;
    const saved = await updateAndSaveConfig({ onboarding_acknowledged: false });
    if (!saved) {
      setError('重置入门流程失败');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="ml-2">{'加载设置中...'}</span>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="py-8">
        <Alert variant="destructive">
          <AlertDescription>{'加载配置失败。'}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert variant="success">
          <AlertDescription className="font-medium">
            {'✓ 设置保存成功！'}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{'外观'}</CardTitle>
          <CardDescription>{'自定义应用程序的外观和感觉。'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="theme">{'主题'}</Label>
            <Select
              value={draft?.theme}
              onValueChange={(value: ThemeMode) =>
                updateDraft({ theme: value })
              }
            >
              <SelectTrigger id="theme">
                <SelectValue placeholder={'选择主题'} />
              </SelectTrigger>
              <SelectContent>
                {Object.values(ThemeMode).map((theme) => (
                  <SelectItem key={theme} value={theme}>
                    {toPrettyCase(theme)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {'选择您喜欢的配色方案。'}
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{'交互'}</CardTitle>
          <CardDescription>
            {
              '\u914d\u7f6e\u8bbe\u7f6e\u9875\u548c\u4efb\u52a1\u8f93\u5165\u533a\u7684\u6838\u5fc3交互\u884c\u4e3a\u3002'
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="send-message-shortcut">{'发送快捷键'}</Label>
            <Select
              value={draft?.send_message_shortcut}
              onValueChange={(value: SendMessageShortcut) =>
                updateDraft({ send_message_shortcut: value })
              }
            >
              <SelectTrigger id="send-message-shortcut">
                <SelectValue placeholder={'\u9009\u62e9发送快捷键'} />
              </SelectTrigger>
              <SelectContent>
                {SEND_MESSAGE_SHORTCUT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {
                SEND_MESSAGE_SHORTCUT_OPTIONS.find(
                  (option) => option.value === draft?.send_message_shortcut
                )?.helper
              }
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default-terminal-shell">{'默认终端'}</Label>
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
              <SelectTrigger id="default-terminal-shell">
                <SelectValue placeholder={'选择默认终端'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_TERMINAL_SETTING_VALUE}>
                  {'系统默认'}
                </SelectItem>
                {TERMINAL_SHELL_OPTIONS.filter((option) => option.value).map(
                  (option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {
                '为新建终端指定默认 shell。终端栏顶部下拉仍可临时覆盖当前会话的选择。'
              }
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{'编辑器'}</CardTitle>
          <CardDescription>{'配置您的代码编辑体验。'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="editor-type">{'编辑器类型'}</Label>
            <Select
              value={draft?.editor.editor_type}
              onValueChange={(value: EditorType) =>
                updateDraft({
                  editor: { ...draft!.editor, editor_type: value },
                })
              }
            >
              <SelectTrigger id="editor-type">
                <SelectValue placeholder={'选择编辑器'} />
              </SelectTrigger>
              <SelectContent>
                {Object.values(EditorType).map((editor) => (
                  <SelectItem key={editor} value={editor}>
                    {toPrettyCase(editor)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Editor availability status indicator */}
            {draft?.editor.editor_type !== EditorType.CUSTOM && (
              <EditorAvailabilityIndicator availability={editorAvailability} />
            )}

            <p className="text-sm text-muted-foreground">
              {'选择您喜欢的代码编辑器界面。'}
            </p>
          </div>

          {draft?.editor.editor_type === EditorType.CUSTOM && (
            <div className="space-y-2">
              <Label htmlFor="custom-command">{'自定义编辑器命令'}</Label>
              <Input
                id="custom-command"
                placeholder={'例如：code、subl、vim'}
                value={draft?.editor.custom_command || ''}
                onChange={(e) =>
                  updateDraft({
                    editor: {
                      ...draft!.editor,
                      custom_command: e.target.value || null,
                    },
                  })
                }
              />
              <p className="text-sm text-muted-foreground">
                {'输入启动自定义编辑器的命令。这将用于打开文件。'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{'Git'}</CardTitle>
          <CardDescription>{'配置 git 分支命名偏好'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="git-branch-prefix">{'分支前缀'}</Label>
            <Input
              id="git-branch-prefix"
              type="text"
              placeholder={'vk'}
              value={draft?.git_branch_prefix ?? ''}
              onChange={(e) => {
                const value = e.target.value.trim();
                updateDraft({ git_branch_prefix: value });
                setBranchPrefixError(validateBranchPrefix(value));
              }}
              aria-invalid={!!branchPrefixError}
              className={branchPrefixError ? 'border-destructive' : undefined}
            />
            {branchPrefixError && (
              <p className="text-sm text-destructive">{branchPrefixError}</p>
            )}
            <p className="text-sm text-muted-foreground">
              {'自动生成的分支名称的前缀。留空表示无前缀。'}{' '}
              {draft?.git_branch_prefix ? (
                <>
                  {'预览：'}{' '}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {`${draft.git_branch_prefix}/1a2b-task-name`}
                  </code>
                </>
              ) : (
                <>
                  {'预览：'}{' '}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {'1a2b-task-name'}
                  </code>
                </>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="workspace-dir">{'工作区目录'}</Label>
            <div className="flex space-x-2">
              <Input
                id="workspace-dir"
                type="text"
                placeholder={'~/'}
                value={draft?.workspace_dir ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  updateDraft({ workspace_dir: value || null });
                }}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleBrowseWorkspaceDir}
              >
                <FolderOpen className="h-4 w-4 mr-2" />
                {'浏览'}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {
                '工作区将在此路径内的 .vibe-kanban-workspaces 子目录中创建。留空以使用系统默认值。更改需要重启应用程序。'
              }
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="commit-reminder-enabled"
                checked={draft?.commit_reminder_enabled ?? true}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ commit_reminder_enabled: checked })
                }
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="commit-reminder-enabled"
                  className="cursor-pointer"
                >
                  {'AI 提交消息生成'}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {
                    '启用后，AI 代理会在提交前审查 diff 并生成结构化的提交消息。'
                  }
                </p>
              </div>
            </div>
            {draft?.commit_reminder_enabled && (
              <>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="use-custom-commit-prompt"
                    checked={draft?.commit_reminder_prompt != null}
                    onCheckedChange={(checked: boolean) => {
                      if (checked) {
                        updateDraft({
                          commit_reminder_prompt:
                            DEFAULT_COMMIT_REMINDER_PROMPT,
                        });
                      } else {
                        updateDraft({ commit_reminder_prompt: null });
                      }
                    }}
                  />
                  <Label
                    htmlFor="use-custom-commit-prompt"
                    className="cursor-pointer"
                  >
                    {'使用自定义提交提示词'}
                  </Label>
                </div>
                <textarea
                  id="commit-reminder-prompt"
                  className={`flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    draft?.commit_reminder_prompt == null
                      ? 'opacity-50 cursor-not-allowed'
                      : ''
                  }`}
                  value={
                    draft?.commit_reminder_prompt ??
                    DEFAULT_COMMIT_REMINDER_PROMPT
                  }
                  disabled={draft?.commit_reminder_prompt == null}
                  onChange={(e) =>
                    updateDraft({
                      commit_reminder_prompt: e.target.value,
                    })
                  }
                />
                <p className="text-sm text-muted-foreground">
                  {
                    '发送给 AI 代理用于生成提交消息的自定义提示词。git 状态会自动追加。代理可以运行 git diff 来检查变更。'
                  }
                </p>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{'拉取请求'}</CardTitle>
          <CardDescription>{'配置PR创建行为'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="pr-auto-description"
              checked={draft?.pr_auto_description_enabled ?? false}
              onCheckedChange={(checked: boolean) =>
                updateDraft({ pr_auto_description_enabled: checked })
              }
            />
            <div className="space-y-0.5">
              <Label htmlFor="pr-auto-description" className="cursor-pointer">
                {'默认自动生成PR描述'}
              </Label>
              <p className="text-sm text-muted-foreground">
                {'启用后，AI代理将在创建PR后自动更新标题和描述。'}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="use-custom-prompt"
              checked={draft?.pr_auto_description_prompt != null}
              onCheckedChange={(checked: boolean) => {
                if (checked) {
                  updateDraft({
                    pr_auto_description_prompt: DEFAULT_PR_DESCRIPTION_PROMPT,
                  });
                } else {
                  updateDraft({ pr_auto_description_prompt: null });
                }
              }}
            />
            <Label htmlFor="use-custom-prompt" className="cursor-pointer">
              {'使用自定义提示'}
            </Label>
          </div>
          <div className="space-y-2">
            <textarea
              id="pr-custom-prompt"
              className={`flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                draft?.pr_auto_description_prompt == null
                  ? 'opacity-50 cursor-not-allowed'
                  : ''
              }`}
              value={
                draft?.pr_auto_description_prompt ??
                DEFAULT_PR_DESCRIPTION_PROMPT
              }
              disabled={draft?.pr_auto_description_prompt == null}
              onChange={(e) =>
                updateDraft({
                  pr_auto_description_prompt: e.target.value,
                })
              }
            />
            <p className="text-sm text-muted-foreground">
              {
                '生成PR描述时AI代理使用的自定义提示。使用{pr_number}和{pr_url}作为占位符。'
              }
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{'通知'}</CardTitle>
          <CardDescription>{'控制何时以及如何接收通知。'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="sound-enabled"
              checked={draft?.notifications.sound_enabled}
              onCheckedChange={(checked: boolean) =>
                updateDraft({
                  notifications: {
                    ...draft!.notifications,
                    sound_enabled: checked,
                  },
                })
              }
            />
            <div className="space-y-0.5">
              <Label htmlFor="sound-enabled" className="cursor-pointer">
                {'声音通知'}
              </Label>
              <p className="text-sm text-muted-foreground">
                {'任务尝试完成运行时播放声音。'}
              </p>
            </div>
          </div>
          {draft?.notifications.sound_enabled && (
            <div className="ml-6 space-y-2">
              <Label htmlFor="sound-file">{'声音'}</Label>
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
                  <SelectTrigger id="sound-file" className="flex-1">
                    <SelectValue placeholder={'选择声音'} />
                  </SelectTrigger>
                  <SelectContent>
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
                  onClick={() => playSound(draft.notifications.sound_file)}
                  className="px-3"
                >
                  <Volume2 className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {'选择任务完成时播放的声音。点击音量按钮预览。'}
              </p>
            </div>
          )}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="push-notifications"
              checked={draft?.notifications.push_enabled}
              onCheckedChange={(checked: boolean) =>
                updateDraft({
                  notifications: {
                    ...draft!.notifications,
                    push_enabled: checked,
                  },
                })
              }
            />
            <div className="space-y-0.5">
              <Label htmlFor="push-notifications" className="cursor-pointer">
                {'推送通知'}
              </Label>
              <p className="text-sm text-muted-foreground">
                {'任务尝试完成运行时显示系统通知。'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{'标签'}</CardTitle>
          <CardDescription>
            {'创建可使用 @tag_name 插入到任务描述中的可重用文本片段。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TagManager />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{'安全和免责声明'}</CardTitle>
          <CardDescription>{'重置安全警告和入门流程的确认。'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{'免责声明确认'}</p>
              <p className="text-sm text-muted-foreground">
                {'重置安全免责声明。'}
              </p>
            </div>
            <Button variant="outline" onClick={resetDisclaimer}>
              {'重置'}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{'入门流程'}</p>
              <p className="text-sm text-muted-foreground">
                {'重置入门流程。'}
              </p>
            </div>
            <Button variant="outline" onClick={resetOnboarding}>
              {'重置'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Sticky Save Button */}
      <div className="sticky bottom-0 z-10 bg-background/80 backdrop-blur-sm border-t py-4">
        <div className="flex items-center justify-between">
          {hasUnsavedChanges ? (
            <span className="text-sm text-muted-foreground">
              {'• 您有未保存的更改'}
            </span>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleDiscard}
              disabled={!hasUnsavedChanges || saving}
            >
              {'放弃'}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!hasUnsavedChanges || saving || !!branchPrefixError}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {'保存设置'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
