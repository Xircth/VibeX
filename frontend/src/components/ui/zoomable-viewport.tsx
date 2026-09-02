import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Maximize2,
  Minimize2,
  Minus,
  Move,
  Plus,
  ScanSearch,
  Undo2,
} from 'lucide-react';
import {
  useZoomableViewport,
  type ViewportSize,
  type ZoomableViewportOptions,
} from '@/hooks/useZoomableViewport';
import { cn } from '@/lib/utils';

type ZoomableViewportProps = {
  contentSize: ViewportSize;
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  surfaceClassName?: string;
  ariaLabel: string;
  options?: ZoomableViewportOptions;
};

export function ZoomableViewport({
  contentSize,
  children,
  className,
  viewportClassName,
  surfaceClassName,
  ariaLabel,
  options,
}: ZoomableViewportProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const {
    viewportRef,
    fittedSize,
    scale,
    offset,
    canPan,
    isDragging,
    zoomPercent,
    zoomIn,
    zoomOut,
    zoomToActualSize,
    resetView,
    toggleFitOrZoom,
    handleWheel,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    minScale,
    maxScale,
  } = useZoomableViewport(contentSize, options);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    const root = rootRef.current;
    if (!root) return;

    if (document.fullscreenElement === root) {
      await document.exitFullscreen();
      return;
    }

    await root.requestFullscreen();
  };

  return (
    <div
      ref={rootRef}
      className={cn('conv-zoomable-viewport', className)}
      data-fullscreen={isFullscreen ? 'true' : 'false'}
    >
      <div className="conv-zoomable-viewport__toolbar" aria-hidden={false}>
        <button
          type="button"
          className="conv-zoomable-viewport__button"
          onClick={zoomOut}
          disabled={scale <= minScale}
          aria-label={'\u7f29\u5c0f'}
          title={'\u7f29\u5c0f'}
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="conv-zoomable-viewport__zoom">{zoomPercent}%</span>
        <button
          type="button"
          className="conv-zoomable-viewport__button"
          onClick={zoomIn}
          disabled={scale >= maxScale}
          aria-label={'\u653e\u5927'}
          title={'\u653e\u5927'}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="conv-zoomable-viewport__button conv-zoomable-viewport__button--text"
          onClick={zoomToActualSize}
          aria-label={'1:1 \u539f\u59cb\u5927\u5c0f'}
          title={'1:1'}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          1:1
        </button>
        <button
          type="button"
          className="conv-zoomable-viewport__button conv-zoomable-viewport__button--text"
          onClick={resetView}
          aria-label={'\u9002\u5e94'}
          title={'\u9002\u5e94'}
        >
          <Undo2 className="h-3.5 w-3.5" />
          {'\u9002\u5e94'}
        </button>
        <button
          type="button"
          className="conv-zoomable-viewport__button conv-zoomable-viewport__button--text"
          onClick={() => void toggleFullscreen()}
          aria-label={isFullscreen ? '\u9000\u51fa\u5168\u5c4f' : '\u5168\u5c4f'}
          title={isFullscreen ? '\u9000\u51fa\u5168\u5c4f' : '\u5168\u5c4f'}
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
          {isFullscreen ? '\u9000\u51fa' : '\u5168\u5c4f'}
        </button>
      </div>

      <div
        ref={viewportRef}
        className={cn(
          'conv-zoomable-viewport__stage',
          canPan
            ? isDragging
              ? 'conv-zoomable-viewport__stage--dragging'
              : 'conv-zoomable-viewport__stage--pannable'
            : undefined,
          viewportClassName
        )}
        role="img"
        aria-label={ariaLabel}
        style={{ touchAction: 'none' }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={toggleFitOrZoom}
      >
        <div
          className={cn('conv-zoomable-viewport__surface', surfaceClassName)}
          style={{
            width: fittedSize.width || undefined,
            height: fittedSize.height || undefined,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          {children}
        </div>
      </div>

      <div className="conv-zoomable-viewport__hint" aria-hidden>
        <ScanSearch className="h-3.5 w-3.5" />
        <span>{'\u6eda\u8f6e\u7f29\u653e'}</span>
        <span className="conv-zoomable-viewport__hint-sep">/</span>
        <span className={canPan ? 'conv-zoomable-viewport__hint-active' : undefined}>
          {'\u62d6\u62fd\u5e73\u79fb'}
        </span>
        {canPan ? (
          <>
            <span className="conv-zoomable-viewport__hint-sep">/</span>
            <Move className="h-3.5 w-3.5" />
          </>
        ) : null}
      </div>
    </div>
  );
}
