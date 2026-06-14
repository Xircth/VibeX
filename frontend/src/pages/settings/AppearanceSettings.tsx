import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Sun } from 'lucide-react';
import { ThemeMode, type Config } from 'shared/types';
import { useTheme } from '@/components/ThemeProvider';
import { useUserSystem } from '@/components/ConfigProvider';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { tauriEmit } from '@/lib/tauriApi';
import { toPrettyCase } from '@/utils/string';

import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './settings-ui';

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
    <div className="settings-content">
      <SettingsPageHeader
        title="外观"
        description="管理应用主题与亮暗模式。"
      />

      <div className="settings-sections">
        <SettingsSection
          icon={Sun}
          title="主题"
          description="选择浅色、深色或跟随系统的配色方案。"
        >
          <div className="settings-row">
            <div>
              <Label>应用主题</Label>
              <p className="settings-row__description">
                深色模式（Ayu Mirage）针对代码密集会话优化。
              </p>
            </div>
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
        </SettingsSection>
      </div>

      <SettingsActionBar
        dirty={hasUnsavedChanges}
        saving={saving}
        onDiscard={handleDiscard}
        onSave={handleSave}
        disabled={saving}
      />
    </div>
  );
}
