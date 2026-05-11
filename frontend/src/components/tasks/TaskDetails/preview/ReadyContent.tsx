import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Copy,
  Crosshair,
  ExternalLink,
  Loader2,
  Monitor,
  Pause,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Tablet,
} from 'lucide-react';

type ViewMode = 'desktop' | 'tablet' | 'mobile';

const viewSizes: Record<ViewMode, { width: string; height: string }> = {
  desktop: { width: '100%', height: '100%' },
  tablet: { width: '768px', height: '100%' },
  mobile: { width: '375px', height: '100%' },
};

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
  const [urlInput, setUrlInput] = useState(url ?? '');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('desktop');

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

  useEffect(() => {
    setUrlInput(displayUrl ?? url ?? '');
  }, [displayUrl, url]);

  const effectiveSrc = url;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2 py-1">
        <button
          disabled
          className="cursor-not-allowed rounded p-1 text-muted-foreground/40"
          title="后退"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          disabled
          className="cursor-not-allowed rounded p-1 text-muted-foreground/40"
          title="前进"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>

        <input
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && handleNavigate()}
          className="flex-1 rounded border bg-background px-2 py-0.5 font-mono text-xs"
          placeholder="输入 URL..."
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
            title="复制 URL"
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
            title="在新标签页中打开"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        <button
          onClick={handleRefresh}
          className="rounded p-1 hover:bg-accent"
          title="刷新"
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
            title="选择元素作为内容"
            aria-label="选择元素作为内容"
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
            title="切换检查器"
            aria-label="切换检查器"
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
              title="停止开发服务器"
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
          <iframe
            key={`${iframeKey}-${localRefreshKey}`}
            ref={iframeRef}
            src={effectiveSrc}
            title="开发服务器预览"
            style={
              viewMode === 'desktop'
                ? { width: '100%', height: '100%' }
                : viewSizes[viewMode]
            }
            className="border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            onLoad={() => onIframeLoad?.(iframeRef.current)}
            onError={onIframeError}
          />
        </div>
        {isInspectorOpen ? inspectorPane : null}
      </div>
    </div>
  );
}
