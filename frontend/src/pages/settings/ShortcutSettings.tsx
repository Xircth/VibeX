import { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Loader2, Save, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUserSystem } from '@/components/ConfigProvider';
import { type Config, type SendMessageShortcut } from 'shared/types';
import { IMPLEMENTED_SHORTCUTS } from '@/keyboard/appShortcuts';

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

export function ShortcutSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? structuredClone(config) : null
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config) {
      setDraft(structuredClone(config));
    }
  }, [config]);

  const hasUnsavedChanges = useMemo(() => {
    return (
      !!config &&
      !!draft &&
      draft.send_message_shortcut !== config.send_message_shortcut
    );
  }, [config, draft]);

  const selectedShortcutHelper = useMemo(
    () =>
      SEND_MESSAGE_SHORTCUT_OPTIONS.find(
        (option) => option.value === draft?.send_message_shortcut
      )?.helper ?? '',
    [draft?.send_message_shortcut]
  );

  const updateSendShortcut = useCallback((value: SendMessageShortcut) => {
    setDraft((previous) =>
      previous ? { ...previous, send_message_shortcut: value } : previous
    );
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await updateAndSaveConfig(draft);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (config) {
      setDraft(structuredClone(config));
    }
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
        <h2 className="text-base font-semibold">交互</h2>
      </div>

      <div className="space-y-3">
        <section className="settings-section space-y-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">输入</h3>
          </div>
          <div className="settings-card overflow-hidden rounded-lg border">
            <div className="settings-row flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">发送快捷键</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedShortcutHelper}
                </p>
              </div>
              <Select
                value={draft.send_message_shortcut}
                onValueChange={(value) =>
                  updateSendShortcut(value as SendMessageShortcut)
                }
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {SEND_MESSAGE_SHORTCUT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        <section className="settings-section space-y-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">快捷键</h3>
          </div>
          <div className="settings-card overflow-hidden rounded-lg border">
            {IMPLEMENTED_SHORTCUTS.map((item) => (
              <div
                key={item.id}
                className="settings-row flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    <span className="settings-meta-chip px-1.5 py-0.5 text-[10px]">
                      {item.scope}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {item.keys.map((key) => (
                    <kbd
                      key={key}
                      className="settings-kbd px-2 py-1 text-[11px] font-mono"
                    >
                      {key}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {hasUnsavedChanges ? (
        <div className="settings-action-bar sticky bottom-0 z-10 mt-4 -mx-4 px-4 py-3">
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
      ) : null}
    </div>
  );
}
