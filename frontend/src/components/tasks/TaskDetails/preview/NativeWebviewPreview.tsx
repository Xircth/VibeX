import { useEffect, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface NativeWebviewPreviewProps {
  url: string;
  onCreated?: () => void;
}

type PreviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

let nextNativePreviewId = 0;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    normalized === 'tauri.localhost' ||
    normalized.endsWith('.localhost')
  );
}

export function shouldUseNativeWebview(url?: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function readPreviewBounds(element: HTMLElement): PreviewBounds | null {
  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);

  if (
    width < 1 ||
    height < 1 ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth ||
    document.visibilityState === 'hidden'
  ) {
    return null;
  }

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width,
    height,
  };
}

function boundsEqual(
  previous: PreviewBounds | null,
  next: PreviewBounds
): boolean {
  return (
    previous?.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height
  );
}

/**
 * Hosts an external page in a real Tauri child WebView. Remote sites commonly
 * block iframe embedding with CSP frame-ancestors or X-Frame-Options, while a
 * child WebView is a top-level browsing context and is not subject to those
 * embedding restrictions.
 */
export function NativeWebviewPreview({
  url,
  onCreated,
}: NativeWebviewPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onCreatedRef = useRef(onCreated);
  const [creationError, setCreationError] = useState<string | null>(null);

  onCreatedRef.current = onCreated;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!('__TAURI_INTERNALS__' in window)) {
      setCreationError('External page previews require the desktop app.');
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let webview: Webview | null = null;
    let pendingWebview: Webview | null = null;
    let creationInFlight = false;
    let creationFailed = false;
    let isVisible = false;
    let lastBounds: PreviewBounds | null = null;
    let updateInFlight = false;

    nextNativePreviewId += 1;
    const label = `web-preview-${nextNativePreviewId}`;

    const createWebview = (bounds: PreviewBounds) => {
      creationInFlight = true;
      const candidate = new Webview(getCurrentWindow(), label, {
        url,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        focus: false,
      });
      pendingWebview = candidate;

      void candidate.once('tauri://created', () => {
        creationInFlight = false;
        if (disposed) {
          void candidate.close().catch(() => undefined);
          return;
        }

        webview = candidate;
        pendingWebview = null;
        lastBounds = bounds;
        isVisible = true;
        setCreationError(null);
        onCreatedRef.current?.();
      });

      void candidate.once<string>('tauri://error', (event) => {
        creationInFlight = false;
        creationFailed = true;
        pendingWebview = null;
        if (disposed) return;

        setCreationError(String(event.payload));
      });
    };

    const syncWebview = async (bounds: PreviewBounds | null) => {
      if (disposed || updateInFlight) return;

      if (!bounds) {
        if (webview && isVisible) {
          updateInFlight = true;
          isVisible = false;
          await webview.hide().catch(() => undefined);
          updateInFlight = false;
        }
        return;
      }

      if (!webview) {
        if (!creationInFlight && !creationFailed) createWebview(bounds);
        return;
      }

      if (boundsEqual(lastBounds, bounds) && isVisible) return;

      updateInFlight = true;
      const updates: Array<Promise<void>> = [];
      if (!boundsEqual(lastBounds, bounds)) {
        updates.push(
          webview.setPosition(new LogicalPosition(bounds.x, bounds.y)),
          webview.setSize(new LogicalSize(bounds.width, bounds.height))
        );
        lastBounds = bounds;
      }
      if (!isVisible) {
        updates.push(webview.show());
        isVisible = true;
      }
      await Promise.all(updates).catch(() => undefined);
      updateInFlight = false;
    };

    const trackBounds = () => {
      void syncWebview(readPreviewBounds(host));
      animationFrame = window.requestAnimationFrame(trackBounds);
    };

    trackBounds();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      const activeWebview = webview ?? pendingWebview;
      if (activeWebview) {
        void activeWebview.close().catch(() => undefined);
      }
    };
  }, [url]);

  return (
    <div
      ref={hostRef}
      data-testid="native-webview-preview"
      className="flex h-full w-full items-center justify-center bg-[var(--preview-canvas,hsl(var(--background)))]"
    >
      {creationError ? (
        <p
          role="alert"
          className="max-w-md px-6 text-center text-sm text-muted-foreground"
        >
          {creationError}
        </p>
      ) : null}
    </div>
  );
}
