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
  LoaderCircle,
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { browserApi } from './browserApi';
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

const BLANK_PAGE = 'about:blank';

interface BrowserPanelProps {
  initialUrl: string | null;
  requestNonce: number;
  workspaceId?: string;
  visible: boolean;
  layoutVersion?: number;
  className?: string;
  onTitleChange?: (title: string) => void;
  onInspectElement?: (element: OpenInEditorPayload) => void;
}

interface DescribedNode {
  attributes?: string[];
  backendNodeId?: number;
  localName?: string;
  nodeName?: string;
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

function browserProfile(workspaceId?: string): BrowserProfile {
  return workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'global' };
}

export function normalizeBrowserUrl(value: string): string {
  const target = value.trim();
  if (!target) return BLANK_PAGE;
  if (
    /^(https?|file):\/\//i.test(target) ||
    /^(about|data|view-source):/i.test(target)
  ) {
    return target;
  }

  const localHost =
    /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/#?]|$)/i;
  return `${localHost.test(target) ? 'http' : 'https'}://${target}`;
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
  visible,
  layoutVersion,
  className,
  onTitleChange,
  onInspectElement,
}: BrowserPanelProps) {
  const surfaceElementRef = useRef<HTMLDivElement>(null);
  const surfaceSchedulerRef = useRef<FrameScheduler | null>(null);
  const currentSurfaceRef = useRef<BrowserSurface | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const knownTabIdsRef = useRef(new Set<string>());
  const tabsRef = useRef<BrowserTab[]>([]);
  const devToolsSessionRef = useRef<BrowserDevToolsSession | null>(null);
  const editingAddressRef = useRef(false);
  const intersectionVisibleRef = useRef(true);
  const panelVisibleRef = useRef(visible);
  const surfaceBlockedRef = useRef(false);
  const onInspectElementRef = useRef(onInspectElement);
  const initialUrlRef = useRef(initialUrl);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [tab, setTab] = useState<BrowserTab | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [address, setAddress] = useState(initialUrl ?? '');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [devicePreset, setDevicePreset] = useState<DevicePresetId>('desktop');
  const [permissionRequest, setPermissionRequest] = useState<
    Extract<BrowserEvent, { type: 'permissionRequested' }> | undefined
  >();
  const [downloads, setDownloads] = useState<
    Extract<BrowserEvent, { type: 'downloadUpdated' }>[]
  >([]);
  const requestToken = `${requestNonce}\u0000${initialUrl ?? ''}`;
  const lastRequestTokenRef = useRef(requestToken);

  const showError = useCallback((message: string) => {
    surfaceBlockedRef.current = true;
    setErrorMessage(message);
    surfaceSchedulerRef.current?.request();
  }, []);

  const clearError = useCallback(() => {
    surfaceBlockedRef.current = false;
    setErrorMessage(null);
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

  const attachDevToolsSession = useCallback(
    (tabId: string) => {
      devToolsSessionRef.current?.dispose();
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

  const activateTab = useCallback(
    (nextTab: BrowserTab) => {
      const previousTabId = tabIdRef.current;
      const surface = currentSurfaceRef.current;
      if (surface && previousTabId && previousTabId !== nextTab.id) {
        void browserApi
          .applyIntent(previousTabId, {
            type: 'setSurface',
            surface: { ...surface, visible: false },
          })
          .catch((error: unknown) => showError(commandErrorMessage(error)));
      }
      if (surface && previousTabId !== nextTab.id) {
        void browserApi
          .applyIntent(nextTab.id, { type: 'setSurface', surface })
          .catch((error: unknown) => showError(commandErrorMessage(error)));
      }
      tabIdRef.current = nextTab.id;
      attachDevToolsSession(nextTab.id);
      setTab(nextTab);
      setAddress(nextTab.url);
      onTitleChange?.(nextTab.title);
    },
    [attachDevToolsSession, onTitleChange, showError]
  );

  useEffect(() => {
    onInspectElementRef.current = onInspectElement;
  }, [onInspectElement]);

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
    if (!element) return;

    const rect = element.getBoundingClientRect();
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
        hasSize &&
        panelVisibleRef.current &&
        intersectionVisibleRef.current &&
        !surfaceBlockedRef.current &&
        document.visibilityState !== 'hidden',
    };

    if (previous && surfacesEqual(previous, surface)) return;
    currentSurfaceRef.current = surface;
    if (!previous) setSurfaceReady(true);
    if (tabIdRef.current) {
      applyIntent({ type: 'setSurface', surface });
    }
  }, [applyIntent]);

  useLayoutEffect(() => {
    const element = surfaceElementRef.current;
    if (!element) return;

    const scheduler = createFrameScheduler(syncSurface);
    surfaceSchedulerRef.current = scheduler;
    const scheduleSurfaceSync = () => scheduler.request();
    const resizeObserver = new ResizeObserver(scheduleSurfaceSync);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersectionVisibleRef.current = entry?.isIntersecting ?? false;
      scheduleSurfaceSync();
    });
    resizeObserver.observe(element);
    intersectionObserver.observe(element);
    window.addEventListener('resize', scheduleSurfaceSync);
    window.addEventListener('scroll', scheduleSurfaceSync, true);
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
    surfaceSchedulerRef.current?.request();
  }, [layoutVersion, syncSurface, visible]);

  useEffect(() => {
    if (!surfaceReady || !currentSurfaceRef.current) return;

    let disposed = false;
    let createdTabId: string | null = null;
    let unlisten: (() => void) | undefined;
    const pendingEvents: BrowserEvent[] = [];
    const ownedTabIds = knownTabIdsRef.current;

    const acceptEvent = (event: BrowserEvent) => {
      if (!createdTabId) {
        if (pendingEvents.length < 32) pendingEvents.push(event);
        return;
      }
      if (event.type === 'popupCreated') {
        if (!ownedTabIds.has(event.openerTabId)) return;
        ownedTabIds.add(event.tab.id);
        tabsRef.current = [...tabsRef.current, event.tab];
        setTabs(tabsRef.current);
        activateTab(event.tab);
        return;
      }
      const eventTabId =
        event.type === 'tabCreated' ||
        event.type === 'tabUpdated' ||
        event.type === 'tabFailed'
          ? event.tab.id
          : event.tabId;
      if (!ownedTabIds.has(eventTabId)) return;

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
        ownedTabIds.delete(event.tabId);
        const remainingTabs = tabsRef.current.filter(
          (candidate) => candidate.id !== event.tabId
        );
        tabsRef.current = remainingTabs;
        setTabs(remainingTabs);
        setPermissionRequest((request) =>
          request?.tabId === event.tabId ? undefined : request
        );
        setDownloads((current) =>
          current.filter((download) => download.tabId !== event.tabId)
        );
        if (tabIdRef.current === event.tabId) {
          devToolsSessionRef.current?.dispose();
          devToolsSessionRef.current = null;
          tabIdRef.current = null;
          const replacement = remainingTabs.at(-1);
          if (replacement) activateTab(replacement);
          else setTab(null);
        }
        return;
      }
      tabsRef.current = tabsRef.current.map((candidate) =>
        candidate.id === event.tab.id ? event.tab : candidate
      );
      setTabs(tabsRef.current);
      if (tabIdRef.current === event.tab.id) {
        setTab(event.tab);
        if (!editingAddressRef.current) setAddress(event.tab.url);
        onTitleChange?.(event.tab.title);
        if (event.type === 'tabFailed') showError(event.message);
      }
    };

    void (async () => {
      try {
        unlisten = await browserApi.listen(acceptEvent);
        if (disposed) {
          unlisten();
          return;
        }
        const createdTab = await browserApi.createTab({
          initialUrl: normalizeBrowserUrl(initialUrlRef.current ?? BLANK_PAGE),
          profile: browserProfile(workspaceId),
          surface: currentSurfaceRef.current!,
        });
        createdTabId = createdTab.id;
        if (disposed) {
          await browserApi.closeTab(createdTab.id);
          return;
        }
        ownedTabIds.add(createdTab.id);
        tabsRef.current = [createdTab];
        setTabs([createdTab]);
        tabIdRef.current = createdTab.id;
        attachDevToolsSession(createdTab.id);
        setTab(createdTab);
        setAddress(createdTab.url);
        onTitleChange?.(createdTab.title);
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
      tabIdRef.current = null;
      const tabIds = [...ownedTabIds];
      ownedTabIds.clear();
      tabsRef.current = [];
      for (const tabId of tabIds) void browserApi.closeTab(tabId);
    };
  }, [
    activateTab,
    attachDevToolsSession,
    onTitleChange,
    showError,
    surfaceReady,
    workspaceId,
  ]);

  useEffect(() => {
    if (!tab || requestToken === lastRequestTokenRef.current || !initialUrl) {
      return;
    }
    lastRequestTokenRef.current = requestToken;
    const url = normalizeBrowserUrl(initialUrl);
    setAddress(url);
    applyIntent({ type: 'navigate', url });
  }, [applyIntent, initialUrl, requestToken, tab]);

  const navigate = () => {
    const url = normalizeBrowserUrl(address);
    setAddress(url);
    editingAddressRef.current = false;
    clearError();
    applyIntent({ type: 'navigate', url });
  };

  const toggleElementInspection = () => {
    const session = devToolsSessionRef.current;
    if (!session) return;
    if (isInspecting) {
      setIsInspecting(false);
      void session
        .execute('Overlay.setInspectMode', { mode: 'none' })
        .catch((error: unknown) => showError(commandErrorMessage(error)));
      return;
    }

    clearError();
    void (async () => {
      await session.execute('DOM.enable');
      await session.execute('Overlay.enable');
      await session.execute('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: {
          showInfo: true,
          showStyles: true,
          showAccessibilityInfo: true,
          contentColor: { r: 111, g: 168, b: 220, a: 0.35 },
          borderColor: { r: 79, g: 140, b: 201, a: 0.9 },
        },
      });
      setIsInspecting(true);
    })().catch((error: unknown) => {
      setIsInspecting(false);
      showError(commandErrorMessage(error));
    });
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

  const loading = tab?.loading ?? !errorMessage;

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-muted/40 px-1.5">
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
          onClick={() =>
            applyIntent({ type: tab?.loading ? 'stop' : 'reload' })
          }
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
            aria-label="Address"
            value={address}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onFocus={() => {
              editingAddressRef.current = true;
            }}
            onBlur={() => {
              editingAddressRef.current = false;
            }}
            onChange={(event) => setAddress(event.target.value)}
            className="h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary/70 focus:ring-1 focus:ring-primary/30"
            placeholder="Enter a URL"
          />
        </form>

        <select
          aria-label="Zoom"
          title="Zoom"
          value={String(tab?.zoomLevel ?? 0)}
          disabled={!tab}
          onChange={(event) =>
            applyIntent({ type: 'setZoom', level: Number(event.target.value) })
          }
          className="h-7 w-[4.25rem] rounded-md border border-border bg-background px-1 text-[11px] text-foreground outline-none"
        >
          <option value="-2">80%</option>
          <option value="-1">90%</option>
          <option value="0">100%</option>
          <option value="1">110%</option>
          <option value="2">125%</option>
        </select>
        <select
          aria-label="Device"
          title="Device emulation"
          value={devicePreset}
          disabled={!tab}
          onChange={(event) =>
            changeDevicePreset(event.target.value as DevicePresetId)
          }
          className="h-7 w-[4.75rem] rounded-md border border-border bg-background px-1 text-[11px] text-foreground outline-none"
        >
          <option value="desktop">Desktop</option>
          <option value="tablet">Tablet</option>
          <option value="mobile">Mobile</option>
        </select>
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

      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Browser Tabs"
          className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-muted/20 px-1"
        >
          {tabs.map((candidate) => {
            const label = candidate.title || candidate.url || 'New Tab';
            const active = candidate.id === tab?.id;
            return (
              <div
                key={candidate.id}
                className={cn(
                  'flex h-7 min-w-24 max-w-48 items-center rounded-md border px-1',
                  active
                    ? 'border-border bg-background text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted'
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-label={label}
                  aria-selected={active}
                  className="min-w-0 flex-1 truncate px-1 text-left text-xs"
                  onClick={() => activateTab(candidate)}
                >
                  {label}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
                  onClick={() => void browserApi.closeTab(candidate.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

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
          className="absolute inset-0 bg-transparent"
          onPointerDown={() => applyIntent({ type: 'focus' })}
        />
        {!tab && !errorMessage && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
            <LoaderCircle
              className="h-5 w-5 animate-spin"
              aria-label="Loading browser"
            />
          </div>
        )}
        {errorMessage && (
          <div
            role="alert"
            className="absolute inset-0 flex items-center justify-center bg-background p-8 text-center text-sm text-destructive"
          >
            {errorMessage}
          </div>
        )}
      </div>
    </div>
  );
}
