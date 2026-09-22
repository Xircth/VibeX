import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Copy,
  ExternalLink,
  MoreVertical,
  MousePointerClick,
  RotateCw,
  Scaling,
  X,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { backendCall, backendListen } from '@/lib/backendTransport';
import { getInvokeErrorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { open } from '@tauri-apps/plugin-shell';
import { requestComposerTokenInsert } from '@/lib/composerInsert';
import { formatSessionComposerCommand } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import {
  completeBrowserAddress,
  isBrowserAddressSubmitKey,
} from './completeAddress';

const ICON_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const FIELD_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const ZOOM_PRESETS = [0.3, 0.5, 0.75, 1, 1.25, 1.5] as const;
const DEFAULT_ZOOM = 0.75;

type SurfaceBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  visible: boolean;
};

function measureSurface(
  host: HTMLElement | null,
  panelVisible: boolean,
  occluded: boolean
): SurfaceBounds {
  if (!host) {
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      scale: window.devicePixelRatio || 1,
      visible: false,
    };
  }
  const rect = host.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const laidOut = width >= 2 && height >= 2;
  return {
    x: rect.left,
    y: rect.top,
    width: Math.max(1, width),
    height: Math.max(1, height),
    scale: window.devicePixelRatio || 1,
    visible: panelVisible && laidOut && !occluded,
  };
}

function overlayCoversBrowser(
  host: HTMLElement | null,
  occlusion: {
    hide: boolean;
    rects: Array<{ x: number; y: number; width: number; height: number }>;
  }
): boolean {
  if (occlusion.hide) return true;
  if (!host || occlusion.rects.length === 0) return false;
  const surface = host.getBoundingClientRect();
  if (surface.width < 2 || surface.height < 2) return false;
  return occlusion.rects.some(
    (rect) =>
      rect.x < surface.right &&
      rect.x + rect.width > surface.left &&
      rect.y < surface.bottom &&
      rect.y + rect.height > surface.top
  );
}

function boundsKey(bounds: SurfaceBounds): string {
  return `${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}:${bounds.visible}`;
}

type FreezePayload = { mime?: string | null; data?: string | null };

function decodeFreeze(url: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = () => resolve();
    const timer = window.setTimeout(finish, 80);
    image.onload = () => {
      window.clearTimeout(timer);
      if (typeof image.decode === 'function') {
        void image.decode().then(finish, finish);
        return;
      }
      finish();
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      finish();
    };
    image.src = url;
  });
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function provisionalTitle(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function faviconFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function sameSite(left: string, right: string): boolean {
  try {
    const a = new URL(left).hostname.replace(/^www\./, '');
    const b = new URL(right).hostname.replace(/^www\./, '');
    return a.length > 0 && a === b;
  } catch {
    return false;
  }
}

export function tabStateClearsLoading(
  payload: { loading?: boolean; url?: string; title?: string | null },
  pendingUrl: string | null
): boolean {
  if (payload.loading !== false) return false;
  const url = payload.url?.trim();
  if (url && (!pendingUrl || sameSite(url, pendingUrl))) return true;
  const title = payload.title?.trim();
  return Boolean(title && pendingUrl);
}

type BrowserHostEvent = {
  kind?: string;
  tabId?: string;
  sourceTabId?: string;
  url?: string;
  title?: string | null;
  loading?: boolean;
  requestId?: string;
  payload?: {
    tag?: string;
    label?: string;
    text?: string;
    href?: string;
    selector?: string;
    html?: string;
    cancelled?: boolean;
  };
};

interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
  origin?: string | null;
  grant?: { level: string } | null;
}

