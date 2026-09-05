import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';
import { browserApi } from './browserApi';
import {
  isCancelledBrowserError,
  type BrowserLoadErrorInfo,
} from './chromiumNetError';
import { BrowserLoadError } from './BrowserLoadError';
import { reclaimBrowserTab, retainBrowserTab } from './browserTabRetention';
import {
  BLANK_PAGE,
  browserUrlsEquivalent,
  normalizeBrowserUrl,
} from './browserUrl';
import { BrowserDevToolsSession } from './devToolsSession';
import { applyDevicePreset, type DevicePresetId } from './deviceEmulation';
import { createFrameScheduler, type FrameScheduler } from './frameScheduler';
import type { OpenInEditorPayload } from './inspectTypes';
import type {
  BrowserEvent,
  BrowserIntent,
  BrowserProfile,
  BrowserSurface,
  BrowserTab,
} from './browserTypes';

export const DEFAULT_BROWSER_ZOOM_PERCENT = 80;
export { normalizeBrowserUrl } from './browserUrl';
const ZOOM_PERCENTAGES = [50, 80, 90, 100, 110, 125, 150] as const;
const INSPECT_HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: true,
  showAccessibilityInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.35 },
  borderColor: { r: 79, g: 140, b: 201, a: 0.9 },
};

interface BrowserPanelProps {
  initialUrl: string | null;
  requestNonce: number;
  workspaceId?: string;
  /** Stable Dockview panel id used to keep the CEF tab across host remounts. */
  panelId?: string;
  visible: boolean;
  layoutVersion?: number;
  className?: string;
  onTitleChange?: (title: string) => void;
  onFaviconChange?: (faviconUrl: string | null) => void;
  onLocationChange?: (url: string) => void;
  onInspectElement?: (element: OpenInEditorPayload) => void;
  onOpenExternalTab?: (url: string) => void;
}

interface DescribedNode {
  attributes?: string[];
  backendNodeId?: number;
  localName?: string;
  nodeName?: string;
}

interface HorizontalPageScroll {
  contentWidth: number;
  viewportWidth: number;
  pageX: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringAttributes(attributes: unknown): Record<string, string> {
  if (!Array.isArray(attributes)) return {};
  const result: Record<string, string> = {};
  for (let index = 0; index < attributes.length; index += 2) {
    const name = attributes[index];
    const value = attributes[index + 1];
    if (typeof name === 'string' && typeof value === 'string') {
      result[name] = value;
    }
  }
  return result;
}

function horizontalPageScrollMetrics(
  result: unknown
): HorizontalPageScroll | null {
  const metrics = objectValue(result);
  const content = objectValue(metrics?.cssContentSize);
  const viewport = objectValue(metrics?.cssLayoutViewport);
  const contentWidth = content?.width;
  const viewportWidth = viewport?.clientWidth;
  const pageX = viewport?.pageX;
  if (
    typeof contentWidth !== 'number' ||
    typeof viewportWidth !== 'number' ||
    typeof pageX !== 'number' ||
    contentWidth <= viewportWidth + 1
  ) {
    return null;
  }
  return {
    contentWidth,
    viewportWidth,
    pageX: Math.max(0, Math.min(pageX, contentWidth - viewportWidth)),
  };
}

async function describeInspectedElement(
  session: BrowserDevToolsSession,
  params: unknown
): Promise<OpenInEditorPayload | null> {
  const backendNodeId = objectValue(params)?.backendNodeId;
  if (typeof backendNodeId !== 'number') return null;

  const description = objectValue(
    await session.execute('DOM.describeNode', { backendNodeId })
  );
  const node = objectValue(description?.node) as DescribedNode | null;
  if (!node) return null;
  const resolvedBackendNodeId = node.backendNodeId ?? backendNodeId;
  const outerHtmlResult = objectValue(
    await session.execute('DOM.getOuterHTML', {
      backendNodeId: resolvedBackendNodeId,
    })
  );
  const outerHTML =
    typeof outerHtmlResult?.outerHTML === 'string'
      ? outerHtmlResult.outerHTML
      : '';
  const attributes = stringAttributes(node.attributes);
  const tag = (node.localName || node.nodeName || 'element').toLowerCase();

  return {
    selected: {
      editor: '',
      url: '',
      name: tag,
      props: {},
      source: { fileName: '', lineNumber: 1, columnNumber: 1 },
      pathToSource: '',
    },
    components: [],
    trigger: 'alt-click',
    clickedElement: {
      tag,
      id: attributes.id,
      className: attributes.class,
      role: attributes.role,
      dataset: outerHTML ? { preview: outerHTML } : undefined,
    },
  };
}

function surfacesEqual(left: BrowserSurface, right: BrowserSurface): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.scaleFactor === right.scaleFactor &&
    left.visible === right.visible
  );
}

