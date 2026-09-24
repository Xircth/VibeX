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
  Camera,
  Check,
  Copy,
  ExternalLink,
  Monitor,
  MoreVertical,
  MousePointerClick,
  RotateCw,
  Scaling,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import {
  NativeSurfaceOcclusionHold,
  useWorkspaceOverlay,
} from '@/contexts/WorkspaceOverlayContext';
import { overlayCoversSurface } from '@/lib/nativeSurfaceOverlay';
import { requestBrowserTabOpen } from './openBrowserTab';
import { backendCall, backendListen } from '@/lib/backendTransport';
import { getInvokeErrorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { open } from '@tauri-apps/plugin-shell';
import {
  requestComposerImageInsert,
  requestComposerTokenInsert,
} from '@/lib/composerInsert';
import { formatSessionComposerCommand } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import {
  completeBrowserAddress,
  isBrowserAddressSubmitKey,
  shouldApplyNavigatedAddress,
} from './completeAddress';
import {
  loadBrowserAddressHistory,
  recordBrowserAddressVisit,
  saveBrowserAddressHistory,
  suggestBrowserAddresses,
  type BrowserAddressHistoryEntry,
  type BrowserAddressSuggestion,
} from './addressSuggestions';
import { fileFromPickedFrame } from './pickHandoff';
import {
  BrowserAgentActivityControl,
  BrowserAgentShareControl,
} from './BrowserAgentAccess';
import { BrowserFindBar } from './BrowserFindBar';
import {
  BrowserDownloadBar,
  BrowserNoticeBar,
} from './BrowserStatusLayer';
import { clearAgentActivity } from './browserChromeStore';
import {
  faviconForPage,
  prefetchFavicon,
  rememberCachedFavicon,
} from './faviconCache';
import {
  browserPanelSurfaceKey,
  forgetBrowserSurface,
  hiddenBrowserBounds,
  projectLayoutStillHasBrowserPanel,
  recallBrowserSurface,
  rememberBrowserSurface,
} from './browserPanelLifetime';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { snapBrowserSurfaceRect } from './browserSurfaceBounds';

const ICON_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const FIELD_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const CONNECTED_CHROME_BG =
  'bg-[var(--dv-connected-chrome,var(--surface-dialog))]';
const ZOOM_PRESETS = [0.3, 0.5, 0.75, 1, 1.25, 1.5] as const;
const DEFAULT_ZOOM = 0.75;
const DEVICE_PRESETS = ['desktop', 'tablet', 'phone'] as const;
type BrowserDevice = (typeof DEVICE_PRESETS)[number];
const DEFAULT_DEVICE: BrowserDevice = 'desktop';

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
  const scale = window.devicePixelRatio || 1;
  const snapped = snapBrowserSurfaceRect(rect, scale);
  const laidOut = snapped.width >= 2 && snapped.height >= 2;
  return {
    ...snapped,
    scale,
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
  return overlayCoversSurface(
    {
      x: surface.left,
      y: surface.top,
      width: surface.width,
      height: surface.height,
    },
    occlusion.rects
  );
}

function boundsKey(bounds: SurfaceBounds): string {
  return `${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}:${bounds.visible}`;
}

type FreezePayload = { mime?: string | null; data?: string | null };

/** Longest a hide waits on decode or the next paint. A hide that never
 *  issues leaves the native page sitting over the overlay that asked for it
 *  (Codeg `FREEZE_PAINT_TIMEOUT_MS`). */
const FREEZE_PAINT_TIMEOUT_MS = 100;

function bounded(work: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, FREEZE_PAINT_TIMEOUT_MS);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

async function decodeFreeze(url: string): Promise<void> {
  if (typeof Image === 'undefined') return;
  try {
    const image = new Image();
    image.src = url;
    if (typeof image.decode === 'function') await bounded(image.decode());
  } catch {
    /* paint it cold */
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, FREEZE_PAINT_TIMEOUT_MS);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve();
      })
    );
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
  return faviconForPage(url);
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
  if (!url) return false;
  return !pendingUrl || sameSite(url, pendingUrl);
}

