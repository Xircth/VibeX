import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Infinity as InfinityIcon,
  Loader2,
  Monitor,
  Moon,
  PanelsTopLeft,
  Plus,
  Sun,
} from 'lucide-react';
import { ThemeMode } from 'shared/types';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useTheme } from '@/components/ThemeProvider';
import {
  COLOR_THEME_CHANGED_EVENT,
  selectColorTheme,
} from '@/lib/theme/colorThemeStore';
import { resolveThemeColors } from '@/lib/theme/compileTheme';
import { useColorThemes } from '@/lib/theme/useColorThemes';
import {
  ACCENT_COLOR_CHANGED_EVENT,
  followThemeAccent,
  getAccentColor,
  getAccentOverride,
  hexToHsv,
  hsvToHex,
  resolveAccentForTheme,
  setAccentColor,
  type Hsv,
} from '@/lib/uiAccent';
import { cn } from '@/lib/utils';
import {
  setWorkspaceStageStyle,
  useWorkspaceStageStyle,
} from '@/lib/workspaceStageStyle';
import { OnboardingLayoutPreview } from './OnboardingLayoutPreview';

export type OnboardingPriorStep = 'intro' | 'configure' | 'history' | 'projects';

const ACCENT_PRESETS = [
  { name: 'Tahoe Blue', hex: '#007aff' },
  { name: 'Amber', hex: '#cf6610' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Rose', hex: '#e11d48' },
] as const;

const PRESET_HEX_SET = new Set<string>(ACCENT_PRESETS.map((item) => item.hex));

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hsvFromClient(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  hue: number
): Hsv {
  return {
    h: hue,
    s: clamp((clientX - rect.left) / rect.width, 0, 1),
    v: clamp(1 - (clientY - rect.top) / rect.height, 0, 1),
  };
}

export function OnboardingAppearance({
  onBack,
  onNavigateStep,
  onContinue,
}: {
  onBack: () => void;
  onNavigateStep?: (step: OnboardingPriorStep) => void;
  onContinue: (theme: ThemeMode) => Promise<void>;
}) {
  const { t } = useTranslation(['dialogs', 'settings']);
  const { theme, resolvedTheme, setTheme } = useTheme();
  const colors = useColorThemes();
  const mode = useWorkspaceStageStyle();
  const hueLabelId = useId();

  const [systemPair, setSystemPair] = useState<'light' | 'dark'>(resolvedTheme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setSystemPair(resolvedTheme);
  }, [resolvedTheme]);

  const activeScheme: 'light' | 'dark' =
    theme === ThemeMode.LIGHT
      ? 'light'
      : theme === ThemeMode.DARK
        ? 'dark'
        : systemPair;

  const readCurrentHex = useCallback(
    () => getAccentOverride() ?? getAccentColor(activeScheme),
    [activeScheme]
  );

  const [overrideHex, setOverrideHex] = useState<string | null>(() =>
    getAccentOverride()
  );
  const [hexDraft, setHexDraft] = useState<string>(readCurrentHex);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(readCurrentHex()));

  useEffect(() => {
    const sync = () => {
      setOverrideHex(getAccentOverride());
      if (pickerOpen) return;
      const next = readCurrentHex();
      setHexDraft(next);
      setHsv(hexToHsv(next));
    };
    sync();
    window.addEventListener(ACCENT_COLOR_CHANGED_EVENT, sync);
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(ACCENT_COLOR_CHANGED_EVENT, sync);
      window.removeEventListener(COLOR_THEME_CHANGED_EVENT, sync);
    };
  }, [pickerOpen, readCurrentHex]);

  const commitAccent = useCallback(
    (hex: string) => {
      setAccentColor(hex);
      const next = getAccentOverride() ?? getAccentColor(activeScheme);
      setOverrideHex(getAccentOverride());
      setHexDraft(next);
      setHsv(hexToHsv(next));
    },
    [activeScheme]
  );

  const commitHsv = useCallback((next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexDraft(hex);
    setAccentColor(hex);
    setOverrideHex(getAccentOverride());
  }, []);

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onContinue(theme);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const schemeThemes = colors.themes.filter(
    (entry) => entry.theme.scheme === activeScheme
  );
  const followsTheme = overrideHex === null;
  const isCustomOverride =
    overrideHex !== null && !PRESET_HEX_SET.has(overrideHex);
  const customAppliedColor = isCustomOverride
    ? resolveAccentForTheme(overrideHex, activeScheme)
    : undefined;
  const draftHex = hsvToHex(hsv);

  const previewOverrideTheme =
    theme === ThemeMode.SYSTEM && activeScheme !== resolvedTheme
      ? colors.active[activeScheme].theme
      : null;

  return (
    <main className="onboarding-projects-step onboarding-appearance-step">
      <nav
        className="onboarding-journey onboarding-appearance-journey"
        aria-label={t('dialogs:onboarding.stepsLabel')}
      >
        <div className="onboarding-journey-trail">
          {(
            [
              ['intro', 'welcomeStep'],
              ['configure', 'agentStep'],
              ['history', 'historyStep'],
              ['projects', 'projectStep'],
            ] as const
          ).map(([stepId, key]) => {
            const interactive =
              Boolean(onNavigateStep) || stepId === 'projects';
            return (
              <span key={stepId} className="onboarding-journey-item">
                {interactive ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      onNavigateStep ? onNavigateStep(stepId) : onBack()
                    }
                  >
                    {t(`dialogs:onboarding.${key}`)}
                  </button>
                ) : (
                  <span>{t(`dialogs:onboarding.${key}`)}</span>
                )}
                <ChevronRight aria-hidden="true" />
              </span>
            );
          })}
          <span aria-current="step">
            {t('dialogs:onboarding.appearanceStep')}
          </span>
        </div>
        <span
          className="onboarding-journey-count tabular-nums"
          aria-hidden="true"
        >
          5 / 5
        </span>
      </nav>

      <header className="onboarding-page-heading onboarding-appearance-heading">
        <h1 id="onboarding-title" tabIndex={-1}>
          {t('dialogs:onboarding.appearanceTitle')}
        </h1>
        <p>{t('dialogs:onboarding.appearanceDescription')}</p>
      </header>

      <section className="onboarding-page-content onboarding-appearance-content">
        <fieldset disabled={busy} className="onboarding-appearance-controls">
          {/* 1. Segmented Color Mode */}
          <div className="onboarding-control-group">
            <div className="onboarding-group-head">
              <span className="onboarding-group-label">
                {t('dialogs:onboarding.appearanceMode')}
              </span>
            </div>
            <div
              className="onboarding-mode-segmented"
              role="radiogroup"
              aria-label={t('dialogs:onboarding.appearanceMode')}
            >
              {(
                [
                  [ThemeMode.LIGHT, Sun, 'appearanceLight'],
                  [ThemeMode.DARK, Moon, 'appearanceDark'],
                  [ThemeMode.SYSTEM, Monitor, 'appearanceSystem'],
                ] as const
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  onClick={() => setTheme(value)}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  <span>{t(`dialogs:onboarding.${label}`)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Visual Color Theme Swatch Rows */}
          <div className="onboarding-control-group">
            <div className="onboarding-group-head">
              <span className="onboarding-group-label">
                {t('dialogs:onboarding.appearancePalette')}
              </span>
              {theme === ThemeMode.SYSTEM ? (
                <div
                  className="onboarding-pair-switch"
                  role="group"
                  aria-label={t('dialogs:onboarding.appearancePalette')}
                >
                  {(['light', 'dark'] as const).map((scheme) => (
                    <button
                      key={scheme}
                      type="button"
                      aria-pressed={systemPair === scheme}
                      onClick={() => setSystemPair(scheme)}
                    >
                      {t(
                        scheme === 'light'
                          ? 'dialogs:onboarding.appearancePairLight'
                          : 'dialogs:onboarding.appearancePairDark'
                      )}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div
              className="onboarding-palette-list"
              role="radiogroup"
              aria-label={t(
                activeScheme === 'light'
                  ? 'dialogs:onboarding.appearanceLightPalette'
                  : 'dialogs:onboarding.appearanceDarkPalette'
              )}
            >
              {schemeThemes.map((entry) => {
                const resolved = resolveThemeColors(entry.theme);
                const selected = colors.active[activeScheme].key === entry.key;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    role="radio"
                    className="onboarding-palette-card"
                    aria-checked={selected}
                    onClick={() => selectColorTheme(activeScheme, entry.key)}
                  >
                    <span className="onboarding-palette-card-main">
                      <span
                        className="onboarding-palette-mini-win"
                        style={{ backgroundColor: resolved.chrome }}
                        aria-hidden="true"
                      >
                        <span
                          className="onboarding-palette-mini-surface"
                          style={{ backgroundColor: resolved.surface }}
                        />
                      </span>
                      <span className="onboarding-palette-name">
                        {entry.theme.label}
                      </span>
                    </span>
                    <span
                      className="onboarding-palette-card-meta"
                      aria-hidden="true"
                    >
                      <span className="onboarding-palette-dots">
                        <span
                          style={{ backgroundColor: resolved.syntaxKeyword }}
                        />
                        <span
                          style={{ backgroundColor: resolved.syntaxString }}
                        />
                        <span style={{ backgroundColor: resolved.accent }} />
                      </span>
                      <Check className="size-3.5 onboarding-palette-check" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Aligned Accent Swatches + Custom Color Popover */}
          <div className="onboarding-control-group">
            <div className="onboarding-group-head">
              <span className="onboarding-group-label">
                {t('dialogs:onboarding.appearanceAccent')}
              </span>
              <span className="onboarding-accent-readout tabular-nums">
                {followsTheme
                  ? t('dialogs:onboarding.appearanceAccentFollowTheme')
                  : overrideHex.toUpperCase()}
              </span>
            </div>

            <div className="onboarding-accent-bar">
              <div
                className="onboarding-accent-swatches"
                role="radiogroup"
                aria-label={t('dialogs:onboarding.appearanceAccent')}
              >
                <button
                  type="button"
                  role="radio"
                  className="onboarding-accent-swatch is-auto"
                  aria-label={t(
                    'dialogs:onboarding.appearanceAccentFollowTheme'
                  )}
                  aria-checked={followsTheme}
                  onClick={followThemeAccent}
                />
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.hex}
                    type="button"
                    role="radio"
                    className="onboarding-accent-swatch"
                    style={{ backgroundColor: preset.hex }}
                    aria-label={t('dialogs:onboarding.appearanceAccentPreset', {
                      name: preset.name,
                    })}
                    aria-checked={!followsTheme && overrideHex === preset.hex}
                    onClick={() => commitAccent(preset.hex)}
                  />
                ))}
              </div>

              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="onboarding-accent-swatch is-custom"
                    data-active={isCustomOverride || undefined}
                    style={
                      customAppliedColor
                        ? { backgroundColor: customAppliedColor }
                        : undefined
                    }
                    aria-label={t('dialogs:onboarding.appearanceAccentCustom')}
                    aria-haspopup="dialog"
                    aria-expanded={pickerOpen}
                  >
                    <Plus className="size-3" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="onboarding-popover-layer w-56 space-y-3 p-3"
                >
                  <div
                    className="relative h-32 w-full cursor-crosshair touch-none rounded-lg"
                    style={{
                      backgroundColor: `hsl(${hsv.h} 100% 50%)`,
                      backgroundImage:
                        'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
                    }}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const rect = event.currentTarget.getBoundingClientRect();
                      commitHsv(
                        hsvFromClient(
                          event.clientX,
                          event.clientY,
                          rect,
                          hsv.h
                        )
                      );
                    }}
                    onPointerMove={(event) => {
                      if (
                        !event.currentTarget.hasPointerCapture(event.pointerId)
                      ) {
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      commitHsv(
                        hsvFromClient(
                          event.clientX,
                          event.clientY,
                          rect,
                          hsv.h
                        )
                      );
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                      style={{
                        left: `${hsv.s * 100}%`,
                        top: `${(1 - hsv.v) * 100}%`,
                        boxShadow: '0 0 0 1px rgb(0 0 0 / 0.35)',
                        backgroundColor: draftHex,
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="sr-only" htmlFor={hueLabelId}>
                      {t('settings:appearance.accent.hue')}
                    </label>
                    <input
                      id={hueLabelId}
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      value={Math.round(hsv.h)}
                      aria-label={t('settings:appearance.accent.hue')}
                      className={cn(
                        'h-3 w-full cursor-pointer appearance-none rounded-full',
                        '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5',
                        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
                        '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white',
                        '[&::-webkit-slider-thumb]:bg-white'
                      )}
                      style={{
                        background:
                          'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
                      }}
                      onChange={(event) =>
                        commitHsv({ ...hsv, h: Number(event.target.value) })
                      }
                    />
                  </div>
                  <Input
                    value={hexDraft}
                    onChange={(event) => {
                      const val = event.target.value;
                      setHexDraft(val);
                      if (/^#?[0-9a-f]{6}$/i.test(val.trim())) {
                        commitAccent(val.trim());
                      }
                    }}
                    onBlur={() => commitAccent(hexDraft)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur();
                      }
                    }}
                    aria-label={t('settings:appearance.accent.hex')}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono uppercase"
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* 4. Workspace Stage Style Cards */}
          <div className="onboarding-control-group">
            <div className="onboarding-group-head">
              <span className="onboarding-group-label">
                {t('dialogs:onboarding.appearanceWorkspace')}
              </span>
            </div>
            <div
              className="onboarding-stage-cards"
              role="radiogroup"
              aria-label={t('dialogs:onboarding.appearanceWorkspace')}
            >
              {(
                [
                  [
                    'tabs',
                    PanelsTopLeft,
                    'appearanceTabs',
                    'appearanceTabsDescription',
                  ],
                  [
                    'canvas',
                    InfinityIcon,
                    'appearanceCanvas',
                    'appearanceCanvasDescription',
                  ],
                ] as const
              ).map(([value, Icon, label, description]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  className="onboarding-stage-card"
                  aria-label={t(`dialogs:onboarding.${label}`)}
                  aria-checked={mode === value}
                  onClick={() => setWorkspaceStageStyle(value)}
                >
                  <span className="onboarding-stage-glyph" aria-hidden="true">
                    <Icon className="size-4" />
                  </span>
                  <span className="onboarding-stage-copy">
                    <strong>{t(`dialogs:onboarding.${label}`)}</strong>
                    <span>{t(`dialogs:onboarding.${description}`)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </fieldset>

        <OnboardingLayoutPreview
          mode={mode}
          previewTheme={previewOverrideTheme}
        />
      </section>

      {error ? (
        <p role="alert" className="onboarding-inline-error">
          {error}
        </p>
      ) : null}

      <footer className="onboarding-page-footer">
        <button
          type="button"
          className="onboarding-back-button"
          disabled={busy}
          onClick={onBack}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span>{t('dialogs:onboarding.back')}</span>
        </button>
        <button
          type="button"
          className="onboarding-primary-button onboarding-enter-button"
          disabled={busy}
          onClick={() => void finish()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          <span>{t('dialogs:onboarding.enterWorkspace')}</span>
          {!busy ? <ArrowRight className="size-4" aria-hidden="true" /> : null}
        </button>
      </footer>
    </main>
  );
}