function clippedSurfaceRect(
  surface: DOMRect,
  panel: DOMRect,
  toolbar: DOMRect
) {
  const left = Math.max(surface.left, panel.left);
  const top = Math.max(surface.top, panel.top, toolbar.bottom);
  const right = Math.min(surface.right, panel.right);
  const bottom = Math.min(surface.bottom, panel.bottom);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function browserProfile(workspaceId?: string): BrowserProfile {
  return workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'global' };
}

function browserAddress(url: string): string {
  return url === BLANK_PAGE ? '' : url;
}

function zoomLevelForPercent(percent: number): number {
  return Math.log(percent / 100) / Math.log(1.2);
}

function zoomPercentForLevel(level: number): number {
  const percent = 100 * Math.pow(1.2, level);
  return ZOOM_PERCENTAGES.reduce((nearest, candidate) =>
    Math.abs(candidate - percent) < Math.abs(nearest - percent)
      ? candidate
      : nearest
  );
}

function isStaleNavigationUpdate(
  tabUrl: string,
  pendingUrl: string | null,
  originUrl: string | null
): boolean {
  return (
    pendingUrl != null &&
    originUrl != null &&
    browserUrlsEquivalent(tabUrl, originUrl)
  );
}

function commandErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'The Chromium browser process could not complete this request.';
}