export function elementChipLabel(payload: BrowserHostEvent['payload']): string {
  const raw = payload?.tag?.trim() || payload?.label?.trim() || 'el';
  const tag =
    raw
      .split(/[.#\s[:]/, 1)[0]
      ?.replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 8) || 'el';
  return `@${tag}`;
}

function insertPickedElement(payload: BrowserHostEvent['payload']) {
  const label = elementChipLabel(payload);
  const markdown =
    [payload?.html, payload?.href, payload?.text, payload?.selector]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join('\n') || label;
  requestComposerTokenInsert({
    label,
    value: formatSessionComposerCommand({
      type: '@',
      key: label,
      value: markdown,
    }),
  });
}

export function HostBrowserPanel({
  pluginId,
  panelVisible,
  requestedUrl,
  panelApi,
}: {
  pluginId: string;
  panelVisible: boolean;
  requestedUrl?: string | null;
  panelApi?: {
    updateParameters: (params: Record<string, unknown>) => void;
    setTitle?: (title: string) => void;
    onDidDimensionsChange?: (cb: () => void) => { dispose: () => void };
    onDidVisibilityChange?: (cb: (event: { isVisible: boolean }) => void) => {
      dispose: () => void;
    };
    group?: {
      api?: {
        onDidDimensionsChange?: (cb: () => void) => { dispose: () => void };
      };
    };
  };
}) {
  const { t } = useTranslation('panels');
  const panelActions = useOptionalPanelActionsContext();
  const overlay = useWorkspaceOverlay();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const openedRequestedUrl = useRef(false);
  const occludedRef = useRef(false);
  const visibleRef = useRef(panelVisible);
  const pickingRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const pendingEventsRef = useRef<BrowserHostEvent[]>([]);
  const applyEventRef = useRef<(payload: BrowserHostEvent) => void>(() => {});
  const addressFocusedRef = useRef(false);
  const dispatchRef = useRef<
    (operation: string, input?: Record<string, unknown>) => Promise<unknown>
  >(async () => undefined);
  const [address, setAddress] = useState('');
  const [tab, setTab] = useState<BrowserTab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [frozen, setFrozen] = useState<string | null>(null);
  const hideSeqRef = useRef(0);
  const warmFreezeRef = useRef<{
    at: number;
    promise: Promise<FreezePayload | null>;
  } | null>(null);

  const dispatch = useCallback(
    async (operation: string, input: Record<string, unknown> = {}) => {
      return backendCall<unknown>('plugin_invoke_contribution', {
        pluginId,
        handler: 'browser.dispatch',
        input: { operation, input },
      });
    },
    [pluginId]
  );
  dispatchRef.current = dispatch;
  visibleRef.current = panelVisible;

  applyEventRef.current = (payload: BrowserHostEvent) => {
    if (payload.kind === 'pick') {
      if (payload.payload?.cancelled) {
        setPicking(false);
        pickingRef.current = false;
        return;
      }
      insertPickedElement(payload.payload);
      return;
    }
    if (payload.kind === 'tab.state') {
      if (tabStateClearsLoading(payload, pendingUrlRef.current)) {
        pendingUrlRef.current = null;
        setLoading(false);
        setError(null);
        const icon = payload.url ? faviconFor(payload.url) : null;
        if (icon) panelApi?.updateParameters({ faviconUrl: icon });
      }
      const pageTitle = payload.title?.trim();
      if (pageTitle) panelApi?.setTitle?.(pageTitle);
    }
    setTab((current) => {
      if (!current || current.tabId !== payload.tabId) return current;
      return {
        ...current,
        url: payload.url || current.url,
        title: payload.title || current.title,
      };
    });
    if (payload.url && !addressFocusedRef.current) setAddress(payload.url);
  };

  const syncBounds = useCallback(async () => {
    const tabId = tabIdRef.current;
    if (!tabId) return;
    const bounds = measureSurface(
      hostRef.current,
      visibleRef.current,
      occludedRef.current
    );
    await dispatchRef.current('surface.set', { tabId, bounds });
  }, []);

  const waitForSurfaceBounds = useCallback(async () => {
    for (let i = 0; i < 12; i += 1) {
      const bounds = measureSurface(
        hostRef.current,
        visibleRef.current,
        occludedRef.current
      );
      if (bounds.visible && bounds.width >= 32 && bounds.height >= 32) {
        return bounds;
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    return measureSurface(
      hostRef.current,
      visibleRef.current,
      occludedRef.current
    );
  }, []);

  const openTab = useCallback(
    async (url: string) => {
      setError(null);
      pendingUrlRef.current = url;
      setLoading(true);
      const label = provisionalTitle(url);
      if (label) panelApi?.setTitle?.(label);
      const icon = faviconFor(url);
      if (icon) panelApi?.updateParameters({ faviconUrl: icon });
      try {
        const bounds = await waitForSurfaceBounds();
        const created = (await dispatch('tab.create', {
          url,
          ...(bounds ? { bounds } : {}),
        })) as BrowserTab;
        tabIdRef.current = created.tabId;
        setTab(created);
        const queued = pendingEventsRef.current;
        pendingEventsRef.current = [];
        for (const event of queued) {
          if (event.tabId === created.tabId) applyEventRef.current(event);
        }
        setAddress(created.url);
        setZoom(DEFAULT_ZOOM);
        void dispatch('tab.zoom', {
          tabId: created.tabId,
          factor: DEFAULT_ZOOM,
        });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        await syncBounds();
      } catch (cause) {
        setLoading(false);
        setError(getInvokeErrorMessage(cause));
      }
    },
    [dispatch, panelApi, syncBounds, waitForSurfaceBounds]
  );

  useLayoutEffect(() => {
    let frame = 0;
    let inFlight = false;
    let queued = false;
    let pushed = '';

    const flush = async () => {
      const tabId = tabIdRef.current;
      if (!tabId) return;
      const bounds = measureSurface(
        hostRef.current,
        visibleRef.current,
        occludedRef.current
      );
      const signature = boundsKey(bounds);
      if (signature === pushed && !queued) return;
      if (inFlight) {
        queued = true;
        return;
      }
      pushed = signature;
      queued = false;
      inFlight = true;
      try {
        await dispatchRef.current('surface.set', { tabId, bounds });
      } finally {
        inFlight = false;
        if (queued) {
          queued = false;
          void flush();
        }
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        void flush();
      });
    };

    const observer = new ResizeObserver(schedule);
    const root = rootRef.current;
    const host = hostRef.current;
    if (root) observer.observe(root);
    if (host) observer.observe(host);
    const parent = root?.parentElement;
    if (parent) observer.observe(parent);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    const disposePanel = panelApi?.onDidDimensionsChange?.(schedule);
    const disposeGroup =
      panelApi?.group?.api?.onDidDimensionsChange?.(schedule);
    const disposeVisibility = panelApi?.onDidVisibilityChange?.((event) => {
      visibleRef.current = event.isVisible;
      schedule();
    });
    const poll = window.setInterval(() => {
      if (document.hidden || !visibleRef.current) return;
      schedule();
    }, 500);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      disposePanel?.dispose();
      disposeGroup?.dispose();
      disposeVisibility?.dispose();
      window.clearInterval(poll);
    };
  }, [error, panelApi, tab?.tabId]);

  useEffect(() => {
    visibleRef.current = panelVisible;
    void syncBounds();
  }, [panelVisible, syncBounds]);

  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setTimeout(() => {
      setLoading(false);
      if (!tabIdRef.current) setError(t('browserPanel.loadFailed'));
    }, 20000);
    return () => window.clearTimeout(timer);
  }, [loading, t]);

  useEffect(() => {
    return overlay.subscribeNativeSurfaceOcclusion((occlusion) => {
      const hide = overlayCoversBrowser(hostRef.current, occlusion);
      if (occludedRef.current === hide) return;
      hideSeqRef.current += 1;
      const seq = hideSeqRef.current;
      if (!hide) {
        occludedRef.current = false;
        void syncBounds().finally(() => {
          if (hideSeqRef.current === seq) setFrozen(null);
        });
        return;
      }
      void (async () => {
        const tabId = tabIdRef.current;
        let frame: FreezePayload | null = null;
        const warm = warmFreezeRef.current;
        warmFreezeRef.current = null;
        if (tabId) {
          try {
            frame =
              warm && Date.now() - warm.at < 800
                ? await warm.promise
                : ((await dispatch('surface.freeze', {
                    tabId,
                  })) as FreezePayload);
          } catch {
            frame = null;
          }
        }
        if (hideSeqRef.current !== seq) return;
        if (frame?.mime && frame.data) {
          const url = `data:${frame.mime};base64,${frame.data}`;
          await decodeFreeze(url);
          if (hideSeqRef.current !== seq) return;
          setFrozen(url);
          await nextPaint();
          if (hideSeqRef.current !== seq) return;
        }
        occludedRef.current = true;
        await syncBounds();
      })();
    });
  }, [dispatch, overlay, syncBounds]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void backendListen<BrowserHostEvent>('plugin.browser', (payload) => {
      if (payload.kind === 'tab.open' && payload.url) {
        panelActions?.openPluginPanel({
          title: t('browserPanel.title'),
          pluginId,
          contributionId: 'browser',
          multiInstance: true,
          instance: 'new',
          requestedUrl: payload.url,
        });
        return;
      }
      if (!tabIdRef.current) {
        pendingEventsRef.current.push(payload);
        return;
      }
      if (payload.tabId !== tabIdRef.current) return;
      applyEventRef.current(payload);
    }).then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [dispatch, panelActions, panelApi, pluginId]);

  useEffect(() => {
    return () => {
      const tabId = tabIdRef.current;
      if (!tabId) return;
      void dispatch('tab.close', { tabId });
    };
  }, [dispatch]);

  useEffect(() => {
    if (openedRequestedUrl.current || tabIdRef.current || !requestedUrl) return;
    const completed = completeBrowserAddress(requestedUrl);
    if (!completed) return;
    openedRequestedUrl.current = true;
    void openTab(completed);
  }, [openTab, requestedUrl]);

  const navigate = () => {
    const url = completeBrowserAddress(address);
    if (!url) {
      toast.error(t('browserPanel.badAddress'));
      return;
    }
    setError(null);
    setAddress(url);
    pendingUrlRef.current = url;
    setLoading(true);
    occludedRef.current = false;
    const label = provisionalTitle(url);
    if (label) panelApi?.setTitle?.(label);
    const icon = faviconFor(url);
    if (icon) panelApi?.updateParameters({ faviconUrl: icon });
    if (!tabIdRef.current) {
      void openTab(url);
      return;
    }
    void dispatch('tab.navigate', { tabId: tabIdRef.current, url }).then(
      async (next) => {
        setTab(next as BrowserTab);
        setAddress((next as BrowserTab).url);
        await syncBounds();
      },
      (cause: unknown) => {
        setLoading(false);
        setError(getInvokeErrorMessage(cause));
      }
    );
  };

  const runTab = (operation: string, input: Record<string, unknown> = {}) => {
    const tabId = tabIdRef.current;
    if (!tabId) return;
    void dispatch(operation, { tabId, ...input }).catch((cause: unknown) =>
      setError(getInvokeErrorMessage(cause))
    );
  };

  const togglePick = () => {
    const tabId = tabIdRef.current;
    if (!tabId) return;
    if (pickingRef.current) {
      pickingRef.current = false;
      setPicking(false);
      void dispatch('pick.cancel', { tabId });
      return;
    }
    pickingRef.current = true;
    setPicking(true);
    void dispatch('pick.start', { tabId }).catch((cause: unknown) => {
      pickingRef.current = false;
      setPicking(false);
      setError(getInvokeErrorMessage(cause));
    });
  };

  useEffect(() => {
    if (!picking) return undefined;
    const poll = window.setInterval(() => {
      const tabId = tabIdRef.current;
      if (!tabId || !pickingRef.current) return;
      void dispatch('pick.take', { tabId }).then((result) => {
        const messages = (result as { messages?: unknown[] })?.messages;
        if (!Array.isArray(messages)) return;
        for (const message of messages) {
          const parsed =
            typeof message === 'string'
              ? (JSON.parse(message) as {
                  kind?: string;
                  payload?: BrowserHostEvent['payload'];
                })
              : (message as {
                  kind?: string;
                  payload?: BrowserHostEvent['payload'];
                });
          if (parsed?.kind !== 'pick') continue;
          if (parsed.payload?.cancelled) {
            pickingRef.current = false;
            setPicking(false);
            return;
          }
          insertPickedElement(parsed.payload);
        }
      });
    }, 80);
    return () => window.clearInterval(poll);
  }, [dispatch, picking]);

  const refreshChrome = useCallback(
    async (tabId: string) => {
      try {
        const chrome = (await dispatch('tab.chrome', { tabId })) as {
          favicon?: string;
          title?: string;
        };
        if (chrome.favicon) {
          panelApi?.updateParameters({ faviconUrl: chrome.favicon });
        }
        const pageTitle = chrome.title?.trim();
        if (pageTitle) panelApi?.setTitle?.(pageTitle);
      } catch {
        /* the page may not be ready to answer yet */
      }
    },
    [dispatch, panelApi]
  );

  useEffect(() => {
    const tabId = tabIdRef.current;
    if (!tabId || loading) return undefined;
    void refreshChrome(tabId);
    return undefined;
  }, [loading, refreshChrome, tab?.tabId, tab?.url]);

  useEffect(() => {
    const tabId = tabIdRef.current;
    if (!loading || !tabId) return undefined;
    let stopped = false;
    let busy = false;
    let timer = 0;
    const provisional = provisionalTitle(tab?.url || '');
    const pull = () => {
      if (stopped || busy) return;
      busy = true;
      void dispatch('tab.title', { tabId })
        .then((result) => {
          if (stopped) return true;
          const pageTitle = (result as { title?: string })?.title?.trim();
          if (!pageTitle) return false;
          panelApi?.setTitle?.(pageTitle);
          return pageTitle !== provisional;
        })
        .catch(() => false)
        .then((done) => {
          busy = false;
          if (done) {
            stopped = true;
            window.clearInterval(timer);
          }
        });
    };
    timer = window.setInterval(pull, 500);
    pull();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [dispatch, loading, panelApi, tab?.tabId, tab?.url]);

  const warmFreeze = () => {
    const tabId = tabIdRef.current;
    if (!tabId || occludedRef.current) return;
    const warm = warmFreezeRef.current;
    if (warm && Date.now() - warm.at < 800) return;
    warmFreezeRef.current = {
      at: Date.now(),
      promise: dispatch('surface.freeze', { tabId }).catch(
        () => null
      ) as Promise<FreezePayload | null>,
    };
  };

  const applyZoom = (factor: number) => {
    setZoom(factor);
    runTab('tab.zoom', { factor });
  };

  const currentUrl = tab?.url || address;

  const copyRequestInfo = () => {
    let host = '';
    try {
      host = new URL(currentUrl).host;
    } catch {
      host = currentUrl;
    }
    const text = `GET ${currentUrl}\nHost: ${host}`;
    void navigator.clipboard.writeText(text).then(() => {
      toast.success(t('browserPanel.copiedRequest'));
    });
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-transparent"
    >
      <div
        role="toolbar"
        className="relative flex h-10 max-h-10 min-h-10 shrink-0 items-center gap-1 overflow-visible bg-[var(--dv-theme-surface,var(--surface-topbar))] px-1.5"
      >
        <button
          type="button"
          className={ICON_BTN}
          title={t('browserPanel.back')}
          aria-label={t('browserPanel.back')}
          disabled={!tab}
          onClick={() => runTab('tab.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          title={t('browserPanel.forward')}
          aria-label={t('browserPanel.forward')}
          disabled={!tab}
          onClick={() => runTab('tab.forward')}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          title={loading ? t('browserPanel.stop') : t('browserPanel.reload')}
          aria-label={
            loading ? t('browserPanel.stop') : t('browserPanel.reload')
          }
          disabled={!tab}
          onClick={() => {
            if (loading) {
              runTab('tab.stop');
              setLoading(false);
              return;
            }
            runTab('tab.reload');
          }}
        >
          {loading ? (
            <X className="h-4 w-4" />
          ) : (
            <RotateCw className="h-4 w-4" />
          )}
        </button>
        <div
          className={cn(
            'mx-1 flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-full border border-border/60 bg-muted/50 px-0.5 backdrop-blur-sm',
            'focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20'
          )}
        >
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              addressFocusedRef.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              addressFocusedRef.current = false;
            }}
            onKeyDown={(event) => {
              if (
                !isBrowserAddressSubmitKey({
                  key: event.key,
                  code: event.code,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                })
              ) {
                return;
              }
              event.preventDefault();
              navigate();
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('browserPanel.addressPlaceholder')}
            aria-label={t('browserPanel.address')}
            className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-xs text-foreground outline-none"
          />
          <button
            type="button"
            className={FIELD_BTN}
            title={t('browserPanel.devtools')}
            aria-label={t('browserPanel.devtools')}
            disabled={!tab}
            onClick={() => runTab('tab.devtools')}
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={cn(
              FIELD_BTN,
              picking && 'text-[hsl(217,91%,60%)] hover:text-[hsl(217,91%,55%)]'
            )}
            title={t('browserPanel.pick')}
            aria-label={t('browserPanel.pick')}
            aria-pressed={picking}
            disabled={!tab}
            onClick={togglePick}
          >
            <MousePointerClick className="h-3.5 w-3.5" />
          </button>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              ref={zoomRef}
              type="button"
              className="flex h-7 shrink-0 items-center justify-center gap-0.5 rounded-full px-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              aria-label={t('browserPanel.zoom')}
              title={t('browserPanel.zoom')}
              disabled={!tab}
              onPointerDown={warmFreeze}
            >
              <Scaling className="h-3.5 w-3.5" />
              {Math.round(zoom * 100)}%
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[20000] min-w-[6.5rem]">
            {ZOOM_PRESETS.map((factor) => (
              <DropdownMenuItem key={factor} onSelect={() => applyZoom(factor)}>
                {Math.round(factor * 100)}%
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              ref={moreRef}
              type="button"
              className={ICON_BTN}
              title={t('browserPanel.more')}
              aria-label={t('browserPanel.more')}
              disabled={!tab}
              onPointerDown={warmFreeze}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[20000] min-w-44">
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard.writeText(currentUrl).then(() => {
                  toast.success(t('browserPanel.copied'));
                });
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              {t('browserPanel.copyUrl')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void open(currentUrl);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('browserPanel.openInSystem')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copyRequestInfo()}>
              <Copy className="h-3.5 w-3.5" />
              {t('browserPanel.copyRequest')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {loading ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
          >
            <div className="h-full w-1/3 animate-[browser-loading_1.2s_ease-in-out_infinite] bg-primary" />
          </div>
        ) : null}
      </div>
      {error && !tab ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--dv-theme-surface,var(--surface-topbar))] px-6 text-center">
          <p className="text-sm font-medium">{error}</p>
          <p className="max-w-md break-all text-xs text-muted-foreground">
            {currentUrl}
          </p>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-primary/8"
            onClick={() => runTab('tab.reload')}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t('browserPanel.reload')}
          </button>
        </div>
      ) : (
        <div
          ref={hostRef}
          className="relative min-h-0 flex-1 bg-[var(--dv-theme-surface,var(--surface-topbar))]"
          data-testid="host-browser-surface"
        >
          {frozen ? (
            <img
              src={frozen}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
