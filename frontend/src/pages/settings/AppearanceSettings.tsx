import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Languages,
  LayoutGrid,
  Loader2,
  Maximize2,
  Sun,
  Type,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ThemeMode, type Config } from 'shared/types';
import { UI_ZOOM_LEVELS, getUiZoom, setUiZoom } from '@/lib/uiZoom';
import { MONO_FONT_OPTIONS, getMonoFontId, setMonoFont } from '@/lib/uiFont';
import { setUiLanguage } from '@/i18n';
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  getUiLanguage,
  type UiLanguage,
} from '@/lib/uiLanguage';
import { useTheme } from '@/components/ThemeProvider';
import {
  APP_ICON_STYLES,
  getAppIconStyle,
  resolveAppLogo,
  setAppIconStyle,
  type AppIconStyle,
} from '@/lib/appIcon';
import { useUserSystem } from '@/components/ConfigProvider';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { backendEmit } from '@/lib/backendTransport';
import { toPrettyCase } from '@/utils/string';

import {
  arrangementsEqual,
  setKanbanArrangement,
  setLayoutArrangement,
  useKanbanArrangement,
  useLayoutArrangement,
} from '@/lib/layoutArrangement';
import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './SettingsUi';
import {
  KanbanLayoutSchematic,
  WorkspaceLayoutSchematic,
} from './LayoutArrangementSchematic';

export function AppearanceSettings() {
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? structuredClone(config) : null
  );
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState<number>(() => getUiZoom());
  const [language, setLanguage] = useState<UiLanguage>(() => getUiLanguage());
  const [monoFont, setMonoFontState] = useState<string>(() => getMonoFontId());
  const [appIconStyle, setAppIconStyleState] = useState<AppIconStyle>(() =>
    getAppIconStyle()
  );
  const savedWorkspaceArrangement = useLayoutArrangement();
  const savedKanbanArrangement = useKanbanArrangement();
  const [workspaceArrangementDraft, setWorkspaceArrangementDraft] = useState(
    savedWorkspaceArrangement
  );
  const [kanbanArrangementDraft, setKanbanArrangementDraft] = useState(
    savedKanbanArrangement
  );

  useEffect(() => {
    if (config) {
      setDraft(structuredClone(config));
    }
  }, [config]);

  useEffect(() => {
    setWorkspaceArrangementDraft(savedWorkspaceArrangement);
  }, [savedWorkspaceArrangement]);

  useEffect(() => {
    setKanbanArrangementDraft(savedKanbanArrangement);
  }, [savedKanbanArrangement]);

  const hasUnsavedChanges = useMemo(() => {
    return (
      (!!config && !!draft && draft.theme !== config.theme) ||
      !arrangementsEqual(
        workspaceArrangementDraft,
        savedWorkspaceArrangement
      ) ||
      !arrangementsEqual(kanbanArrangementDraft, savedKanbanArrangement)
    );
  }, [
    config,
    draft,
    kanbanArrangementDraft,
    savedKanbanArrangement,
    savedWorkspaceArrangement,
    workspaceArrangementDraft,
  ]);

  const updateTheme = useCallback((theme: ThemeMode) => {
    setDraft((previous) => (previous ? { ...previous, theme } : previous));
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      // Layout arrangements apply on save (localStorage + storage-event
      // sync to the main window), not while dragging the schematic.
      setLayoutArrangement(workspaceArrangementDraft);
      setKanbanArrangement(kanbanArrangementDraft);

      const saved = await updateAndSaveConfig(draft);
      if (saved) {
        setTheme(draft.theme);
        backendEmit('theme-changed', { theme: draft.theme });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (config) {
      setDraft(structuredClone(config));
    }
    setWorkspaceArrangementDraft(savedWorkspaceArrangement);
    setKanbanArrangementDraft(savedKanbanArrangement);
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
          icon={AppWindow}
          title={t('appearance.appIcon.title')}
          description={t('appearance.appIcon.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.appIcon.label')}</Label>
              <p className="settings-row__description">
                {t('appearance.appIcon.hint')}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <img
                src={resolveAppLogo(appIconStyle, resolvedTheme)}
                alt=""
                aria-hidden="true"
                className="h-10 w-10 shrink-0 object-contain"
              />
              <Select
                value={appIconStyle}
                onValueChange={(value) => {
                  const next = value as AppIconStyle;
                  setAppIconStyleState(next);
                  setAppIconStyle(next);
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {APP_ICON_STYLES.map((style) => (
                    <SelectItem key={style} value={style}>
                      {t(`appearance.appIcon.styles.${style}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          icon={Type}
          title={t('appearance.monoFont.title')}
          description={t('appearance.monoFont.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.monoFont.label')}</Label>
              <p className="settings-row__description">
                {t('appearance.monoFont.hint')}
              </p>
            </div>
            <Select
              value={monoFont}
              onValueChange={(value) => {
                setMonoFontState(value);
                setMonoFont(value);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {MONO_FONT_OPTIONS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    <span style={{ fontFamily: option.stack }}>
                      {option.label}
                    </span>
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

        <SettingsSection
          icon={LayoutGrid}
          title={t('appearance.layout.title')}
          description={t('appearance.layout.description')}
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
              <div>
                <Label>{t('appearance.layout.workspaceLabel')}</Label>
                <p className="settings-row__description">
                  {t('appearance.layout.dragHint')}
                </p>
              </div>
              <WorkspaceLayoutSchematic
                value={workspaceArrangementDraft}
                onChange={setWorkspaceArrangementDraft}
              />
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <Label>{t('appearance.layout.kanbanLabel')}</Label>
                <p className="settings-row__description">
                  {t('appearance.layout.kanbanHint')}
                </p>
              </div>
              <KanbanLayoutSchematic
                value={kanbanArrangementDraft}
                onChange={setKanbanArrangementDraft}
              />
            </div>

            <p className="settings-row__description">
              {t('appearance.layout.hint')}
            </p>
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
