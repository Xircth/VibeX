import { useCallback, useEffect, useMemo, useState } from 'react';
import { Languages, Loader2, Maximize2, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ThemeMode, type Config } from 'shared/types';
import { UI_ZOOM_LEVELS, getUiZoom, setUiZoom } from '@/lib/uiZoom';
import { setUiLanguage } from '@/i18n';
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  getUiLanguage,
  type UiLanguage,
} from '@/lib/uiLanguage';
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
} from './SettingsUi';

export function AppearanceSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const { setTheme } = useTheme();
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? structuredClone(config) : null
  );
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState<number>(() => getUiZoom());
  const [language, setLanguage] = useState<UiLanguage>(() => getUiLanguage());

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
        title={t('appearance.title')}
        description={t('appearance.description')}
      />

      <div className="settings-sections">
        <SettingsSection
          icon={Sun}
          title={t('appearance.theme.title')}
          description={t('appearance.theme.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.theme.label')}</Label>
              <p className="settings-row__description">
                {t('appearance.theme.hint')}
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

        <SettingsSection
          icon={Maximize2}
          title={t('appearance.zoom.title')}
          description={t('appearance.zoom.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.zoom.label')}</Label>
              <p className="settings-row__description">
                {t('appearance.zoom.hint')}
              </p>
            </div>
            <Select
              value={String(zoom)}
              onValueChange={(value) => {
                const next = Number(value);
                setZoom(next);
                setUiZoom(next);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {UI_ZOOM_LEVELS.map((level) => (
                  <SelectItem key={level} value={String(level)}>
                    {Math.round(level * 100)}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Languages}
          title={t('appearance.language.title')}
          description={t('appearance.language.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.language.label')}</Label>
              <p className="settings-row__description">
                {t('appearance.language.hint')}
              </p>
            </div>
            <Select
              value={language}
              onValueChange={(value) => {
                const next = value as UiLanguage;
                setLanguage(next);
                setUiLanguage(next);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {SUPPORTED_LANGUAGES.map((lng) => (
                  <SelectItem key={lng} value={lng}>
                    {LANGUAGE_LABELS[lng]}
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
