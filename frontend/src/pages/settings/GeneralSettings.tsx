import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code2, Eye, Loader2, Terminal, Type } from 'lucide-react';
import { toast } from 'sonner';
import { EditorType, type Config } from 'shared/types';

import { EditorAvailabilityIndicator } from '@/components/EditorAvailabilityIndicator';
import { useUserSystem } from '@/components/ConfigProvider';
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
import { useEditorAvailability } from '@/hooks/useEditorAvailability';
import {
  getDefaultTerminalShell,
  TERMINAL_SHELL_OPTIONS,
} from '@/lib/terminalPreferences';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';
import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './settings-ui';

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
  const editorAvailability = useEditorAvailability(draft?.editor.editor_type);

  useEffect(() => {
    if (config && !dirty) {
      setDraft(cloneConfig(config));
    }
  }, [config, dirty]);

  const editorOptions = useMemo(
    () => [
      {
        value: EditorType.VS_CODE,
        label: 'Visual Studio Code',
        description: 'code 命令',
      },
      {
        value: EditorType.CURSOR,
        label: 'Cursor',
        description: 'cursor 命令',
      },
      {
        value: EditorType.WINDSURF,
        label: 'Windsurf',
        description: 'windsurf 命令',
      },
      {
        value: EditorType.CUSTOM,
        label: '自定义',
        description: '自定义命令',
      },
    ],
    []
  );

  const updateDraft = useCallback((patch: Partial<Config>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      setDirty(true);
      return { ...prev, ...patch };
    });
  }, []);

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

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title="常规"
        description="管理终端、外部编辑器和预览的默认行为。"
      />

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
          title="编辑器"
          description="配置从任务、文件和代码定位入口打开的外部编辑器。"
        >
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              {editorOptions.map((option) => {
                const selected = draft.editor.editor_type === option.value;
                const availability =
                  selected && option.value !== EditorType.CUSTOM
                    ? editorAvailability
                    : null;

                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`rounded-md border p-3 text-left transition ${
                      selected
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/70 bg-background hover:bg-accent'
                    }`}
                    onClick={() =>
                      updateDraft({
                        editor: {
                          ...draft.editor,
                          editor_type: option.value,
                        },
                      })
                    }
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-medium">{option.label}</span>
                      <EditorAvailabilityIndicator
                        availability={availability}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {option.description}
                    </p>
                  </button>
                );
              })}
            </div>

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
