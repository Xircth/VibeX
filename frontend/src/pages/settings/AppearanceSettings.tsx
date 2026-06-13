import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Save, Sun, Undo2 } from 'lucide-react';
import { ThemeMode, type Config } from 'shared/types';
import { useTheme } from '@/components/ThemeProvider';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { tauriEmit } from '@/lib/tauriApi';
import { toPrettyCase } from '@/utils/string';

export function AppearanceSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const { setTheme } = useTheme();
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
    return !!config && !!draft && draft.theme !== config.theme;
  }, [config, draft]);

  const updateTheme = useCallback((theme: ThemeMode) => {
    setDraft((previous) => (previous ? { ...previous, theme } : previous));
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await updateAndSaveConfig(draft);
      if (saved) {
        setTheme(draft.theme);
        tauriEmit('theme-changed', { theme: draft.theme });
      }
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
        <h2 className="text-base font-semibold">外观</h2>
      </div>

      <section className="settings-section space-y-3">
        <div className="flex items-center gap-2">
          <Sun className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">主题</h3>
        </div>
        <div className="settings-card overflow-hidden rounded-xl border">
          <div className="settings-row flex items-center justify-between gap-4">
            <div className="text-sm font-medium">应用主题</div>
            <Select
              value={draft.theme}
              onValueChange={(value) => updateTheme(value as ThemeMode)}
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
        </div>
      </section>

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
