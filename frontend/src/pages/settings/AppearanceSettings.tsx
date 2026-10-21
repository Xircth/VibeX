import { useCallback, useEffect, useRef, useState } from 'react';
import { SelectableCard } from '@astryxdesign/core/SelectableCard';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  Eye,
  Infinity as InfinityIcon,
  LayoutGrid,
  Loader2,
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
import { useUserSystem } from '@/components/ConfigProvider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import {
  getSettingsNavFloat,
  setSettingsNavFloat,
} from '@/lib/settingsNavFloat';
import { DEFAULT_COLLAPSE_PREFERENCES } from '@/lib/conversationCollapsePreferences';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';
import { type MarkdownPreviewMode } from '@/utils/markdownPreviewMode';
import { AccentColorField } from './AccentColorField';
import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';
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
                <Icon
                  aria-hidden="true"
                  className="settings-theme-card__icon"
                />
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
  const { setTheme } = useTheme();
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? structuredClone(config) : null
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [zoom, setZoom] = useState<number>(() => getUiZoom());
  const [language, setLanguage] = useState<UiLanguage>(() => getUiLanguage());
  const [monoFont, setMonoFontState] = useState<string>(() => getMonoFontId());
  const [kanbanSessionListView, setKanbanSessionListViewState] =
    useState<KanbanSessionListView>(() => getKanbanSessionListView());
  const [kanbanBoardStyle, setKanbanBoardStyleState] =
    useState<KanbanBoardStyle>(() => getKanbanBoardStyle());
  const [settingsNavFloat, setSettingsNavFloatState] = useState<boolean>(() =>
    getSettingsNavFloat()
  );
  const workspaceArrangement = useLayoutArrangement();
  const kanbanArrangement = useKanbanArrangement();
  const [layoutPage, setLayoutPage] = useState<'workspace' | 'kanban'>(
    'workspace'
  );
  const previewFontSize = useEditorSettingsStore(
    (state) => state.previewFontSize
  );
  const setPreviewFontSize = useEditorSettingsStore(
    (state) => state.setPreviewFontSize
  );
  const markdownPreviewMode = useEditorSettingsStore(
    (state) => state.markdownPreviewMode
  );
  const setMarkdownPreviewMode = useEditorSettingsStore(
    (state) => state.setMarkdownPreviewMode
  );

  const { writeNow, holding } = useLiveSettingsCommit(async (next: Config) => {
    await updateAndSaveConfig(next);
  });

  const appliedConfig = useRef(config);
  useEffect(() => {
    if (!config || holding) return;
    if (config === appliedConfig.current) return;
    appliedConfig.current = config;
    const next = structuredClone(config);
    draftRef.current = next;
    setDraft(next);
  }, [config, holding]);

  const updateDraft = useCallback(
    (patch: Partial<Config>) => {
      const previous = draftRef.current;
      if (!previous) return;
      const next = { ...previous, ...patch };
      draftRef.current = next;
      setDraft(next);
      writeNow(next);
    },
    [writeNow]
  );

  const updateTheme = useCallback(
    (theme: ThemeMode) => {
      updateDraft({ theme });
      setTheme(theme);
      backendEmit('theme-changed', { theme });
    },
    [setTheme, updateDraft]
  );

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
          title={t('appearance.basics.title')}
          description={t('appearance.basics.description')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>{t('appearance.accent.label')}</Label>
              </div>
              <AccentColorField />
            </div>

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
                <SelectTrigger
                  className="w-56"
                  aria-label={t('appearance.zoom.label')}
                >
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
                <SelectTrigger
                  className="w-56"
                  aria-label={t('appearance.monoFont.label')}
                >
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
                <SelectTrigger
                  className="w-56"
                  aria-label={t('appearance.language.label')}
                >
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

            <div className="settings-row">
              <div>
                <Label htmlFor="settings-nav-float" className="cursor-pointer">
                  {t('appearance.navFloat.label')}
                </Label>
                <p className="settings-row__description">
                  {t('appearance.navFloat.hint')}
                </p>
              </div>
              <Switch
                id="settings-nav-float"
                className="settings-switch"
                checked={settingsNavFloat}
                onCheckedChange={(checked: boolean) => {
                  setSettingsNavFloatState(checked);
                  setSettingsNavFloat(checked);
                }}
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={InfinityIcon}
          title={t('appearance.kanbanBoardStyle.title')}
          description={t('appearance.kanbanBoardStyle.description')}
        >
          <div className="space-y-4">
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
                <SelectTrigger
                  className="w-56"
                  aria-label={t('appearance.kanbanSessionList.label')}
                >
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
                <SelectTrigger
                  className="w-56"
                  aria-label={t('appearance.kanbanBoardStyle.label')}
                >
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
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Eye}
          title={t('general.previewTitle')}
          description={t('general.previewDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div className="flex items-center gap-2">
                <Type className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <Label>{t('general.previewFontSize')}</Label>
                  <p className="settings-row__description">
                    {t('general.currentFontSize', { size: previewFontSize })}
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
                <span className="text-sm text-muted-foreground">px</span>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <Label htmlFor="markdown-preview-mode">
                  {t('general.markdownPreviewMode')}
                </Label>
              </div>
              <Select
                value={markdownPreviewMode}
                onValueChange={(value: MarkdownPreviewMode) =>
                  setMarkdownPreviewMode(value)
                }
              >
                <SelectTrigger
                  id="markdown-preview-mode"
                  className="!w-56"
                  aria-label={t('general.markdownPreviewMode')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="preview">
                    {t('general.markdownPreviewModePreview')}
                  </SelectItem>
                  <SelectItem value="source">
                    {t('general.markdownPreviewModeSource')}
                  </SelectItem>
                  <SelectItem value="richtext">
                    {t('general.markdownPreviewModeRichtext')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.filesChangedCollapsed')}</Label>
                <p className="settings-row__description">
                  {t('general.filesChangedCollapsedHint')}
                </p>
              </div>
              <Switch
                className="settings-switch"
                aria-label={t('general.filesChangedCollapsed')}
                checked={
                  draft.files_changed_default_collapsed ??
                  DEFAULT_COLLAPSE_PREFERENCES.filesChangedCollapsed
                }
                onCheckedChange={(checked) =>
                  updateDraft({ files_changed_default_collapsed: checked })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.aiMessageCollapsed')}</Label>
                <p className="settings-row__description">
                  {t('general.aiMessageCollapsedHint')}
                </p>
              </div>
              <Switch
                className="settings-switch"
                aria-label={t('general.aiMessageCollapsed')}
                checked={
                  draft.ai_message_default_collapsed ??
                  DEFAULT_COLLAPSE_PREFERENCES.aiMessagesCollapsed
                }
                onCheckedChange={(checked) =>
                  updateDraft({ ai_message_default_collapsed: checked })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.hideModelThinking')}</Label>
                <p className="settings-row__description">
                  {t('general.hideModelThinkingHint')}
                </p>
              </div>
              <Switch
                className="settings-switch"
                aria-label={t('general.hideModelThinking')}
                checked={
                  draft.hide_model_thinking ??
                  DEFAULT_COLLAPSE_PREFERENCES.hideModelThinking
                }
                onCheckedChange={(checked) =>
                  updateDraft({ hide_model_thinking: checked })
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={LayoutGrid}
          title={t('appearance.layout.title')}
          description={t('appearance.layout.description')}
          action={
            <SegmentedControl
              className="shrink-0"
              value={layoutPage}
              onChange={(value) =>
                setLayoutPage(value === 'kanban' ? 'kanban' : 'workspace')
              }
              label={t('appearance.layout.title')}
              size="sm"
              layout="hug"
            >
              <SegmentedControlItem
                value="workspace"
                label={t('appearance.layout.workspaceLabel')}
              />
              <SegmentedControlItem
                value="kanban"
                label={t('appearance.layout.kanbanLabel')}
              />
            </SegmentedControl>
          }
        >
          <div className="flex flex-col gap-3">
            {layoutPage === 'workspace' ? (
              <WorkspaceLayoutSchematic
                value={workspaceArrangement}
                onChange={setLayoutArrangement}
              />
            ) : (
              <KanbanLayoutSchematic
                value={kanbanArrangement}
                onChange={setKanbanArrangement}
              />
            )}
            <p className="settings-row__description">
              {layoutPage === 'workspace'
                ? t('appearance.layout.dragHint')
                : t('appearance.layout.kanbanHint')}
            </p>
            <p className="settings-row__description">
              {t('appearance.layout.hint')}
            </p>
          </div>
        </SettingsSection>
      </div>

    </div>
  );
}
