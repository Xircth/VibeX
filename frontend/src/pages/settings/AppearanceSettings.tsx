import { useCallback, useEffect, useMemo, useState } from 'react';
import { SelectableCard } from '@astryxdesign/core/SelectableCard';
import {
  AppWindow,
  Infinity as InfinityIcon,
  Languages,
  LayoutGrid,
  ListTree,
  Eye,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  Palette,
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
import { Switch } from '@/components/ui/switch';
import {
  getAutoOpenCreatedPreviews,
  setAutoOpenCreatedPreviews,
} from '@/lib/autoOpenCreatedPreviews';
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
  KANBAN_SESSION_LIST_VIEWS,
  getKanbanSessionListView,
  setKanbanSessionListView,
  type KanbanSessionListView,
} from '@/lib/kanbanSessionListView';
import {
  KANBAN_BOARD_STYLES,
  getKanbanBoardStyle,
  setKanbanBoardStyle,
  type KanbanBoardStyle,
} from '@/lib/kanbanBoardStyle';
import { AccentColorField } from './AccentColorField';
import { SettingsActionBar, SettingsSection } from './SettingsUi';
import {
  KanbanLayoutSchematic,
  WorkspaceLayoutSchematic,
} from './LayoutArrangementSchematic';

const THEME_CHOICES: {
  value: ThemeMode;
  label: string;
  scheme: 'light' | 'dark' | 'system';
  icon: typeof Sun;
}[] = [
  {
    value: ThemeMode.LIGHT,
    label: toPrettyCase(ThemeMode.LIGHT),
    scheme: 'light',
    icon: Sun,
  },
  {
    value: ThemeMode.DARK,
    label: toPrettyCase(ThemeMode.DARK),
    scheme: 'dark',
    icon: Moon,
  },
  {
    value: ThemeMode.SYSTEM,
    label: toPrettyCase(ThemeMode.SYSTEM),
    scheme: 'system',
    icon: Monitor,
  },
];

function ThemePreviewCanvas({ mode }: { mode: 'light' | 'dark' }) {
  return (
    <div className="settings-theme-preview__canvas" data-mode={mode}>
      <div className="settings-theme-preview__header">
        <span className="settings-theme-preview__bar is-wide" />
        <span className="settings-theme-preview__bar" />
      </div>
      <div className="settings-theme-preview__surface">
        <span className="settings-theme-preview__bar" />
        <span className="settings-theme-preview__bar" />
        <span className="settings-theme-preview__bar" />
      </div>
    </div>
  );
}

function ThemePreviewMock({ scheme }: { scheme: 'light' | 'dark' | 'system' }) {
  return (
    <div aria-hidden="true" className="settings-theme-preview">
      {scheme === 'system' ? (
        <div className="settings-theme-preview__split">
          <ThemePreviewCanvas mode="light" />
          <ThemePreviewCanvas mode="dark" />
        </div>
      ) : (
        <ThemePreviewCanvas mode={scheme} />
      )}
    </div>
  );
}

function ThemeChoiceCards({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="settings-theme-choices"
    >
      {THEME_CHOICES.map((choice) => {
        const isSelected = choice.value === value;
        const Icon = choice.icon;
        return (
          <SelectableCard
            key={choice.value}
            label={choice.label}
            isSelected={isSelected}
            padding={2}
            className="settings-theme-card"
            onChange={() => {
              if (!isSelected) {
                onChange(choice.value);
              }
            }}
            onClick={(event) => {
              if (!(event.target instanceof HTMLInputElement) && !isSelected) {
                onChange(choice.value);
              }
            }}
          >
            <div className="settings-theme-card__body">
              <ThemePreviewMock scheme={choice.scheme} />
              <div className="settings-theme-card__caption">
                <Icon aria-hidden="true" className="settings-theme-card__icon" />
                <span
                  className={
                    isSelected
                      ? 'settings-theme-card__label is-selected'
                      : 'settings-theme-card__label'
                  }
                >
                  {choice.label}
                </span>
              </div>
            </div>
          </SelectableCard>
        );
      })}
    </div>
  );
}

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
  const [kanbanSessionListView, setKanbanSessionListViewState] =
    useState<KanbanSessionListView>(() => getKanbanSessionListView());
  const [kanbanBoardStyle, setKanbanBoardStyleState] =
    useState<KanbanBoardStyle>(() => getKanbanBoardStyle());
  const [autoOpenCreatedPreviews, setAutoOpenCreatedPreviewsState] = useState(
    () => getAutoOpenCreatedPreviews()
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
      <div className="settings-sections">
        <SettingsSection
          icon={Sun}
          title={t('appearance.theme.title')}
          description={t('appearance.theme.description')}
        >
          <div className="settings-row settings-row--stacked">
            <div className="settings-row__stack">
              <Label>{t('appearance.theme.label')}</Label>
              <p className="settings-row__description">
                {t('appearance.theme.hint')}
              </p>
            </div>
            <ThemeChoiceCards
              ariaLabel={t('appearance.theme.label')}
              value={draft.theme}
              onChange={updateTheme}
            />
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Palette}
          title={t('appearance.accent.title')}
          description={t('appearance.accent.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.accent.label')}</Label>
            </div>
            <AccentColorField />
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
          icon={ListTree}
          title={t('appearance.kanbanSessionList.title')}
          description={t('appearance.kanbanSessionList.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.kanbanSessionList.label')}</Label>
            </div>
            <Select
              value={kanbanSessionListView}
              onValueChange={(value) => {
                const next = value as KanbanSessionListView;
                setKanbanSessionListViewState(next);
                setKanbanSessionListView(next);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {KANBAN_SESSION_LIST_VIEWS.map((view) => (
                  <SelectItem key={view} value={view}>
                    {t(`appearance.kanbanSessionList.${view}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Eye}
          title={t('appearance.autoOpenCreatedPreviews.title')}
          description={t('appearance.autoOpenCreatedPreviews.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.autoOpenCreatedPreviews.label')}</Label>
            </div>
            <Switch
              checked={autoOpenCreatedPreviews}
              onCheckedChange={(enabled) => {
                setAutoOpenCreatedPreviewsState(enabled);
                setAutoOpenCreatedPreviews(enabled);
              }}
              aria-label={t('appearance.autoOpenCreatedPreviews.label')}
            />
          </div>
        </SettingsSection>

        <SettingsSection
          icon={InfinityIcon}
          title={t('appearance.kanbanBoardStyle.title')}
          description={t('appearance.kanbanBoardStyle.description')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('appearance.kanbanBoardStyle.label')}</Label>
            </div>
            <Select
              value={kanbanBoardStyle}
              onValueChange={(value) => {
                const next = value as KanbanBoardStyle;
                setKanbanBoardStyleState(next);
                setKanbanBoardStyle(next);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {KANBAN_BOARD_STYLES.map((style) => (
                  <SelectItem key={style} value={style}>
                    {t(`appearance.kanbanBoardStyle.${style}`)}
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
