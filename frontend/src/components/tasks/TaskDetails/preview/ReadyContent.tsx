import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Copy,
  Crosshair,
  ExternalLink,
  Grip,
  Loader2,
  Monitor,
  Pause,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ViewMode = 'desktop' | 'tablet' | 'mobile';
type DeviceViewMode = Exclude<ViewMode, 'desktop'>;
type ViewportSize = { width: number; height: number };

const defaultViewportSizes: Record<DeviceViewMode, ViewportSize> = {
  tablet: { width: 768, height: 1024 },
  mobile: { width: 430, height: 932 },
};

const minViewportSize: ViewportSize = { width: 240, height: 320 };

interface ReadyContentProps {
  url?: string;
  displayUrl?: string;
  iframeKey: string;
  onIframeError: () => void;
  onIframeLoad?: (iframe: HTMLIFrameElement | null) => void;
  onCopyUrl?: () => void;
  onStop?: () => void;
  isStopping?: boolean;
  onToggleSelectMode?: (iframe: HTMLIFrameElement | null) => void;
  isSelectModeEnabled?: boolean;
  onToggleInspector?: () => void;
  isInspectorOpen?: boolean;
  inspectorPane?: ReactNode;
  onUrlChange?: (url: string) => void;
  hasUrlOverride?: boolean;
  onClearUrlOverride?: () => void;
}

export function ReadyContent({
  url,
  displayUrl,
  iframeKey,
  onIframeError,
  onIframeLoad,
  onCopyUrl,
  onStop,
  isStopping,
  onToggleSelectMode,
  isSelectModeEnabled = false,
  onToggleInspector,
  isInspectorOpen = false,
  inspectorPane,
  onUrlChange,
  hasUrlOverride = false,
  onClearUrlOverride,
}: ReadyContentProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [urlInput, setUrlInput] = useState(url ?? '');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const resizeDragRef = useRef<{
    mode: DeviceViewMode;
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('desktop');
  const [viewportSizes, setViewportSizes] = useState(defaultViewportSizes);

  const handleNavigate = () => {
    let target = urlInput.trim();
    if (target && !/^https?:\/\//i.test(target)) {
      target = 'http://' + target;
    }
    onUrlChange?.(target);
    setLocalRefreshKey((key) => key + 1);
  };

  const handleRefresh = () => {
    setLocalRefreshKey((key) => key + 1);
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (viewMode === 'desktop') return;

    const size = viewportSizes[viewMode];
    resizeDragRef.current = {
      mode: viewMode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: size.width,
      startHeight: size.height,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleResizePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const nextWidth = Math.max(
      minViewportSize.width,
      Math.round(drag.startWidth + event.clientX - drag.startX)
    );
    const nextHeight = Math.max(
      minViewportSize.height,
      Math.round(drag.startHeight + event.clientY - drag.startY)
    );

    setViewportSizes((previous) => ({
      ...previous,
      [drag.mode]: {
        width: nextWidth,
        height: nextHeight,
      },
    }));
  };

  const handleResizePointerEnd = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (resizeDragRef.current?.pointerId === event.pointerId) {
      resizeDragRef.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    setUrlInput(displayUrl ?? url ?? '');
  }, [displayUrl, url]);

  const effectiveSrc = url;
  const deviceViewportSize =
    viewMode === 'desktop' ? null : viewportSizes[viewMode];
  const previewViewportStyle: CSSProperties = deviceViewportSize
    ? {
        width: `${deviceViewportSize.width}px`,
        height: `${deviceViewportSize.height}px`,
      }
    : {
        width: '100%',
        height: '100%',
      };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2 py-1">
        <button
          disabled
          className="cursor-not-allowed rounded p-1 text-muted-foreground/40"
          title={t('readyContent.back')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          disabled
          className="cursor-not-allowed rounded p-1 text-muted-foreground/40"
          title={t('readyContent.forward')}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>

        <input
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && handleNavigate()}
          className="flex-1 rounded border bg-background px-2 py-0.5 font-mono text-xs"
          placeholder={t('readyContent.urlPlaceholder')}
        />

        <div className="mx-0.5 h-4 border-l border-border" />

        {hasUrlOverride && onClearUrlOverride && (
          <button
            onClick={onClearUrlOverride}
            className="rounded p-1 hover:bg-accent"
            title="Use detected URL"
            aria-label="Use detected URL"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}

        {onCopyUrl && (
          <button
            onClick={onCopyUrl}
            className="rounded p-1 hover:bg-accent"
            title={t('readyContent.copyUrl')}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}

        {effectiveSrc && (
          <a
            href={effectiveSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex rounded p-1 hover:bg-accent"
            title={t('readyContent.openInNewTab')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        <button
          onClick={handleRefresh}
          className="rounded p-1 hover:bg-accent"
          title={t('readyContent.refresh')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 h-4 border-l border-border" />

        {onToggleSelectMode && (
          <button
            onClick={() => onToggleSelectMode?.(iframeRef.current)}
            aria-pressed={isSelectModeEnabled}
            className={`rounded p-1 ${
              isSelectModeEnabled
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent'
            }`}
            title={t('readyContent.selectElement')}
            aria-label={t('readyContent.selectElement')}
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
        )}

        {onToggleInspector && (
          <button
            onClick={onToggleInspector}
            className={`rounded p-1 ${
              isInspectorOpen
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent'
            }`}
            title={t('readyContent.toggleInspector')}
            aria-label={t('readyContent.toggleInspector')}
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        )}

        <div className="mx-0.5 h-4 border-l border-border" />

        {(['desktop', 'tablet', 'mobile'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`rounded p-1 text-xs ${
              viewMode === mode
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent'
            }`}
            title={mode}
          >
            {mode === 'desktop' ? (
              <Monitor className="h-3.5 w-3.5" />
            ) : mode === 'tablet' ? (
              <Tablet className="h-3.5 w-3.5" />
            ) : (
              <Smartphone className="h-3.5 w-3.5" />
            )}
          </button>
        ))}

        {onStop && (
          <>
            <div className="mx-0.5 h-4 border-l border-border" />
            <button
              onClick={onStop}
              disabled={isStopping}
              className="rounded p-1 text-destructive hover:bg-accent"
              title={t('readyContent.stopDevServer')}
            >
              {isStopping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Pause className="h-3.5 w-3.5" />
              )}
            </button>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden bg-muted/20">
        <div className="flex min-w-0 flex-1 items-start justify-center overflow-auto">
          <div
            className={`relative shrink-0 bg-[var(--preview-canvas,hsl(var(--background)))] ${
              viewMode === 'desktop' ? 'h-full w-full' : 'shadow-sm'
            }`}
            style={previewViewportStyle}
          >
            <iframe
              key={`${iframeKey}-${localRefreshKey}`}
              ref={iframeRef}
              src={effectiveSrc}
              title={t('readyContent.previewTitle')}
              className="h-full w-full border-0 bg-[var(--preview-canvas,hsl(var(--background)))]"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              referrerPolicy="no-referrer"
              onLoad={() => onIframeLoad?.(iframeRef.current)}
              onError={onIframeError}
            />
            {deviceViewportSize && (
              <button
                type="button"
                aria-label="Resize preview viewport"
                title={`${deviceViewportSize.width}x${deviceViewportSize.height}`}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerEnd}
                onPointerCancel={handleResizePointerEnd}
                className="absolute bottom-1 right-1 z-10 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded border border-border/70 bg-background/85 text-muted-foreground shadow-sm hover:text-foreground"
              >
                <Grip className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {isInspectorOpen ? inspectorPane : null}
      </div>
    </div>
  );
}
