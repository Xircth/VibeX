import { useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  Monitor,
  Tablet,
  Smartphone,
  Copy,
  ExternalLink,
  Pause,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Bug,
} from 'lucide-react';

type ViewMode = 'desktop' | 'tablet' | 'mobile';

const viewSizes: Record<ViewMode, { width: string; height: string }> = {
  desktop: { width: '100%', height: '100%' },
  tablet: { width: '768px', height: '100%' },
  mobile: { width: '375px', height: '100%' },
};

interface ReadyContentProps {
  url?: string;
  iframeKey: string;
  onIframeError: () => void;
  onIframeLoad?: (iframe: HTMLIFrameElement | null) => void;
  onCopyUrl?: () => void;
  onStop?: () => void;
  isStopping?: boolean;
  onToggleSelectMode?: (iframe: HTMLIFrameElement | null) => void;
  isSelectModeEnabled?: boolean;
  onToggleDevTools?: () => void;
  isDevToolsOpen?: boolean;
}

export function ReadyContent({
  url,
  iframeKey,
  onIframeError,
  onIframeLoad,
  onCopyUrl,
  onStop,
  isStopping,
  onToggleSelectMode,
  isSelectModeEnabled = false,
  onToggleDevTools,
  isDevToolsOpen = false,
}: ReadyContentProps) {
  const [currentUrl, setCurrentUrl] = useState(url ?? '');
  const [urlInput, setUrlInput] = useState(url ?? '');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('desktop');

  const handleNavigate = () => {
    let target = urlInput.trim();
    if (target && !target.startsWith('http')) {
      target = 'http://' + target;
    }
    setCurrentUrl(target);
    setLocalRefreshKey((k) => k + 1);
  };

  const handleRefresh = () => {
    setLocalRefreshKey((k) => k + 1);
  };

  useEffect(() => {
    setCurrentUrl(url ?? '');
    setUrlInput(url ?? '');
  }, [url]);

  // Use the parent URL if it changes (e.g. from custom URL in PreviewToolbar)
  const effectiveSrc = currentUrl || url;

  return (
    <div className="h-full flex flex-col">
      {/* Unified browser toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/50 shrink-0">
        {/* Navigation arrows (disabled - cannot control iframe history) */}
        <button
          disabled
          className="p-1 rounded text-muted-foreground/40 cursor-not-allowed"
          title="后退"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          disabled
          className="p-1 rounded text-muted-foreground/40 cursor-not-allowed"
          title="前进"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>

        {/* URL input */}
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
          className="flex-1 px-2 py-0.5 text-xs border rounded bg-background font-mono"
          placeholder="输入 URL..."
        />

        <div className="border-l border-border mx-0.5 h-4" />

        {/* Copy URL */}
        {onCopyUrl && (
          <button
            onClick={onCopyUrl}
            className="p-1 hover:bg-accent rounded"
            title="复制 URL"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Open externally */}
        {effectiveSrc && (
          <a
            href={effectiveSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 hover:bg-accent rounded inline-flex"
            title="在新标签页中打开"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        {/* Refresh */}
        <button
          onClick={handleRefresh}
          className="p-1 hover:bg-accent rounded"
          title="刷新"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>

        <div className="border-l border-border mx-0.5 h-4" />

        {onToggleSelectMode && (
          <button
            onClick={() => onToggleSelectMode?.(iframeRef.current)}
            aria-pressed={isSelectModeEnabled}
            className={`p-1 rounded ${
              isSelectModeEnabled
                ? 'bg-accent text-foreground'
                : 'hover:bg-accent text-muted-foreground'
            }`}
            title="选择元素作为内容"
            aria-label="选择元素作为内容"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
        )}

        {onToggleDevTools && (
          <button
            onClick={onToggleDevTools}
            className={`p-1 rounded ${
              isDevToolsOpen
                ? 'bg-accent text-foreground'
                : 'hover:bg-accent text-muted-foreground'
            }`}
            title="切换 DevTools"
            aria-label="切换 DevTools"
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        )}

        <div className="border-l border-border mx-0.5 h-4" />

        {/* Device view modes */}
        {(['desktop', 'tablet', 'mobile'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`p-1 rounded text-xs ${
              viewMode === mode
                ? 'bg-accent text-foreground'
                : 'hover:bg-accent text-muted-foreground'
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

        {/* Stop dev server */}
        {onStop && (
          <>
            <div className="border-l border-border mx-0.5 h-4" />
            <button
              onClick={onStop}
              disabled={isStopping}
              className="p-1 hover:bg-accent rounded text-destructive"
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
      {/* iframe */}
      <div className="flex-1 flex items-start justify-center overflow-auto bg-muted/20">
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
    </div>
  );
}