type BrowserHostEvent = {
  kind?: string;
  tabId?: string;
  sourceTabId?: string;
  url?: string;
  title?: string | null;
  favicon?: string | null;
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
    rect?: { x: number; y: number; width: number; height: number };
    viewport?: { width: number; height: number; dpr?: number };
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

async function insertPickedElementWithImage(
  payload: BrowserHostEvent['payload'],
  capture: () => Promise<FreezePayload | null>
) {
  insertPickedElement(payload);
  await nextPaint();
  const file = await fileFromPickedFrame(await capture(), {
    rect: payload?.rect,
    viewport: payload?.viewport,
    tag: payload?.tag,
  });
  if (file) requestComposerImageInsert(file);
}

export function HostBrowserPanel({
  pluginId,
  panelVisible,
  requestedUrl,
  nativeTabId,
  panelApi,
}: {
  pluginId: string;
  panelVisible: boolean;
  requestedUrl?: string | null;
  nativeTabId?: string | null;
  panelApi?: {
    id?: string;
    updateParameters: (params: Record<string, unknown>) => void;
    setTitle?: (title: string) => void;
    onDidDimensionsChange?: (cb: () => void) => { dispose: () => void };
    onDidVisibilityChange?: (cb: (event: { isVisible: boolean }) => void) => {
      dispose: () => void;
    };
    group?: {
      element?: HTMLElement;
      api?: {
        onDidDimensionsChange?: (cb: () => void) => { dispose: () => void };
      };
    };
  };
}) {
  const { t } = useTranslation('panels');
  const overlay = useWorkspaceOverlay();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const openedRequestedUrl = useRef(false);
  const projectKey = useLayoutStore((state) => state.currentProjectKey);
  const projectKeyRef = useRef(projectKey);
  projectKeyRef.current = projectKey;
  const panelId = panelApi?.id ?? '';
  const occludedRef = useRef(false);
  const visibleRef = useRef(panelVisible);
  const panelVisibleRef = useRef(panelVisible);
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
  const [findOpen, setFindOpen] = useState(false);
  const [findToken, setFindToken] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [device, setDevice] = useState<BrowserDevice>(DEFAULT_DEVICE);
  const [frozen, setFrozen] = useState<string | null>(null);
  const [addressHistory, setAddressHistory] = useState<
    BrowserAddressHistoryEntry[]
  >(() => loadBrowserAddressHistory());
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const addressDirtyRef = useRef(false);
  const suggestions = suggestBrowserAddresses(address, addressHistory);
  const hideSeqRef = useRef(0);

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
  panelVisibleRef.current = panelVisible;
  visibleRef.current = panelVisible;

  applyEventRef.current = (payload: BrowserHostEvent) => {
    if (payload.kind === 'pick') {
      if (payload.payload?.cancelled) {
        setPicking(false);
        pickingRef.current = false;
        return;
      }
      if (!pickingRef.current) return;
      pickingRef.current = false;
      setPicking(false);
      const tabId = tabIdRef.current;
      void (async () => {
        if (tabId) {
          await dispatchRef.current('pick.cancel', { tabId });
        }
        await insertPickedElementWithImage(payload.payload, () =>
          tabId
            ? (dispatchRef.current('surface.freeze', {
                tabId,
              }) as Promise<FreezePayload | null>)
            : Promise.resolve(null)
        );
      })();
      return;
    }
    if (payload.kind === 'tab.state') {
      if (payload.loading === true) setLoading(true);
      if (tabStateClearsLoading(payload, pendingUrlRef.current)) {
        pendingUrlRef.current = null;
        setLoading(false);
        setError(null);
      }
    }
    if (payload.kind === 'tab.state' || payload.kind === 'tab.chrome') {
      if (payload.url) {
        const icon = payload.favicon?.trim() || faviconFor(payload.url);
        const hostTitle = provisionalTitle(payload.url);
        const tabId = tabIdRef.current;
        if (payload.favicon?.trim()) {
          rememberCachedFavicon(payload.url, payload.favicon);
        }
        prefetchFavicon(icon);
        panelApi?.updateParameters({
          ...(icon ? { faviconUrl: icon } : {}),
          requestedUrl: payload.url,
          nativeTabId: tabId,
        });
        if (hostTitle) {
          panelApi?.setTitle?.(hostTitle);
        }
        if (tabId && panelId) {
          rememberBrowserSurface(
            browserPanelSurfaceKey(projectKeyRef.current, panelId),
            { tabId, url: payload.url }
          );
        }
        if (
          shouldApplyNavigatedAddress({
            engineUrl: payload.url,
            addressFocused: addressFocusedRef.current,
            addressDirty: addressDirtyRef.current,
          })
        ) {
          setAddress(payload.url);
          addressDirtyRef.current = false;
        }
        if (payload.kind === 'tab.state' && payload.loading === false) {
          setAddressHistory((current) => {
            const next = recordBrowserAddressVisit(
              {
                url: payload.url || '',
                title: payload.title,
                favicon: icon,
              },
              current
            );
            saveBrowserAddressHistory(next);
            return next;
          });
        }
      }
      const pageTitle = payload.title?.trim();
      const titleIsStale =
        Boolean(pendingUrlRef.current) && !payload.url?.trim();
      if (pageTitle && !titleIsStale) panelApi?.setTitle?.(pageTitle);
    }
    setTab((current) => {
      if (!current || current.tabId !== payload.tabId) return current;
      return {
        ...current,
        url: payload.url || current.url,
        title: payload.title || current.title,
      };
    });
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
      prefetchFavicon(icon);
      if (icon) panelApi?.updateParameters({ faviconUrl: icon });
      try {
        const bounds = await waitForSurfaceBounds();
        const created = (await dispatch('tab.create', {
          url,
          grant: 'control',
          ...(bounds ? { bounds } : {}),
        })) as BrowserTab;
        tabIdRef.current = created.tabId;
        setCanGoBack(false);
        setTab(created);
        panelApi?.updateParameters({
          requestedUrl: url,
          nativeTabId: created.tabId,
        });
        if (panelId) {
          rememberBrowserSurface(
            browserPanelSurfaceKey(projectKeyRef.current, panelId),
            { tabId: created.tabId, url }
          );
        }
        setAddress(created.url);
        addressDirtyRef.current = false;
        const queued = pendingEventsRef.current;
        pendingEventsRef.current = [];
        for (const event of queued) {
          if (event.tabId === created.tabId) applyEventRef.current(event);
        }
        setZoom(DEFAULT_ZOOM);
        setDevice(DEFAULT_DEVICE);
        void dispatch('tab.zoom', {
          tabId: created.tabId,
          factor: DEFAULT_ZOOM,
        });
        void dispatch('tab.device', {
          tabId: created.tabId,
          device: DEFAULT_DEVICE,
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
    [dispatch, panelApi, panelId, syncBounds, waitForSurfaceBounds]
  );

  useLayoutEffect(() => {
    let scheduled = false;
    let inFlight = 0;
    let queued = false;
    let pushed = '';

    const flush = () => {
      const tabId = tabIdRef.current;
      if (!tabId) return;
      const bounds = measureSurface(
        hostRef.current,
        visibleRef.current,
        occludedRef.current
      );
      const signature = boundsKey(bounds);
      if (signature === pushed && !queued) return;
      if (inFlight >= 2) {
        queued = true;
        return;
      }
      pushed = signature;
      queued = false;
      inFlight += 1;
      void dispatchRef.current('surface.set', { tabId, bounds }).finally(() => {
        inFlight = Math.max(0, inFlight - 1);
        if (queued) {
          queued = false;
          flush();
        }
      });
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        flush();
      });
    };

    const observer = new ResizeObserver(schedule);
    const root = rootRef.current;
    const host = hostRef.current;
    if (root) observer.observe(root);
    if (host) observer.observe(host);
    const parent = root?.parentElement;
    if (parent) observer.observe(parent);
    const groupEl = panelApi?.group?.element;
    if (groupEl) observer.observe(groupEl);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    const disposePanel = panelApi?.onDidDimensionsChange?.(schedule);
    const disposeGroup =
      panelApi?.group?.api?.onDidDimensionsChange?.(schedule);
    const disposeVisibility = panelApi?.onDidVisibilityChange?.((event) => {
      visibleRef.current = event.isVisible && panelVisibleRef.current;
      schedule();
    });
    const poll = window.setInterval(() => {
      if (document.hidden || !visibleRef.current) return;
      schedule();
    }, 500);
    schedule();
    return () => {
      scheduled = false;
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      disposePanel?.dispose();
      disposeGroup?.dispose();
      disposeVisibility?.dispose();
      window.clearInterval(poll);
    };
  }, [error, panelApi, tab?.tabId]);

  useLayoutEffect(() => {
    panelVisibleRef.current = panelVisible;
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

  useLayoutEffect(() => overlay.registerNativeSurfaceHost(), [overlay]);

  useLayoutEffect(() => {
    return overlay.subscribeNativeSurfaceOcclusion((occlusion) => {
      const hide = overlayCoversBrowser(hostRef.current, occlusion);
      if (occludedRef.current === hide) {
        overlay.ackOverlayReady();
        return;
      }
      hideSeqRef.current += 1;
      const seq = hideSeqRef.current;
      if (!hide) {
        occludedRef.current = false;
        void syncBounds().finally(() => {
          if (hideSeqRef.current === seq) setFrozen(null);
          overlay.ackOverlayReady();
        });
        return;
      }
      occludedRef.current = true;
      void syncBounds().finally(() => overlay.ackOverlayReady());
    });
  }, [overlay, syncBounds]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void backendListen<BrowserHostEvent>('plugin.browser', (payload) => {
      if (payload.kind === 'tab.open') {
        const source = payload.sourceTabId;
        if (source && tabIdRef.current && source !== tabIdRef.current) {
          return;
        }
        requestBrowserTabOpen({
          url: payload.url,
          nativeTabId: payload.tabId,
          sourceTabId: payload.sourceTabId,
        });
        return;
      }
      if (!tabIdRef.current) {
        pendingEventsRef.current.push(payload);
        return;
      }
      const eventTabId =
        payload.tabId || (payload as { tab_id?: string }).tab_id;
      if (eventTabId && eventTabId !== tabIdRef.current) return;
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
  }, []);

  useEffect(() => {
    return () => {
      const tabId = tabIdRef.current;
      if (!tabId) return;
      const layoutState = useLayoutStore.getState();
      const keep =
        Boolean(panelId) &&
        projectLayoutStillHasBrowserPanel(
          layoutState,
          projectKeyRef.current,
          panelId
        );
      if (keep) {
        void dispatch('surface.set', {
          tabId,
          bounds: hiddenBrowserBounds(),
        });
        window.setTimeout(() => {
          const later = useLayoutStore.getState();
          if (
            projectLayoutStillHasBrowserPanel(
              later,
              projectKeyRef.current,
              panelId
            )
          ) {
            return;
          }
          forgetBrowserSurface(
            browserPanelSurfaceKey(projectKeyRef.current, panelId)
          );
          void dispatch('tab.close', { tabId });
        }, 50);
        return;
      }
      if (panelId) {
        forgetBrowserSurface(
          browserPanelSurfaceKey(projectKeyRef.current, panelId)
        );
      }
      void dispatch('tab.close', { tabId });
    };
  }, [dispatch, panelId]);

  useEffect(() => {
    if (openedRequestedUrl.current || tabIdRef.current) return;
    const key = panelId ? browserPanelSurfaceKey(projectKey, panelId) : '';
    const remembered = key ? recallBrowserSurface(key) : undefined;
    const existingId = nativeTabId || remembered?.tabId || null;
    const existingUrl =
      completeBrowserAddress(requestedUrl || remembered?.url || '') ||
      remembered?.url ||
      null;
    if (existingId) {
      openedRequestedUrl.current = true;
      tabIdRef.current = existingId;
      setTab({
        tabId: existingId,
        url: existingUrl || 'about:blank',
        title: existingUrl
          ? provisionalTitle(existingUrl) || 'Browser'
          : 'Browser',
      });
      if (existingUrl) setAddress(existingUrl);
      void (async () => {
        try {
          const listed = (await dispatch('tab.list')) as {
            tabs?: BrowserTab[];
          };
          const found = listed.tabs?.find((item) => item.tabId === existingId);
          if (found) {
            setTab(found);
            if (found.url) setAddress(found.url);
          }
          const bounds = await waitForSurfaceBounds();
          await dispatch('surface.set', { tabId: existingId, bounds });
        } catch {
          tabIdRef.current = null;
          if (existingUrl) void openTab(existingUrl);
        }
      })();
      return;
    }
    if (!existingUrl) return;
    openedRequestedUrl.current = true;
    void openTab(existingUrl);
  }, [
    dispatch,
    nativeTabId,
    openTab,
    panelId,
    projectKey,
    requestedUrl,
    waitForSurfaceBounds,
  ]);

  const chooseSuggestion = (suggestion: BrowserAddressSuggestion) => {
    setAddress(suggestion.url);
    setSuggestOpen(false);
    setSuggestIndex(0);
    const url = completeBrowserAddress(suggestion.url);
    if (!url) {
      toast.error(t('browserPanel.badAddress'));
      return;
    }
    goToUrl(url);
  };

  const goToUrl = (url: string) => {
    setSuggestOpen(false);
    setError(null);
    addressDirtyRef.current = false;
    setAddress(url);
    pendingUrlRef.current = url;
    setLoading(true);
    occludedRef.current = false;
    const label = provisionalTitle(url);
    if (label) panelApi?.setTitle?.(label);
    const icon = faviconFor(url);
    prefetchFavicon(icon);
    if (icon) panelApi?.updateParameters({ faviconUrl: icon });
    if (!tabIdRef.current) {
      void openTab(url);
      return;
    }
    void dispatch('tab.navigate', { tabId: tabIdRef.current, url }).then(
      async (next) => {
        setTab(next as BrowserTab);
        setAddress((next as BrowserTab).url);
        setCanGoBack(true);
        clearAgentActivity(tabIdRef.current || '');
        await syncBounds();
      },
      (cause: unknown) => {
        setLoading(false);
        setError(getInvokeErrorMessage(cause));
      }
    );
  };

  const navigate = () => {
    const chosen =
      suggestOpen && suggestions[suggestIndex]
        ? suggestions[suggestIndex].url
        : address;
    const url = completeBrowserAddress(chosen);
    if (!url) {
      toast.error(t('browserPanel.badAddress'));
      return;
    }
    goToUrl(url);
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
          if (!pickingRef.current) return;
          pickingRef.current = false;
          setPicking(false);
          void (async () => {
            await dispatch('pick.cancel', { tabId });
            await insertPickedElementWithImage(
              parsed.payload,
              () =>
                dispatch('surface.freeze', {
                  tabId,
                }) as Promise<FreezePayload | null>
            );
          })();
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
          url?: string;
        };
        const pageUrl = chrome.url?.trim();
        if (
          pageUrl &&
          shouldApplyNavigatedAddress({
            engineUrl: pageUrl,
            addressFocused: addressFocusedRef.current,
            addressDirty: addressDirtyRef.current,
          })
        ) {
          setAddress(pageUrl);
          addressDirtyRef.current = false;
          const hostTitle = provisionalTitle(pageUrl);
          if (hostTitle && !chrome.title?.trim())
            panelApi?.setTitle?.(hostTitle);
          panelApi?.updateParameters({
            requestedUrl: pageUrl,
            nativeTabId: tabId,
            ...(chrome.favicon ? { faviconUrl: chrome.favicon } : {}),
          });
        }
        if (chrome.favicon) {
          prefetchFavicon(chrome.favicon);
          if (pageUrl) rememberCachedFavicon(pageUrl, chrome.favicon);
          panelApi?.updateParameters({ faviconUrl: chrome.favicon });
        }
        const pageTitle = chrome.title?.trim();
        if (pageTitle) panelApi?.setTitle?.(pageTitle);
        return Boolean(pageTitle && chrome.favicon);
      } catch {
        return false;
      }
    },
    [dispatch, panelApi]
  );

  useEffect(() => {
    const tabId = tabIdRef.current;
    if (!tabId) return undefined;
    let stopped = false;
    let busy = false;
    let timer = 0;
    const pull = () => {
      if (stopped || busy) return;
      busy = true;
      void refreshChrome(tabId).then((done) => {
        if (stopped) return;
        busy = false;
        if (done) {
          stopped = true;
          window.clearInterval(timer);
        }
      });
    };
    pull();
    timer = window.setInterval(pull, 120);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [loading, refreshChrome, tab?.tabId, tab?.url]);

  const revealSurface = () => {
    hideSeqRef.current += 1;
    occludedRef.current = false;
    setFrozen(null);
    void syncBounds();
  };

  const applyZoom = (factor: number) => {
    setZoom(factor);
    runTab('tab.zoom', { factor });
  };

  const applyDevice = (next: BrowserDevice) => {
    setDevice(next);
    runTab('tab.device', { device: next });
  };

  const deviceLabel = (value: BrowserDevice) =>
    t(
      value === 'phone'
        ? 'browserPanel.devicePhone'
        : value === 'tablet'
          ? 'browserPanel.deviceTablet'
          : 'browserPanel.deviceDesktop'
    );

  const DeviceIcon =
    device === 'phone' ? Smartphone : device === 'tablet' ? Tablet : Monitor;

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
      className={cn(
        'flex h-full min-h-0 w-full min-w-0 flex-col',
        CONNECTED_CHROME_BG
      )}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          setFindOpen(true);
          setFindToken((token) => token + 1);
        }
      }}
    >
      <div
        role="toolbar"
        className={cn(
          'relative flex h-10 max-h-10 min-h-10 shrink-0 items-center gap-1 overflow-visible px-1.5',
          CONNECTED_CHROME_BG
        )}
      >
        <button
          type="button"
          className={ICON_BTN}
          title={t('browserPanel.back')}
          aria-label={t('browserPanel.back')}
          disabled={!tab || !canGoBack}
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
              revealSurface();
              runTab('tab.stop');
              setLoading(false);
              return;
            }
            revealSurface();
            runTab('tab.reload');
          }}
        >
          {loading ? (
            <X className="h-4 w-4" />
          ) : (
            <RotateCw className="h-4 w-4" />
          )}
        </button>
        <div className="relative mx-1 min-w-0 flex-1">
          <div
            className={cn(
              'flex h-7 min-w-0 items-center gap-0.5 rounded-full border border-border/60 bg-muted/50 px-0.5 backdrop-blur-sm',
              'focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20'
            )}
          >
            <input
              value={address}
              onChange={(event) => {
                addressDirtyRef.current = true;
                setAddress(event.target.value);
                setSuggestIndex(0);
                setSuggestOpen(true);
              }}
              onFocus={(event) => {
                addressFocusedRef.current = true;
                event.currentTarget.select();
                setSuggestOpen(true);
              }}
              onBlur={() => {
                addressFocusedRef.current = false;
                addressDirtyRef.current = false;
                window.setTimeout(() => setSuggestOpen(false), 120);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && suggestions.length > 0) {
                  event.preventDefault();
                  setSuggestOpen(true);
                  setSuggestIndex((index) => (index + 1) % suggestions.length);
                  return;
                }
                if (event.key === 'ArrowUp' && suggestions.length > 0) {
                  event.preventDefault();
                  setSuggestOpen(true);
                  setSuggestIndex(
                    (index) =>
                      (index - 1 + suggestions.length) % suggestions.length
                  );
                  return;
                }
                if (event.key === 'Escape') {
                  setSuggestOpen(false);
                  return;
                }
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
              role="combobox"
              aria-expanded={suggestOpen && suggestions.length > 0}
              aria-controls="host-browser-address-suggestions"
              placeholder={t('browserPanel.addressPlaceholder')}
              aria-label={t('browserPanel.address')}
              className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-xs text-foreground outline-none"
            />
            <BrowserAgentActivityControl tabId={tab?.tabId ?? null} />
            <button
              type="button"
              className={FIELD_BTN}
              title={t('browserPanel.screenshot')}
              aria-label={t('browserPanel.screenshot')}
              disabled={!tab}
              onClick={() => {
                const tabId = tabIdRef.current;
                if (!tabId) return;
                void (dispatch('surface.freeze', { tabId }) as Promise<FreezePayload | null>)
                  .then(async (frame) => {
                    if (!frame?.mime || !frame.data) return;
                    const blob = await fetch(
                      `data:${frame.mime};base64,${frame.data}`
                    ).then((response) => response.blob());
                    requestComposerImageInsert(
                      new File([blob], 'page.jpg', { type: frame.mime })
                    );
                  });
              }}
            >
              <Camera className="h-3.5 w-3.5" />
            </button>
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
                picking &&
                  'text-[hsl(217,91%,60%)] hover:text-[hsl(217,91%,55%)]'
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
          {suggestOpen && suggestions.length > 0 ? (
            <div className="absolute inset-x-0 top-[calc(100%+6px)] z-[20000] overflow-hidden rounded-[14px] border border-border/60 bg-[var(--surface-dialog)] py-1 shadow-[0_18px_42px_hsl(220_36%_8%_/_0.2)]">
              <NativeSurfaceOcclusionHold />
              <ul
                id="host-browser-address-suggestions"
                role="listbox"
                aria-label={t('browserPanel.addressSuggestions')}
              >
                {suggestions.map((suggestion, index) => (
                  <li
                    key={`${suggestion.kind}:${suggestion.url}`}
                    role="presentation"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === suggestIndex}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                        index === suggestIndex
                          ? 'bg-[var(--surface-control-hover)]'
                          : 'hover:bg-[var(--surface-control-hover)]'
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setSuggestIndex(index)}
                      onClick={() => chooseSuggestion(suggestion)}
                    >
                      {suggestion.favicon ? (
                        <img
                          src={suggestion.favicon}
                          alt=""
                          className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
                          onError={(event) => {
                            event.currentTarget.style.visibility = 'hidden';
                          }}
                        />
                      ) : (
                        <span className="h-4 w-4 shrink-0 rounded-[3px] bg-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {suggestion.title}
                      </span>
                      <span className="max-w-[42%] shrink-0 truncate text-[0.625rem] leading-[0.875rem] text-muted-foreground">
                        {suggestion.url
                          .replace(/^https?:\/\//, '')
                          .replace(/\/$/, '')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <BrowserAgentShareControl
          origin={tab?.origin || tab?.url}
          grant={tab?.grant}
          disabled={!tab}
          onShare={(level) => {
            const tabId = tabIdRef.current;
            if (!tabId) return;
            void dispatch('grant.set', { tabId, level }).then((next) => {
              setTab(next as BrowserTab);
            });
          }}
        />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              ref={moreRef}
              type="button"
              className={ICON_BTN}
              title={t('browserPanel.more')}
              aria-label={t('browserPanel.more')}
              disabled={!tab}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="top"
            className="z-[20000] min-w-44"
          >
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Scaling className="h-3.5 w-3.5" />
                {t('browserPanel.zoom')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                side="left"
                className="z-[20000] min-w-[7rem]"
              >
                {ZOOM_PRESETS.map((factor) => (
                  <DropdownMenuItem
                    key={factor}
                    onSelect={() => applyZoom(factor)}
                  >
                    {zoom === factor ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <span className="h-3.5 w-3.5" />
                    )}
                    {Math.round(factor * 100)}%
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <DeviceIcon className="h-3.5 w-3.5" />
                {t('browserPanel.device')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                side="left"
                className="z-[20000] min-w-[8rem]"
              >
                {DEVICE_PRESETS.map((preset) => (
                  <DropdownMenuItem
                    key={preset}
                    onSelect={() => applyDevice(preset)}
                  >
                    {device === preset ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <span className="h-3.5 w-3.5" />
                    )}
                    {deviceLabel(preset)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
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
      <BrowserFindBar
        open={findOpen}
        focusToken={findToken}
        onClose={() => setFindOpen(false)}
        onFind={async (query, forward) => {
          const tabId = tabIdRef.current;
          if (!tabId) return true;
          const result = (await dispatch('tab.find', {
            tabId,
            query,
            forward,
          })) as { found?: boolean };
          return result.found !== false;
        }}
      />
      <BrowserNoticeBar tabId={tab?.tabId ?? null} />
      <BrowserDownloadBar tabId={tab?.tabId ?? null} />
      {error && !tab ? (
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center',
            CONNECTED_CHROME_BG
          )}
        >
          <p className="text-sm font-medium">{error}</p>
          <p className="max-w-md break-all text-xs text-muted-foreground">
            {currentUrl}
          </p>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-primary/8"
            onClick={() => {
              revealSurface();
              runTab('tab.reload');
            }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t('browserPanel.reload')}
          </button>
        </div>
      ) : (
        <div
          ref={hostRef}
          className={cn(
            'relative min-h-0 flex-1',
            // Keep the native child inside the tab: dock sashes sit on the
            // panel edge (1px line, 4px handle) and a HWND paints over them.
            'mx-[2px] mb-[2px]',
            CONNECTED_CHROME_BG
          )}
          data-testid="host-browser-surface"
        >
          {frozen ? (
            <img
              src={frozen}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-left-top"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
