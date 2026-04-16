import { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Code2, Type, Save, Undo2, Loader2, Eye } from 'lucide-react';
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
import { useUserSystem } from '@/components/ConfigProvider';
import { useEditorAvailability } from '@/hooks/useEditorAvailability';
import { EditorAvailabilityIndicator } from '@/components/EditorAvailabilityIndicator';
import {
  EditorType,
  type Config,
  type SendMessageShortcut,
} from 'shared/types';
import {
  normalizeTerminalShell,
  TERMINAL_SHELL_OPTIONS,
  getDefaultTerminalShell,
} from '@/lib/terminalPreferences';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';

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
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground leading-5">{description}</p>
      )}
      {children}
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

  const selectedShortcutHelper = useMemo(
    () =>
      SEND_MESSAGE_SHORTCUT_OPTIONS.find(
        (option) => option.value === draft?.send_message_shortcut
      )?.helper ?? '',
    [draft?.send_message_shortcut]
  );

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
    <div className="max-w-2xl mx-auto py-6 px-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold">编辑设置</h2>
        <p className="text-xs text-muted-foreground mt-1">
          配置输入交互、编辑器类型以及文件预览标签页显示效果。
        </p>
      </div>

      <div className="space-y-3">
        <SettingsSection
          icon={Keyboard}
          title="交互"
          description="配置消息输入和终端相关的交互行为。"
        >
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              发送快捷键
            </Label>
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
              {selectedShortcutHelper}
            </p>
          </div>

          <div className="space-y-2">
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
              <SelectTrigger className="w-56">
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
          description="配置外部编辑器与文件预览标签页的显示偏好。"
        >
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              编辑器类型
            </Label>
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
                    {editor}
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
              <Label className="text-xs font-medium text-muted-foreground">
                自定义编辑器命令
              </Label>
              <Input
                placeholder="例如：code、subl、vim"
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
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Type className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs font-medium text-muted-foreground">
                文件预览标签页字号
              </Label>
            </div>
            <div className="flex items-center gap-3">
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
          icon={Eye}
          title="表现"
          description="配置编辑相关预览区域的默认展示方式。"
        >
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">
                `files changed` 默认折叠
              </div>
              <p className="text-xs text-muted-foreground leading-5">
                控制右侧执行器中 Hook 结束后 `files changed` 预览是否默认收起。
              </p>
            </div>
            <Switch
              checked={draft.files_changed_default_collapsed ?? false}
              onCheckedChange={(checked) =>
                updateDraft({ files_changed_default_collapsed: checked })
              }
            />
          </div>
        </SettingsSection>
      </div>

      {dirty && (
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
                放弃
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
        </div>
      )}
    </div>
  );
}
