import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemeDefinition } from '@vibex/plugin-sdk';
import {
  Files,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_SITE_URL, getSiteUrl } from '@/lib/branding';
import { compileThemeDeclarations } from '@/lib/theme/compileTheme';
import type { WorkspaceStageStyle } from '@/lib/workspaceStageStyle';

export const ONBOARDING_VIDEO_FILES: Record<WorkspaceStageStyle, string> = {
  tabs: 'free-tabs.mp4',
  canvas: 'infinite-canvas.mp4',
};

const SCHEMATIC_PANELS = [
  { id: 'conversation', Icon: MessageSquare },
  { id: 'files', Icon: Files },
  { id: 'terminal', Icon: Terminal },
] as const;

export function resolveOnboardingVideoSources(
  mode: WorkspaceStageStyle,
  options?: {
    customBaseUrl?: string;
    devLocal?: boolean;
  }
): string[] {
  const fileName = ONBOARDING_VIDEO_FILES[mode];
  const candidates: string[] = [];

  const rawOverride =
    options?.customBaseUrl ??
    (import.meta.env.VIBEX_ONBOARDING_VIDEO_BASE_URL ||
      import.meta.env.VITE_VIBEX_ONBOARDING_VIDEO_BASE_URL ||
      '');
  const trimmedOverride = rawOverride.trim().replace(/\/+$/, '');
  if (trimmedOverride) {
    candidates.push(`${trimmedOverride}/${fileName}`);
  }

  const useDevLocal =
    options?.devLocal ??
    (import.meta.env.DEV && import.meta.env.MODE !== 'test');
  if (useDevLocal) {
    candidates.push(`/__dev/onboarding-videos/${fileName}`);
  }

  candidates.push(getSiteUrl(`/videos/onboarding/${fileName}`));
  candidates.push(`${DEFAULT_SITE_URL}/videos/onboarding/${fileName}`);

  return Array.from(new Set(candidates));
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return (
      window.matchMedia('(prefers-reduced-motion: reduce)')?.matches ?? false
    );
  });

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media?.addEventListener) return;
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function OfflineStageSchematic({ mode }: { mode: WorkspaceStageStyle }) {
  const { t } = useTranslation('dialogs', { keyPrefix: 'onboarding' });

  if (mode === 'tabs') {
    return (
      <div className="onboarding-fallback-tabs">
        <div className="onboarding-fallback-tabbar" aria-hidden="true">
          {SCHEMATIC_PANELS.map(({ id, Icon }, index) => (
            <span
              key={id}
              className="onboarding-fallback-tab"
              data-active={index === 0 || undefined}
            >
              <Icon className="size-3.5" />
              <span>{t(`previewPanel.${id}`)}</span>
            </span>
          ))}
        </div>
        <div className="onboarding-fallback-split" aria-hidden="true">
          <div className="onboarding-fallback-pane">
            <span className="onboarding-fallback-line is-short" />
            <span className="onboarding-fallback-line" />
            <span className="onboarding-fallback-line is-medium" />
          </div>
          <div className="onboarding-fallback-pane is-secondary">
            <span className="onboarding-fallback-line is-medium" />
            <span className="onboarding-fallback-line" />
            <span className="onboarding-fallback-line is-short" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-fallback-canvas" aria-hidden="true">
      {SCHEMATIC_PANELS.map(({ id, Icon }) => (
        <div key={id} data-panel={id} className="onboarding-fallback-node">
          <header>
            <Icon className="size-3.5" />
            <span>{t(`previewPanel.${id}`)}</span>
          </header>
          <div className="onboarding-fallback-node-body">
            <span className="onboarding-fallback-line" />
            <span className="onboarding-fallback-line is-medium" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StageDemoPlayer({
  mode,
  reducedMotion,
  deckThemeStyle,
  onRetry,
}: {
  mode: WorkspaceStageStyle;
  reducedMotion: boolean;
  deckThemeStyle?: CSSProperties;
  onRetry: () => void;
}) {
  const { t } = useTranslation('dialogs', { keyPrefix: 'onboarding' });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sources = useMemo(() => resolveOnboardingVideoSources(mode), [mode]);
  const warmSrc = useMemo(() => {
    const otherMode: WorkspaceStageStyle = mode === 'tabs' ? 'canvas' : 'tabs';
    return resolveOnboardingVideoSources(otherMode)[0];
  }, [mode]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>(() =>
    sources.length === 0 ? 'fallback' : 'loading'
  );
  const [paused, setPaused] = useState(reducedMotion);

  const currentSrc = sources[sourceIndex];
  const videoTitle = t(
    mode === 'canvas' ? 'previewCanvasVideoTitle' : 'previewTabsVideoTitle'
  );

  const togglePlayback = () => {
    const el = videoRef.current;
    if (!el || status !== 'ready') return;
    if (paused) {
      setPaused(false);
      void el.play()?.catch(() => setPaused(true));
    } else {
      el.pause();
      setPaused(true);
    }
  };

  const replay = () => {
    const el = videoRef.current;
    if (!el || status !== 'ready') return;
    el.currentTime = 0;
    setPaused(false);
    void el.play()?.catch(() => setPaused(true));
  };

  return (
    <>
      <header className="onboarding-demo-heading">
        <span className="onboarding-demo-title">
          <span className="onboarding-demo-live-dot" aria-hidden="true" />
          <span>{videoTitle}</span>
        </span>

        {status === 'fallback' ? (
          <div className="onboarding-canvas-controls">
            <span className="onboarding-demo-offline-pill">
              {t('previewOfflineBadge')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('previewRetryVideo')}
              onClick={onRetry}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        ) : (
          <nav
            aria-label={t('previewControls')}
            className="onboarding-canvas-controls"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t(paused ? 'previewPlay' : 'previewPause')}
              disabled={status !== 'ready'}
              onClick={togglePlayback}
            >
              {paused ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('previewReplay')}
              disabled={status !== 'ready'}
              onClick={replay}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </nav>
        )}
      </header>

      <div
        className="onboarding-layout-deck"
        data-mode={mode}
        data-status={status}
        style={deckThemeStyle}
      >
        {status === 'fallback' ? (
          <section
            className="onboarding-layout-preview"
            data-mode={mode}
            aria-label={t(
              mode === 'canvas' ? 'appearanceCanvas' : 'appearanceTabs'
            )}
          >
            <OfflineStageSchematic mode={mode} />
          </section>
        ) : (
          <>
            <video
              ref={videoRef}
              src={currentSrc}
              className="onboarding-demo-video"
              data-ready={status === 'ready' || undefined}
              autoPlay={!reducedMotion}
              loop
              muted
              playsInline
              preload={reducedMotion ? 'metadata' : 'auto'}
              aria-label={videoTitle}
              onClick={togglePlayback}
              onLoadedData={() => setStatus('ready')}
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onError={() => {
                if (sourceIndex + 1 < sources.length) {
                  setSourceIndex((index) => index + 1);
                } else {
                  setStatus('fallback');
                }
              }}
            />
            {status === 'loading' ? (
              <div className="onboarding-video-loading" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span>{t('previewLoading')}</span>
              </div>
            ) : null}
            {status === 'ready' && warmSrc ? (
              <video
                hidden
                muted
                playsInline
                preload="metadata"
                src={warmSrc}
                aria-hidden="true"
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

export function OnboardingLayoutPreview({
  mode,
  previewTheme,
}: {
  mode: WorkspaceStageStyle;
  previewTheme?: ThemeDefinition | null;
}) {
  const { t } = useTranslation('dialogs', { keyPrefix: 'onboarding' });
  const reducedMotion = usePrefersReducedMotion();
  const [retryNonce, setRetryNonce] = useState(0);

  const deckThemeStyle = useMemo<CSSProperties | undefined>(() => {
    if (!previewTheme) return undefined;
    const declarations = compileThemeDeclarations(previewTheme);
    const style: Record<string, string> = {};
    for (const [prop, val] of declarations) {
      style[prop] = val;
    }
    style['--primary'] = 'var(--_primary)';
    style['--primary-foreground'] = 'var(--_primary-foreground)';
    style['--success'] = 'var(--_success)';
    style['--destructive'] = 'var(--_destructive)';
    return style as CSSProperties;
  }, [previewTheme]);

  return (
    <section
      className="onboarding-layout-demo"
      aria-label={t('appearancePreview')}
    >
      <StageDemoPlayer
        key={`${mode}:${retryNonce}`}
        mode={mode}
        reducedMotion={reducedMotion}
        deckThemeStyle={deckThemeStyle}
        onRetry={() => setRetryNonce((count) => count + 1)}
      />

      <p className="onboarding-demo-hint">
        {t(mode === 'canvas' ? 'previewCanvasHint' : 'previewTabsHint')}
      </p>
    </section>
  );
}