export function BrowserPanel({
  initialUrl,
  requestNonce,
  workspaceId,
  panelId,
  visible,
  layoutVersion,
  className,
  onTitleChange,
  onFaviconChange,
  onLocationChange,
  onInspectElement,
  onOpenExternalTab,
}: BrowserPanelProps) {
  const { t } = useTranslation('panels');
  const { subscribeNativeSurfaceOcclusion } = useWorkspaceOverlay();
  const panelElementRef = useRef<HTMLDivElement>(null);
  const toolbarElementRef = useRef<HTMLDivElement>(null);
  const surfaceElementRef = useRef<HTMLDivElement>(null);
  const surfaceSchedulerRef = useRef<FrameScheduler | null>(null);
  const currentSurfaceRef = useRef<BrowserSurface | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const devToolsSessionRef = useRef<BrowserDevToolsSession | null>(null);
  const editingAddressRef = useRef(false);
  const intersectionVisibleRef = useRef(true);
  const panelVisibleRef = useRef(visible);
  const overlayOccludedRef = useRef(false);
  const surfaceBlockedRef = useRef(false);
  const blankPageVisibleRef = useRef(initialUrl === null);
  const onInspectElementRef = useRef(onInspectElement);
  const onOpenExternalTabRef = useRef(onOpenExternalTab);
  const onLocationChangeRef = useRef(onLocationChange);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const horizontalScrollbarRef = useRef<HTMLDivElement>(null);
  const desiredPageXRef = useRef(0);
  const scrollCommandInFlightRef = useRef(false);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [showBlankPage, setShowBlankPage] = useState(initialUrl === null);
  const [tabBootstrapUrl, setTabBootstrapUrl] = useState(initialUrl);
  const [tab, setTab] = useState<BrowserTab | null>(null);
  const [address, setAddress] = useState(initialUrl ?? '');
  const [loadError, setLoadError] = useState<BrowserLoadErrorInfo | null>(null);
  const pendingNavigationUrlRef = useRef<string | null>(null);
  const navigationOriginUrlRef = useRef<string | null>(null);
  const lastRequestNonceRef = useRef(requestNonce);
  const selectAllOnFocusRef = useRef(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [horizontalPageScroll, setHorizontalPageScroll] =
    useState<HorizontalPageScroll | null>(null);
  const [devicePreset, setDevicePreset] = useState<DevicePresetId>('desktop');
  const [permissionRequest, setPermissionRequest] = useState<
    Extract<BrowserEvent, { type: 'permissionRequested' }> | undefined
  >();
  const [downloads, setDownloads] = useState<
    Extract<BrowserEvent, { type: 'downloadUpdated' }>[]
  >([]);
  const requestToken = `${requestNonce}\u0000${initialUrl ?? ''}`;
  const lastRequestTokenRef = useRef(requestToken);
  const requestTokenRef = useRef(requestToken);
  requestTokenRef.current = requestToken;

  const showError = useCallback((message: string, code = '') => {
    surfaceBlockedRef.current = true;
    setLoadError({ message, code });
    surfaceSchedulerRef.current?.request();
  }, []);

  const clearError = useCallback(() => {
    surfaceBlockedRef.current = false;
    setLoadError(null);
    surfaceSchedulerRef.current?.request();
  }, []);

  const updateBlankPageVisibility = useCallback((nextVisible: boolean) => {
    blankPageVisibleRef.current = nextVisible;
    setShowBlankPage(nextVisible);
    surfaceSchedulerRef.current?.request();
  }, []);

  const applyIntent = useCallback(
    (intent: BrowserIntent) => {
      const tabId = tabIdRef.current;
      if (!tabId) return;
      void browserApi.applyIntent(tabId, intent).catch((error: unknown) => {
        showError(commandErrorMessage(error));
      });
    },
    [showError]
  );

  const nativeSurfaceShouldBeVisible = useCallback((showPage: boolean) => {
    return (
      showPage &&
      panelVisibleRef.current &&
      intersectionVisibleRef.current &&
      !overlayOccludedRef.current &&
      !surfaceBlockedRef.current &&
      document.visibilityState !== 'hidden'
    );
  }, []);

  const hideNativeSurfaces = useCallback(
    (tabId = tabIdRef.current) => {
      const currentSurface = currentSurfaceRef.current;
      if (!currentSurface?.visible) return;

      const hiddenSurface = { ...currentSurface, visible: false };
      currentSurfaceRef.current = hiddenSurface;
      if (!tabId) return;
      void Promise.resolve(
        browserApi.applyIntent(tabId, {
          type: 'setSurface',
          surface: hiddenSurface,
        })
      ).catch((error: unknown) => showError(commandErrorMessage(error)));
    },
    [showError]
  );

  const attachDevToolsSession = useCallback(
    (tabId: string) => {
      devToolsSessionRef.current?.dispose();
      setHorizontalPageScroll(null);
      const session = new BrowserDevToolsSession(tabId, (intent) =>
        browserApi.applyIntent(tabId, intent)
      );
      session.on('Overlay.inspectNodeRequested', (params) => {
        void describeInspectedElement(session, params)
          .then((element) => {
            if (element) onInspectElementRef.current?.(element);
            setIsInspecting(false);
          })
          .catch((error: unknown) => {
            setIsInspecting(false);
            showError(commandErrorMessage(error));
          });
      });
      devToolsSessionRef.current = session;
    },
    [showError]
  );

  const refreshHorizontalPageScroll = useCallback(() => {
    const session = devToolsSessionRef.current;
    if (!session) return;
    void session
      .execute('Page.getLayoutMetrics')
      .then((result) => {
        const metrics = horizontalPageScrollMetrics(result);
        desiredPageXRef.current = metrics?.pageX ?? 0;
        setHorizontalPageScroll(metrics);
      })
      .catch(() => {
        setHorizontalPageScroll(null);
      });
  }, []);

  const scrollPageHorizontally = useCallback((pageX: number) => {
    desiredPageXRef.current = Math.max(0, Math.round(pageX));
    setHorizontalPageScroll((current) =>
      current ? { ...current, pageX: desiredPageXRef.current } : current
    );
    if (scrollCommandInFlightRef.current) return;

    const flush = () => {
      const session = devToolsSessionRef.current;
      if (!session) return;
      const target = desiredPageXRef.current;
      scrollCommandInFlightRef.current = true;
      void session
        .execute('Runtime.evaluate', {
          expression: `window.scrollTo(${target}, window.scrollY)`,
          returnByValue: false,
        })
        .catch(() => undefined)
        .finally(() => {
          scrollCommandInFlightRef.current = false;
          if (desiredPageXRef.current !== target) flush();
        });
    };

    flush();
  }, []);

  useEffect(() => {
    onInspectElementRef.current = onInspectElement;
  }, [onInspectElement]);

  useEffect(() => {
    onOpenExternalTabRef.current = onOpenExternalTab;
  }, [onOpenExternalTab]);

  useEffect(() => {
    onLocationChangeRef.current = onLocationChange;
  }, [onLocationChange]);

  useEffect(() => {
    if (!initialUrl || tabIdRef.current || tabBootstrapUrl) return;
    lastRequestTokenRef.current = requestToken;
    updateBlankPageVisibility(false);
    setTabBootstrapUrl(initialUrl);
  }, [initialUrl, requestToken, tabBootstrapUrl, updateBlankPageVisibility]);

  useEffect(() => {
    if (!surfaceReady || tabBootstrapUrl || tabIdRef.current) return;
    updateBlankPageVisibility(true);
    requestAnimationFrame(() => addressInputRef.current?.focus());
  }, [surfaceReady, tabBootstrapUrl, updateBlankPageVisibility]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const syncSurface = useCallback(() => {
    const element = surfaceElementRef.current;
    const panelElement = panelElementRef.current;
    const toolbarElement = toolbarElementRef.current;
    if (!element || !panelElement || !toolbarElement) return;

    const rect = clippedSurfaceRect(
      element.getBoundingClientRect(),
      panelElement.getBoundingClientRect(),
      toolbarElement.getBoundingClientRect()
    );
    const previous = currentSurfaceRef.current;
    const hasSize = rect.width >= 1 && rect.height >= 1;
    if (!hasSize && !previous) return;

    const surface: BrowserSurface = {
      x: hasSize ? Math.round(rect.left) : (previous?.x ?? 0),
      y: hasSize ? Math.round(rect.top) : (previous?.y ?? 0),
      width: hasSize ? Math.round(rect.width) : (previous?.width ?? 1),
      height: hasSize ? Math.round(rect.height) : (previous?.height ?? 1),
      scaleFactor: window.devicePixelRatio || 1,
      visible:
        hasSize && nativeSurfaceShouldBeVisible(!blankPageVisibleRef.current),
    };

    if (previous && surfacesEqual(previous, surface)) return;
    currentSurfaceRef.current = surface;
    if (!previous) setSurfaceReady(true);
    if (tabIdRef.current) {
      applyIntent({ type: 'setSurface', surface });
    }
  }, [applyIntent, nativeSurfaceShouldBeVisible]);

  useLayoutEffect(() => {
    const element = surfaceElementRef.current;
    const panelElement = panelElementRef.current;
    const toolbarElement = toolbarElementRef.current;
    if (!element || !panelElement || !toolbarElement) return;

    const scheduler = createFrameScheduler(syncSurface);
    surfaceSchedulerRef.current = scheduler;
    const scheduleSurfaceSync = () => scheduler.request();
    const resizeObserver = new ResizeObserver(scheduleSurfaceSync);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersectionVisibleRef.current = entry?.isIntersecting ?? false;
      scheduleSurfaceSync();
    });
    resizeObserver.observe(element);
    resizeObserver.observe(panelElement);
    resizeObserver.observe(toolbarElement);
    intersectionObserver.observe(element);
    window.addEventListener('resize', scheduleSurfaceSync);
    window.addEventListener('scroll', scheduleSurfaceSync, {
      capture: true,
      passive: true,
    });
    document.addEventListener('visibilitychange', scheduleSurfaceSync);
    scheduleSurfaceSync();

    return () => {
      scheduler.cancel();
      if (surfaceSchedulerRef.current === scheduler) {
        surfaceSchedulerRef.current = null;
      }
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener('resize', scheduleSurfaceSync);
      window.removeEventListener('scroll', scheduleSurfaceSync, true);
      document.removeEventListener('visibilitychange', scheduleSurfaceSync);
    };
  }, [syncSurface]);

  useLayoutEffect(() => {
    panelVisibleRef.current = visible;
    if (!visible) {
      surfaceSchedulerRef.current?.cancel();
      hideNativeSurfaces();
      return;
    }
    surfaceSchedulerRef.current?.request();
  }, [hideNativeSurfaces, layoutVersion, visible]);

  useLayoutEffect(
    () =>
      subscribeNativeSurfaceOcclusion((occluded) => {
        overlayOccludedRef.current = occluded;
        if (occluded) {
          surfaceSchedulerRef.current?.cancel();
          hideNativeSurfaces();
          return;
        }
        surfaceSchedulerRef.current?.request();
      }),
    [hideNativeSurfaces, subscribeNativeSurfaceOcclusion]
  );

  useEffect(() => {
    if (!surfaceReady || !currentSurfaceRef.current) return;
    const reclaimed = panelId ? reclaimBrowserTab(panelId) : null;
    if (!reclaimed && !tabBootstrapUrl) return;

    let disposed = false;
    let createdTabId: string | null = null;
    let latestTab: BrowserTab | null = reclaimed;
    let unlisten: (() => void) | undefined;
    const pendingEvents: BrowserEvent[] = [];
    const pendingPopupTabIds = new Set<string>();

    const openPopupExternally = (popupTab: BrowserTab) => {
      pendingPopupTabIds.delete(popupTab.id);
      void browserApi.closeTab(popupTab.id);
      onOpenExternalTabRef.current?.(popupTab.url);
    };

    const bindTab = (nextTab: BrowserTab, showPage: boolean) => {
      latestTab = nextTab;
      createdTabId = nextTab.id;
      tabIdRef.current = nextTab.id;
      attachDevToolsSession(nextTab.id);
      setTab(nextTab);
      updateBlankPageVisibility(!showPage);
      setAddress(browserAddress(nextTab.url === BLANK_PAGE ? '' : nextTab.url));
      onTitleChange?.(nextTab.title);
      onFaviconChange?.(nextTab.faviconUrl);
      onLocationChangeRef.current?.(nextTab.url);
    };

    const acceptEvent = (event: BrowserEvent) => {
      if (!createdTabId) {
        if (pendingEvents.length < 32) pendingEvents.push(event);
        return;
      }
      if (event.type === 'popupCreated') {
        if (event.openerTabId !== createdTabId) return;
        if (event.tab.url === BLANK_PAGE) {
          pendingPopupTabIds.add(event.tab.id);
        } else {
          openPopupExternally(event.tab);
        }
        return;
      }
      if (
        (event.type === 'tabUpdated' || event.type === 'tabFailed') &&
        pendingPopupTabIds.has(event.tab.id)
      ) {
        if (event.tab.url !== BLANK_PAGE) openPopupExternally(event.tab);
        return;
      }
      const eventTabId =
        event.type === 'tabCreated' ||
        event.type === 'tabUpdated' ||
        event.type === 'tabFailed'
          ? event.tab.id
          : event.tabId;
      if (eventTabId !== createdTabId) return;

      if (event.type === 'devToolsResult' || event.type === 'devToolsEvent') {
        devToolsSessionRef.current?.receive(event);
        return;
      }
      if (event.type === 'permissionRequested') {
        setPermissionRequest(event);
        return;
      }
      if (event.type === 'downloadUpdated') {
        setDownloads((current) => {
          const next = current.filter(
            (download) =>
              download.tabId !== event.tabId ||
              download.downloadId !== event.downloadId
          );
          return [...next, event].slice(-5);
        });
        return;
      }
      if (event.type === 'tabClosed') {
        setPermissionRequest((request) =>
          request?.tabId === event.tabId ? undefined : request
        );
        setDownloads((current) =>
          current.filter((download) => download.tabId !== event.tabId)
        );
        devToolsSessionRef.current?.dispose();
        devToolsSessionRef.current = null;
        tabIdRef.current = null;
        latestTab = null;
        setTab(null);
        return;
      }
      if (tabIdRef.current === event.tab.id) {
        if (event.type === 'tabFailed') {
          if (isCancelledBrowserError(event.code, event.message)) return;
          if (
            isStaleNavigationUpdate(
              event.tab.url,
              pendingNavigationUrlRef.current,
              navigationOriginUrlRef.current
            )
          ) {
            return;
          }
          pendingNavigationUrlRef.current = null;
          navigationOriginUrlRef.current = null;
          latestTab = event.tab;
          setTab(event.tab);
          showError(event.message, event.code);
          return;
        }
        latestTab = event.tab;
        const stale = isStaleNavigationUpdate(
          event.tab.url,
          pendingNavigationUrlRef.current,
          navigationOriginUrlRef.current
        );
        updateBlankPageVisibility(event.tab.url === BLANK_PAGE);
        setTab(event.tab);
        if (!stale) {
          if (
            pendingNavigationUrlRef.current &&
            (!event.tab.loading ||
              browserUrlsEquivalent(
                event.tab.url,
                pendingNavigationUrlRef.current
              ))
          ) {
            pendingNavigationUrlRef.current = null;
            navigationOriginUrlRef.current = null;
          }
          if (!editingAddressRef.current)
            setAddress(browserAddress(event.tab.url));
          onLocationChangeRef.current?.(event.tab.url);
          if (!event.tab.loading && event.tab.url !== BLANK_PAGE) {
            clearError();
          }
        }
        onTitleChange?.(event.tab.title);
        onFaviconChange?.(event.tab.faviconUrl);
        if (event.tab.loading) setHorizontalPageScroll(null);
        else refreshHorizontalPageScroll();
      }
    };

    void (async () => {
      try {
        unlisten = await browserApi.listen(acceptEvent);
        if (disposed) {
          unlisten();
          return;
        }

        const applyNativeSurface = async (tabId: string, showPage: boolean) => {
          const current = currentSurfaceRef.current;
          if (!current) return;
          const surface = {
            ...current,
            visible: nativeSurfaceShouldBeVisible(showPage),
          };
          currentSurfaceRef.current = surface;
          await browserApi.applyIntent(tabId, {
            type: 'setSurface',
            surface,
          });
        };

        if (reclaimed) {
          bindTab(reclaimed, reclaimed.url !== BLANK_PAGE);
          lastRequestTokenRef.current = requestTokenRef.current;
          await applyNativeSurface(reclaimed.id, reclaimed.url !== BLANK_PAGE);
          pendingEvents.splice(0).forEach(acceptEvent);
          return;
        }

        const requestedUrl = normalizeBrowserUrl(tabBootstrapUrl!);
        const createdTab = await browserApi.createTab({
          initialUrl: requestedUrl,
          profile: browserProfile(workspaceId),
          surface: { ...currentSurfaceRef.current!, visible: false },
        });
        createdTabId = createdTab.id;
        latestTab = createdTab;
        if (disposed) {
          await browserApi.closeTab(createdTab.id);
          return;
        }
        const defaultZoom = zoomLevelForPercent(DEFAULT_BROWSER_ZOOM_PERCENT);
        bindTab(
          { ...createdTab, zoomLevel: defaultZoom },
          requestedUrl !== BLANK_PAGE
        );
        const showPage = requestedUrl !== BLANK_PAGE;
        if (showPage && createdTab.url === BLANK_PAGE) {
          await browserApi.applyIntent(createdTab.id, {
            type: 'navigate',
            url: requestedUrl,
          });
        }
        await browserApi.applyIntent(createdTab.id, {
          type: 'setZoom',
          level: defaultZoom,
        });
        await applyNativeSurface(createdTab.id, showPage);
        if (!showPage) {
          requestAnimationFrame(() => addressInputRef.current?.focus());
        }
        pendingEvents.splice(0).forEach(acceptEvent);
      } catch (error) {
        if (!disposed) showError(commandErrorMessage(error));
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      devToolsSessionRef.current?.dispose();
      devToolsSessionRef.current = null;
      if (createdTabId) {
        hideNativeSurfaces(createdTabId);
      }
      tabIdRef.current = null;
      if (createdTabId && latestTab && panelId) {
        retainBrowserTab(panelId, latestTab, (tabId) => {
          void browserApi.closeTab(tabId);
        });
      } else if (createdTabId) {
        void browserApi.closeTab(createdTabId);
      }
      for (const popupTabId of pendingPopupTabIds) {
        void browserApi.closeTab(popupTabId);
      }
    };
  }, [
    attachDevToolsSession,
    clearError,
    hideNativeSurfaces,
    nativeSurfaceShouldBeVisible,
    onTitleChange,
    onFaviconChange,
    panelId,
    refreshHorizontalPageScroll,
    showError,
    surfaceReady,
    tabBootstrapUrl,
    updateBlankPageVisibility,
    workspaceId,
  ]);

  useEffect(() => {
    if (!tab || !initialUrl) return;
    if (requestNonce === lastRequestNonceRef.current) return;
    lastRequestNonceRef.current = requestNonce;
    lastRequestTokenRef.current = requestToken;
    const url = normalizeBrowserUrl(initialUrl);
    if (browserUrlsEquivalent(url, tab.url)) return;
    navigationOriginUrlRef.current = tab.url;
    pendingNavigationUrlRef.current = url;
    updateBlankPageVisibility(url === BLANK_PAGE);
    setAddress(url);
    applyIntent({ type: 'navigate', url });
  }, [
    applyIntent,
    initialUrl,
    requestNonce,
    requestToken,
    tab,
    updateBlankPageVisibility,
  ]);

  useLayoutEffect(() => {
    const scrollbar = horizontalScrollbarRef.current;
    if (!scrollbar || !horizontalPageScroll) return;
    if (Math.abs(scrollbar.scrollLeft - horizontalPageScroll.pageX) > 1) {
      scrollbar.scrollLeft = horizontalPageScroll.pageX;
    }
  }, [horizontalPageScroll]);

  const hasHorizontalPageScroll = horizontalPageScroll !== null;
  useEffect(() => {
    if (layoutVersion == null || !hasHorizontalPageScroll) return;
    refreshHorizontalPageScroll();
  }, [hasHorizontalPageScroll, layoutVersion, refreshHorizontalPageScroll]);

  const navigate = () => {
    const url = normalizeBrowserUrl(address);
    editingAddressRef.current = false;
    clearError();
    updateBlankPageVisibility(url === BLANK_PAGE);
    setAddress(url);
    lastRequestTokenRef.current = `${requestNonce}\u0000${url}`;
    lastRequestNonceRef.current = requestNonce;
    onLocationChangeRef.current?.(url);
    if (!tab) {
      if (url === BLANK_PAGE) {
        requestAnimationFrame(() => addressInputRef.current?.focus());
        return;
      }
      setTabBootstrapUrl(url);
      return;
    }
    navigationOriginUrlRef.current = tab.url;
    pendingNavigationUrlRef.current = url;
    applyIntent({ type: 'navigate', url });
  };

  const stopElementInspection = () => {
    const session = devToolsSessionRef.current;
    setIsInspecting(false);
    if (!session) return Promise.resolve();
    return session.execute('Overlay.setInspectMode', {
      mode: 'none',
      highlightConfig: INSPECT_HIGHLIGHT_CONFIG,
    });
  };

  const toggleElementInspection = () => {
    const session = devToolsSessionRef.current;
    if (!session) return;
    if (isInspecting) {
      void stopElementInspection().catch((error: unknown) =>
        showError(commandErrorMessage(error))
      );
      return;
    }

    clearError();
    void (async () => {
      await session.execute('DOM.enable');
      await session.execute('Overlay.enable');
      await session.execute('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: INSPECT_HIGHLIGHT_CONFIG,
      });
      setIsInspecting(true);
    })().catch((error: unknown) => {
      setIsInspecting(false);
      showError(commandErrorMessage(error));
    });
  };

  const reloadOrStop = () => {
    if (tab?.loading) {
      applyIntent({ type: 'stop' });
      return;
    }
    if (!isInspecting) {
      applyIntent({ type: 'reload' });
      return;
    }
    void stopElementInspection()
      .then(() => applyIntent({ type: 'reload' }))
      .catch((error: unknown) => showError(commandErrorMessage(error)));
  };

  const runFind = (forward: boolean, findNext: boolean) => {
    if (!findQuery) return;
    applyIntent({
      type: 'find',
      query: findQuery,
      forward,
      matchCase: false,
      findNext,
    });
  };

  const closeFind = () => {
    setFindOpen(false);
    applyIntent({ type: 'stopFinding' });
  };

  const changeDevicePreset = (preset: DevicePresetId) => {
    const session = devToolsSessionRef.current;
    if (!session) return;
    setDevicePreset(preset);
    clearError();
    void applyDevicePreset(session, preset).catch((error: unknown) => {
      showError(commandErrorMessage(error));
    });
  };

  const retryFailedLoad = () => {
    const url = normalizeBrowserUrl(address);
    clearError();
    if (url === BLANK_PAGE) {
      applyIntent({ type: 'reload' });
      return;
    }
    navigationOriginUrlRef.current = tab?.url ?? null;
    pendingNavigationUrlRef.current = url;
    applyIntent({ type: 'navigate', url });
  };

  const loading = tab?.loading ?? (tabBootstrapUrl !== null && !loadError);

  return (
    <div
      ref={panelElementRef}
      data-testid="browser-panel-root"
      className={cn(
        'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background',
        className
      )}
    >
      <div
        ref={toolbarElementRef}
        role="toolbar"
        aria-label="Browser controls"
        className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-muted/40 px-1.5"
      >
        <Button
          aria-label="Back"
          title="Back"
          variant="icon"
          size="icon"
          className="h-7 w-7"
          disabled={!tab?.canGoBack}
          onClick={() => applyIntent({ type: 'back' })}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Forward"
          title="Forward"
          variant="icon"
          size="icon"
          className="h-7 w-7"
          disabled={!tab?.canGoForward}
          onClick={() => applyIntent({ type: 'forward' })}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          aria-label={tab?.loading ? 'Stop' : 'Reload'}
          title={tab?.loading ? 'Stop' : 'Reload'}
          variant="icon"
          size="icon"
          className="h-7 w-7"
          disabled={!tab}
          onClick={reloadOrStop}
        >
          {tab?.loading ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>

        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            navigate();
          }}
        >
          <input
            ref={addressInputRef}
            aria-label="Address"
            value={address}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onFocus={() => {
              editingAddressRef.current = true;
              selectAllOnFocusRef.current = true;
              requestAnimationFrame(() => addressInputRef.current?.select());
            }}
            onMouseUp={(event) => {
              if (!selectAllOnFocusRef.current) return;
              selectAllOnFocusRef.current = false;
              event.preventDefault();
              event.currentTarget.select();
            }}
            onBlur={() => {
              editingAddressRef.current = false;
              selectAllOnFocusRef.current = false;
            }}
            onChange={(event) => setAddress(event.target.value)}
            className="h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary/70 focus:ring-1 focus:ring-primary/30"
            placeholder="Enter a URL"
          />
        </form>

        <AstryxSelect
          ariaLabel="Zoom"
          value={String(
            zoomPercentForLevel(
              tab?.zoomLevel ??
                zoomLevelForPercent(DEFAULT_BROWSER_ZOOM_PERCENT)
            )
          )}
          disabled={!tab}
          options={ZOOM_PERCENTAGES.map((percent) => ({
            value: String(percent),
            label: `${percent}%`,
          }))}
          onChange={(value) =>
            applyIntent({
              type: 'setZoom',
              level: zoomLevelForPercent(Number(value)),
            })
          }
          size="compact"
          className="w-20 shrink-0"
        />
        <AstryxSelect
          ariaLabel="Device emulation"
          value={devicePreset}
          disabled={!tab}
          options={[
            { value: 'desktop', label: 'Desktop' },
            { value: 'tablet', label: 'Tablet' },
            { value: 'mobile', label: 'Mobile' },
          ]}
          onChange={(value) => changeDevicePreset(value as DevicePresetId)}
          size="compact"
          className="w-24 shrink-0"
        />
        <Button
          aria-label="Find in Page"
          title="Find in Page"
          variant="icon"
          size="icon"
          className="h-7 w-7"
          disabled={!tab}
          onClick={() => {
            setFindOpen(true);
            requestAnimationFrame(() => findInputRef.current?.focus());
          }}
        >
          <Search className="h-3.5 w-3.5" />
        </Button>

        <Button
          aria-label="Select Element"
          aria-pressed={isInspecting}
          title="Select Element"
          variant="icon"
          size="icon"
          className={cn('h-7 w-7', isInspecting && 'bg-accent text-foreground')}
          disabled={!tab || !onInspectElement}
          onClick={toggleElementInspection}
        >
          <Crosshair className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-label="Developer Tools"
          title="Developer Tools"
          variant="icon"
          size="icon"
          className="h-7 w-7"
          disabled={!tab}
          onClick={() => applyIntent({ type: 'openDevTools' })}
        >
          <Bug className="h-3.5 w-3.5" />
        </Button>
      </div>

      {findOpen && (
        <form
          className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-muted/30 px-2"
          onSubmit={(event) => {
            event.preventDefault();
            runFind(true, false);
          }}
        >
          <input
            ref={findInputRef}
            aria-label="Find in Page"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            className="h-7 w-56 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/70"
          />
          <Button
            type="button"
            aria-label="Previous Match"
            title="Previous Match"
            variant="icon"
            size="icon"
            className="h-7 w-7"
            onClick={() => runFind(false, true)}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            aria-label="Next Match"
            title="Next Match"
            variant="icon"
            size="icon"
            className="h-7 w-7"
            onClick={() => runFind(true, true)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            aria-label="Close Find"
            title="Close Find"
            variant="icon"
            size="icon"
            className="h-7 w-7"
            onClick={closeFind}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </form>
      )}

      {permissionRequest && permissionRequest.tabId === tab?.id && (
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-3 text-xs text-foreground">
          <span className="min-w-0 flex-1 truncate">
            {permissionRequest.origin || 'This page'} wants{' '}
            {permissionRequest.kind === 'media' ? 'media' : 'browser'} access.
          </span>
          <Button
            type="button"
            aria-label="Deny Permission"
            variant="secondary"
            size="sm"
            className="h-7"
            onClick={() => {
              void browserApi.applyIntent(permissionRequest.tabId, {
                type: 'resolvePermission',
                requestId: permissionRequest.requestId,
                allow: false,
              });
              setPermissionRequest(undefined);
            }}
          >
            Deny
          </Button>
          <Button
            type="button"
            aria-label="Allow Permission"
            size="sm"
            className="h-7"
            onClick={() => {
              void browserApi.applyIntent(permissionRequest.tabId, {
                type: 'resolvePermission',
                requestId: permissionRequest.requestId,
                allow: true,
              });
              setPermissionRequest(undefined);
            }}
          >
            Allow
          </Button>
        </div>
      )}

      {downloads
        .filter((download) => download.tabId === tab?.id)
        .map((download) => (
          <div
            key={download.downloadId}
            className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 text-xs text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">
              {download.fileName || download.url}{' '}
              {download.percentComplete >= 0
                ? `${download.percentComplete}%`
                : `${download.receivedBytes} bytes`}
            </span>
            {download.state === 'inProgress' ? (
              <Button
                type="button"
                aria-label="Cancel Download"
                variant="secondary"
                size="sm"
                className="h-7"
                onClick={() =>
                  void browserApi.applyIntent(download.tabId, {
                    type: 'cancelDownload',
                    downloadId: download.downloadId,
                  })
                }
              >
                Cancel
              </Button>
            ) : (
              <button
                type="button"
                aria-label="Dismiss Download"
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
                onClick={() =>
                  setDownloads((current) =>
                    current.filter(
                      (candidate) =>
                        candidate.tabId !== download.tabId ||
                        candidate.downloadId !== download.downloadId
                    )
                  )
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}

      <div className="relative min-h-0 flex-1">
        <div
          ref={surfaceElementRef}
          data-testid="native-browser-surface"
          aria-busy={loading}
          aria-hidden={showBlankPage || !!loadError ? 'true' : undefined}
          className="absolute inset-0 bg-background"
          onPointerDown={() => applyIntent({ type: 'focus' })}
        />
        {!tab && !loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
            <LoaderCircle
              className="h-5 w-5 animate-spin"
              aria-label="Loading browser"
            />
          </div>
        )}
        {showBlankPage && !loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background px-8 text-center">
            <div className="flex -translate-y-6 flex-col items-center">
              <Globe2
                className="mb-5 h-11 w-11 stroke-[1.5] text-muted-foreground"
                aria-hidden="true"
              />
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
                {t('webPreviewPanel.emptyTitle')}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('webPreviewPanel.emptyDescription')}
              </p>
            </div>
          </div>
        )}
        {loadError && (
          <BrowserLoadError error={loadError} onRetry={retryFailedLoad} />
        )}
      </div>
      {horizontalPageScroll ? (
        <div
          ref={horizontalScrollbarRef}
          role="scrollbar"
          aria-label="Horizontal page scroll"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(
            horizontalPageScroll.contentWidth -
              horizontalPageScroll.viewportWidth
          )}
          aria-valuenow={Math.round(horizontalPageScroll.pageX)}
          tabIndex={0}
          className="h-3 shrink-0 overflow-x-scroll overflow-y-hidden bg-background"
          onScroll={(event) =>
            scrollPageHorizontally(event.currentTarget.scrollLeft)
          }
        >
          <div
            className="h-px"
            style={{
              width: `${Math.ceil(horizontalPageScroll.contentWidth)}px`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
