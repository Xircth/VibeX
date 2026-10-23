import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface PluginRemoteEnvironment {
  pluginId: string;
  surfaceId: string;
  slot: string;
  workspaceId: string | null;
  projectId: string | null;
  invoke: (handler: string, input?: Record<string, unknown>) => Promise<unknown>;
}

export type LinkOpenTarget = 'builtin' | 'system' | 'ask';
export type LinkOpenSource =
  | 'transcript'
  | 'toolCard'
  | 'terminal'
  | 'editor'
  | 'notification';
export type HostRuleAction = 'builtin' | 'system' | 'block';
export type BrowserGrantLevel = 'none' | 'read' | 'control';
export type EvalApprovalMode = 'ask' | 'silent';
export type ServiceAutoOpenMode = 'off' | 'toast' | 'auto';
export type SurfaceOverrideMode = 'auto' | 'window';

export interface HostRoutingRule {
  pattern: string;
  action: HostRuleAction;
}

export interface BrowserProfileRecord {
  id: string;
  label: string;
}

export interface BrowserSettings {
  defaultTarget: Record<LinkOpenSource, LinkOpenTarget>;
  hostRules: HostRoutingRule[];
  toolsEnabled: boolean;
  defaultGrant: BrowserGrantLevel;
  originGrants: Record<string, BrowserGrantLevel>;
  evalEnabled: boolean;
  evalApproval: EvalApprovalMode;
  serviceAutoOpen: ServiceAutoOpenMode;
  terminalClickMenu: boolean;
  devtools: boolean;
  surfaceOverride: SurfaceOverrideMode;
  suspendBackgroundTabs: boolean;
  signInUserAgent: boolean;
  profiles: BrowserProfileRecord[];
  newTabProfile: string;
}

interface BrowserProxyCapability {
  supported?: boolean;
  active?: string | null;
  source?: string | null;
}

interface BrowserCapabilities {
  available?: boolean;
  platform?: string;
  surface?: string;
  profiles?: boolean;
  docGuest?: boolean;
  downloadsDir?: string | null;
  proxy?: BrowserProxyCapability | null;
  proxyNote?: string | null;
}

interface BrowserTabItem {
  tabId: string;
  url: string;
  title?: string;
  loading?: boolean;
  origin?: string | null;
  profileId?: string;
  grant?: {
    level: BrowserGrantLevel;
    origin?: string;
    grantedAt?: number;
  } | null;
}

interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

const LOCAL_STORAGE_KEY = 'vibex:host-browser-prefs:v1';

const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  defaultTarget: {
    transcript: 'builtin',
    toolCard: 'builtin',
    terminal: 'builtin',
    editor: 'builtin',
    notification: 'system',
  },
  hostRules: [],
  toolsEnabled: true,
  defaultGrant: 'control',
  originGrants: {},
  evalEnabled: true,
  evalApproval: 'ask',
  serviceAutoOpen: 'toast',
  terminalClickMenu: true,
  devtools: true,
  surfaceOverride: 'auto',
  suspendBackgroundTabs: true,
  signInUserAgent: true,
  profiles: [{ id: 'default', label: '默认' }],
  newTabProfile: 'default',
};

const DEFAULT_LINK_TARGET_OPTIONS: Array<SelectOption<'builtin' | 'system'>> = [
  { value: 'builtin', label: '内置浏览器' },
  { value: 'system', label: '系统浏览器' },
];

const RULE_ACTION_OPTIONS: Array<SelectOption<HostRuleAction>> = [
  { value: 'builtin', label: '内置浏览器打开' },
  { value: 'system', label: '系统浏览器打开' },
  { value: 'block', label: '禁止访问 (Block)' },
];

const DEFAULT_GRANT_OPTIONS: Array<SelectOption<BrowserGrantLevel>> = [
  { value: 'control', label: '允许控制 (读取 + 点击/输入)' },
  { value: 'read', label: '仅限读取 (快照 + 控制台)' },
  { value: 'none', label: '默认不共享 (需手动授权)' },
];

const TAB_GRANT_OPTIONS: Array<SelectOption<BrowserGrantLevel>> = [
  { value: 'control', label: '允许控制' },
  { value: 'read', label: '仅限读取' },
  { value: 'none', label: '禁止访问' },
];

const EVAL_APPROVAL_OPTIONS: Array<SelectOption<EvalApprovalMode>> = [
  { value: 'ask', label: '每次执行前向我确认' },
  { value: 'silent', label: '在已授权控制标签页静默执行' },
];

const HOST_PATTERN_RE =
  /^(\*|(\*\.)?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*|localhost|127\.0\.0\.1)(:(\*|\d{1,5}))?$/;

function pickTarget(val: unknown, fallback: LinkOpenTarget): LinkOpenTarget {
  return val === 'builtin' || val === 'system' || val === 'ask'
    ? val
    : fallback;
}

const EPHEMERAL_PROFILE_ID = 'ephemeral';

function formatProfileDisplayName(profile: BrowserProfileRecord): string {
  if (
    profile.id === 'default' &&
    (!profile.label ||
      profile.label === 'Default' ||
      profile.label === 'default')
  ) {
    return '默认';
  }
  return profile.label || profile.id;
}

function profileOptionLabel(
  profileId: string,
  profiles: BrowserProfileRecord[]
): string {
  if (profileId === EPHEMERAL_PROFILE_ID) return '无痕';
  const matched = profiles.find((profile) => profile.id === profileId);
  if (matched) return formatProfileDisplayName(matched);
  if (profileId === 'default') return '默认';
  return profileId;
}

function isReservedProfileName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return (
    trimmed === '无痕' || trimmed === 'ephemeral' || trimmed === 'incognito'
  );
}

function redactProxyEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const url = new URL(withScheme);
    return url.host || trimmed;
  } catch {
    return trimmed.replace(/\/\/([^/\s@]+)@/g, '//');
  }
}

function describeProxy(caps: BrowserCapabilities | null): string | null {
  if (!caps) return null;
  const explicit = caps.proxyNote?.trim();
  if (explicit) return explicit;
  const active = caps.proxy?.active?.trim();
  if (!active) return null;
  const endpoint = redactProxyEndpoint(active);
  return endpoint
    ? `内置浏览器已继承宿主代理 ${endpoint}。`
    : '内置浏览器已继承宿主代理。';
}

function normalizeSettings(raw: unknown): BrowserSettings {
  const base = DEFAULT_BROWSER_SETTINGS;
  const top =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const obj =
    top.settings &&
    typeof top.settings === 'object' &&
    !Array.isArray(top.settings)
      ? (top.settings as Record<string, unknown>)
      : top;

  const rawTargets =
    obj.defaultTarget &&
    typeof obj.defaultTarget === 'object' &&
    !Array.isArray(obj.defaultTarget)
      ? (obj.defaultTarget as Record<string, unknown>)
      : {};

  const rulesSource = Array.isArray(obj.hostRules)
    ? obj.hostRules
    : Array.isArray(obj.rules)
      ? obj.rules
      : [];

  const hostRules: HostRoutingRule[] = [];
  for (const item of rulesSource) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const pattern = String(rec.pattern ?? rec.hostPattern ?? '').trim();
    const rawAction = String(rec.action ?? rec.mode ?? '').trim();
    const action: HostRuleAction | null =
      rawAction === 'block' || rawAction === 'deny'
        ? 'block'
        : rawAction === 'system' || rawAction === 'confirm_writes'
          ? 'system'
          : rawAction === 'builtin' || rawAction === 'allow'
            ? 'builtin'
            : null;
    if (pattern && action) {
      hostRules.push({ pattern, action });
    }
  }

  const defaultGrant: BrowserGrantLevel =
    obj.defaultGrant === 'none' ||
    obj.defaultGrant === 'read' ||
    obj.defaultGrant === 'control'
      ? obj.defaultGrant
      : base.defaultGrant;

  const originGrants: Record<string, BrowserGrantLevel> = {};
  if (
    obj.originGrants &&
    typeof obj.originGrants === 'object' &&
    !Array.isArray(obj.originGrants)
  ) {
    for (const [k, v] of Object.entries(
      obj.originGrants as Record<string, unknown>
    )) {
      if (v === 'none' || v === 'read' || v === 'control') {
        originGrants[k] = v;
      }
    }
  }

  const seenProfiles = new Set<string>();
  const profiles: BrowserProfileRecord[] = [];
  if (Array.isArray(obj.profiles)) {
    for (const item of obj.profiles) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const id = String(rec.id ?? '').trim();
      const rawLabel = String(rec.label ?? '').trim();
      const label =
        id === 'default' &&
        (!rawLabel || rawLabel === 'Default' || rawLabel === 'default')
          ? '默认'
          : rawLabel;
      if (!id || !label || id === 'ephemeral' || seenProfiles.has(id)) continue;
      seenProfiles.add(id);
      profiles.push({ id, label });
    }
  }
  if (!seenProfiles.has('default')) {
    profiles.unshift({ id: 'default', label: '默认' });
  }

  const candidateProfile = String(
    obj.newTabProfile ?? base.newTabProfile
  ).trim();
  const newTabProfile =
    candidateProfile === EPHEMERAL_PROFILE_ID ||
    profiles.some((p) => p.id === candidateProfile)
      ? candidateProfile
      : 'default';

  return {
    defaultTarget: {
      transcript: pickTarget(
        rawTargets.transcript,
        base.defaultTarget.transcript
      ),
      toolCard: pickTarget(rawTargets.toolCard, base.defaultTarget.toolCard),
      terminal: pickTarget(rawTargets.terminal, base.defaultTarget.terminal),
      editor: pickTarget(rawTargets.editor, base.defaultTarget.editor),
      notification: pickTarget(
        rawTargets.notification,
        base.defaultTarget.notification
      ),
    },
    hostRules,
    toolsEnabled:
      typeof obj.toolsEnabled === 'boolean'
        ? obj.toolsEnabled
        : base.toolsEnabled,
    defaultGrant,
    originGrants,
    evalEnabled:
      typeof obj.evalEnabled === 'boolean' ? obj.evalEnabled : base.evalEnabled,
    evalApproval:
      obj.evalApproval === 'silent' || obj.evalApproval === 'ask'
        ? obj.evalApproval
        : base.evalApproval,
    serviceAutoOpen:
      obj.serviceAutoOpen === 'off' ||
      obj.serviceAutoOpen === 'toast' ||
      obj.serviceAutoOpen === 'auto'
        ? obj.serviceAutoOpen
        : base.serviceAutoOpen,
    terminalClickMenu:
      typeof obj.terminalClickMenu === 'boolean'
        ? obj.terminalClickMenu
        : base.terminalClickMenu,
    devtools:
      typeof obj.devtools === 'boolean' ? obj.devtools : base.devtools,
    surfaceOverride:
      obj.surfaceOverride === 'window' || obj.surfaceOverride === 'auto'
        ? obj.surfaceOverride
        : base.surfaceOverride,
    suspendBackgroundTabs:
      typeof obj.suspendBackgroundTabs === 'boolean'
        ? obj.suspendBackgroundTabs
        : base.suspendBackgroundTabs,
    signInUserAgent:
      typeof obj.signInUserAgent === 'boolean'
        ? obj.signInUserAgent
        : base.signInUserAgent,
    profiles,
    newTabProfile,
  };
}

function readLocalCache(): BrowserSettings {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return DEFAULT_BROWSER_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_BROWSER_SETTINGS;
  }
}

function writeLocalCache(settings: BrowserSettings): void {
  try {
    const raw = JSON.stringify(settings);
    globalThis.localStorage?.setItem(LOCAL_STORAGE_KEY, raw);
    if (
      typeof window !== 'undefined' &&
      typeof StorageEvent !== 'undefined'
    ) {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: LOCAL_STORAGE_KEY,
          newValue: raw,
        })
      );
    }
  } catch {
    // Ignore storage quota errors
  }
}

function validateHostRulePattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return '请输入域名匹配模式（例如 *.corp.internal 或 localhost:*）';
  }
  if (trimmed.includes('://') || trimmed.includes('/')) {
    return '请仅输入域名与可选端口（不要包含 http:// 或路径）';
  }
  if (!HOST_PATTERN_RE.test(trimmed)) {
    return '域名格式无效，支持 *.example.com、github.com 或 localhost:3000';
  }
  return null;
}

function ruleActionLabel(action: HostRuleAction): string {
  switch (action) {
    case 'builtin':
      return '内置浏览器';
    case 'system':
      return '系统浏览器';
    case 'block':
      return '禁止访问';
  }
}

// ============================================================================
// Direct Tauri RPC Helper & Live HostBrowserPanel DOM Synchronizer
// ============================================================================

type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function getTauriInvoke():
  | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
  | null {
  const internals = (
    globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  ).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function'
    ? internals.invoke.bind(internals)
    : null;
}

async function invokeBrowserContributionDirect<T = unknown>(
  pluginId: string,
  operation: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  const tauriInvoke = getTauriInvoke();
  if (!tauriInvoke) {
    throw new Error('Tauri invoke is unavailable');
  }
  const response = (await tauriInvoke('application_call', {
    command: 'plugin_invoke_contribution',
    operationId: globalThis.crypto.randomUUID(),
    args: {
      pluginId,
      handler: 'browser.dispatch',
      input: {
        operation,
        input,
      },
    },
  })) as { data?: T } | T;
  if (response && typeof response === 'object' && 'data' in response) {
    return (response as { data: T }).data;
  }
  return response as T;
}

interface ReactFiberNode {
  return?: ReactFiberNode | null;
  child?: ReactFiberNode | null;
  sibling?: ReactFiberNode | null;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: {
    memoizedState?: unknown;
    queue?: {
      dispatch?: (action: unknown) => void;
    } | null;
    next?: unknown;
  } | null;
}

function getReactFiberFromDom(el: Element): ReactFiberNode | null {
  const key = Object.keys(el).find(
    (k) =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  if (!key) return null;
  return ((el as unknown as Record<string, unknown>)[key] as ReactFiberNode) ?? null;
}

function findShareControlFiber(
  root: ReactFiberNode | null,
  maxDepth = 18
): ReactFiberNode | null {
  if (!root || maxDepth <= 0) return null;
  if (
    root.memoizedProps &&
    typeof root.memoizedProps.onShare === 'function' &&
    ('grant' in root.memoizedProps || 'origin' in root.memoizedProps)
  ) {
    return root;
  }
  const fromChild = findShareControlFiber(root.child ?? null, maxDepth - 1);
  if (fromChild) return fromChild;
  return findShareControlFiber(root.sibling ?? null, maxDepth - 1);
}

/**
 * Synchronizes the live HostBrowserPanel toolbar in the main window when a tab's
 * Agent grant level is modified from the Browser Settings modal.
 */
function syncHostBrowserPanelsInDom(
  tabId: string,
  level: BrowserGrantLevel,
  updatedTab?: BrowserTabItem | null
): void {
  if (typeof document === 'undefined' || !tabId) return;

  try {
    window.dispatchEvent(
      new CustomEvent('vibex:browser-grant-changed', {
        detail: { tabId, level, tab: updatedTab ?? null },
      })
    );
  } catch {
    // Ignore
  }

  const surfaces = document.querySelectorAll(
    '[data-testid="host-browser-surface"]'
  );
  surfaces.forEach((surface) => {
    const startFiber = getReactFiberFromDom(surface);
    let curr: ReactFiberNode | null = startFiber;
    while (curr) {
      let matchedTab = false;
      let tabStateDispatch: ((action: unknown) => void) | null = null;
      let currentTabObj: BrowserTabItem | null = null;

      let hook = curr.memoizedState;
      let guard = 0;
      while (hook && guard < 40) {
        guard += 1;
        const st = hook.memoizedState;
        if (st && typeof st === 'object') {
          const rec = st as Record<string, unknown>;
          if (rec.tabId === tabId && hook.queue?.dispatch) {
            matchedTab = true;
            tabStateDispatch = hook.queue.dispatch;
            currentTabObj = st as BrowserTabItem;
          } else if (rec.current === tabId) {
            matchedTab = true;
          }
        }
        hook = (hook.next as typeof hook) ?? null;
      }

      if (matchedTab) {
        if (tabStateDispatch && currentTabObj) {
          const origin =
            updatedTab?.origin ||
            currentTabObj.origin ||
            (() => {
              try {
                return new URL(currentTabObj.url).origin;
              } catch {
                return currentTabObj.url;
              }
            })();
          const nextGrant =
            level === 'none'
              ? null
              : {
                  level,
                  origin,
                  grantedAt: Date.now(),
                };
          tabStateDispatch({
            ...currentTabObj,
            ...(updatedTab ?? {}),
            grant: nextGrant,
          });
        } else {
          const shareFiber = findShareControlFiber(curr.child ?? null);
          const onShare = shareFiber?.memoizedProps?.onShare as
            | ((lvl: BrowserGrantLevel) => void)
            | undefined;
          if (typeof onShare === 'function') {
            onShare(level);
          }
        }
        break;
      }
      curr = curr.return ?? null;
    }
  });
}

function getActiveTabFromPanelElement(
  panelRoot: HTMLElement
): { tabId: string; url: string; title: string; origin?: string | null; grant?: { level: string } | null } | null {
  const surface = panelRoot.querySelector(
    '[data-testid="host-browser-surface"]'
  );
  const startFiber = getReactFiberFromDom(surface ?? panelRoot);
  let curr: ReactFiberNode | null = startFiber;
  while (curr) {
    let hook = curr.memoizedState;
    let guard = 0;
    while (hook && guard < 40) {
      guard += 1;
      const st = hook.memoizedState;
      if (
        st &&
        typeof st === 'object' &&
        typeof (st as Record<string, unknown>).tabId === 'string' &&
        typeof (st as Record<string, unknown>).url === 'string'
      ) {
        return st as {
          tabId: string;
          url: string;
          title: string;
          origin?: string | null;
          grant?: { level: string } | null;
        };
      }
      hook = (hook.next as typeof hook) ?? null;
    }
    curr = curr.return ?? null;
  }
  return null;
}

// ============================================================================
// Integrated Docked DevTools Inspector Bridge for HostBrowserPanel
// ============================================================================

const DEVTOOLS_GLOBAL_KEY = '__vibexBrowserDevtoolsControllerV1';

interface DevtoolsController {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

function ensureBrowserDevtoolsBridge(
  pluginId: string,
  initialEnabled: boolean
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const win = window as unknown as Record<string, unknown>;
  const existing = win[DEVTOOLS_GLOBAL_KEY] as DevtoolsController | undefined;
  if (existing) {
    existing.setEnabled(initialEnabled);
    return;
  }

  let isEnabled = initialEnabled;

  const closeAllDocks = () => {
    document
      .querySelectorAll('[data-vibex-browser-devtools-dock="true"]')
      .forEach((dock) => dock.remove());
  };

  const syncToolbarButtons = () => {
    const surfaces = document.querySelectorAll(
      '[data-testid="host-browser-surface"]'
    );
    surfaces.forEach((surface) => {
      const panelRoot = surface.parentElement;
      if (!panelRoot) return;
      const buttons = panelRoot.querySelectorAll('button');
      buttons.forEach((btn) => {
        const hasBugIcon = Boolean(btn.querySelector('svg.lucide-bug'));
        const label = `${btn.getAttribute('aria-label') ?? ''} ${btn.getAttribute('title') ?? ''}`;
        if (
          hasBugIcon ||
          label.includes('开发者工具') ||
          label.toLowerCase().includes('devtools')
        ) {
          btn.setAttribute('data-vibex-devtools-trigger', 'true');
          if (!isEnabled) {
            btn.style.opacity = '0.35';
            btn.style.pointerEvents = 'none';
          } else {
            btn.style.opacity = '';
            btn.style.pointerEvents = '';
          }
        }
      });
    });
    if (!isEnabled) {
      closeAllDocks();
    }
  };

  const toggleDevtoolsDock = (panelRoot: HTMLElement) => {
    if (!isEnabled) return;
    const existingDock = panelRoot.querySelector(
      '[data-vibex-browser-devtools-dock="true"]'
    );
    if (existingDock) {
      existingDock.remove();
      return;
    }

    const dock = document.createElement('div');
    dock.setAttribute('data-vibex-browser-devtools-dock', 'true');
    dock.className =
      'flex h-64 shrink-0 flex-col border-t border-border bg-background text-xs text-foreground select-text';

    let activeTab: 'elements' | 'console' | 'info' = 'elements';
    let snapshotText = '正在加载页面结构快照...';
    let filterQuery = '';
    const consoleLogs: Array<{ type: 'cmd' | 'res' | 'err'; text: string }> = [
      {
        type: 'res',
        text: 'VibeX 内置浏览器开发者工具已就绪。可在下方输入表达式或切到「元素树」检查页面结构。',
      },
    ];

    const renderDock = () => {
      const tabInfo = getActiveTabFromPanelElement(panelRoot);
      const tabId = tabInfo?.tabId ?? '';
      const currentUrl = tabInfo?.url ?? 'about:blank';
      const currentTitle = tabInfo?.title ?? 'Browser';
      const currentOrigin = tabInfo?.origin ?? '—';
      const currentGrant = tabInfo?.grant?.level ?? 'none';

      dock.innerHTML = '';

      // Header bar
      const header = document.createElement('div');
      header.className =
        'flex h-8 shrink-0 items-center justify-between border-b border-border px-2.5 bg-muted/40';

      const tabBar = document.createElement('div');
      tabBar.className = 'flex items-center gap-1';

      const tabs: Array<{ id: 'elements' | 'console' | 'info'; label: string }> =
        [
          { id: 'elements', label: '元素与无障碍树 (Elements)' },
          { id: 'console', label: '控制台 (Console)' },
          { id: 'info', label: '页面与请求信息 (Network & Info)' },
        ];

      tabs.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        btn.className =
          activeTab === item.id
            ? 'h-6 rounded px-2 text-[11px] font-semibold bg-background text-foreground shadow-sm border border-border/60'
            : 'h-6 rounded px-2 text-[11px] text-muted-foreground hover:text-foreground';
        btn.onclick = () => {
          activeTab = item.id;
          renderDock();
        };
        tabBar.appendChild(btn);
      });

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1.5';

      const pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.textContent = '点选页面元素';
      pickBtn.className =
        'h-6 rounded border border-border/60 bg-background px-2 text-[11px] text-muted-foreground hover:text-foreground';
      pickBtn.onclick = () => {
        if (!tabId) return;
        void invokeBrowserContributionDirect(pluginId, 'pick.start', {
          tabId,
        }).catch(() => {});
      };

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.textContent = '刷新快照';
      refreshBtn.className =
        'h-6 rounded border border-border/60 bg-background px-2 text-[11px] text-muted-foreground hover:text-foreground';
      refreshBtn.onclick = () => {
        void loadSnapshot();
      };

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭开发者工具';
      closeBtn.className =
        'inline-flex h-6 w-6 items-center justify-center rounded text-sm text-muted-foreground hover:bg-muted hover:text-foreground';
      closeBtn.onclick = () => {
        dock.remove();
      };

      actions.appendChild(pickBtn);
      actions.appendChild(refreshBtn);
      actions.appendChild(closeBtn);
      header.appendChild(tabBar);
      header.appendChild(actions);
      dock.appendChild(header);

      // Body area
      const body = document.createElement('div');
      body.className = 'flex min-h-0 flex-1 flex-col overflow-hidden';

      if (activeTab === 'elements') {
        const filterBar = document.createElement('div');
        filterBar.className =
          'flex h-7 shrink-0 items-center gap-2 border-b border-border/50 px-2.5';
        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.value = filterQuery;
        filterInput.placeholder =
          '过滤节点名称、角色或 ref（如 heading、button、e1）...';
        filterInput.className =
          'h-5 flex-1 bg-transparent font-mono text-[11px] outline-none';
        filterInput.oninput = (ev) => {
          filterQuery = (ev.target as HTMLInputElement).value;
          updatePre();
        };
        filterBar.appendChild(filterInput);
        body.appendChild(filterBar);

        const pre = document.createElement('pre');
        pre.className =
          'min-h-0 flex-1 overflow-auto p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all';
        const updatePre = () => {
          if (!filterQuery.trim()) {
            pre.textContent = snapshotText;
            return;
          }
          const q = filterQuery.toLowerCase();
          const lines = snapshotText
            .split('\n')
            .filter((line) => line.toLowerCase().includes(q));
          pre.textContent =
            lines.length > 0 ? lines.join('\n') : '(无匹配节点)';
        };
        updatePre();
        body.appendChild(pre);
      } else if (activeTab === 'console') {
        const logList = document.createElement('div');
        logList.className =
          'min-h-0 flex-1 overflow-auto p-2.5 font-mono text-[11px] space-y-1.5';
        consoleLogs.forEach((entry) => {
          const row = document.createElement('div');
          row.className =
            entry.type === 'err'
              ? 'text-destructive whitespace-pre-wrap break-all'
              : entry.type === 'cmd'
                ? 'text-primary font-semibold whitespace-pre-wrap break-all'
                : 'text-foreground whitespace-pre-wrap break-all';
          row.textContent =
            entry.type === 'cmd' ? `> ${entry.text}` : entry.text;
          logList.appendChild(row);
        });

        const inputRow = document.createElement('form');
        inputRow.className =
          'flex h-8 shrink-0 items-center gap-2 border-t border-border px-2.5';
        const promptSym = document.createElement('span');
        promptSym.className = 'font-mono text-xs font-bold text-primary';
        promptSym.textContent = '>';
        const cmdInput = document.createElement('input');
        cmdInput.type = 'text';
        cmdInput.placeholder =
          '输入命令: title / url / chrome / find:<文本> 或页面查询...';
        cmdInput.className =
          'h-6 flex-1 bg-transparent font-mono text-[11px] outline-none';
        const runBtn = document.createElement('button');
        runBtn.type = 'submit';
        runBtn.textContent = '运行';
        runBtn.className =
          'h-6 rounded border border-border/60 bg-muted/50 px-2 text-[11px] hover:bg-muted';

        inputRow.onsubmit = async (ev) => {
          ev.preventDefault();
          const expr = cmdInput.value.trim();
          if (!expr || !tabId) return;
          cmdInput.value = '';
          consoleLogs.push({ type: 'cmd', text: expr });
          renderDock();
          try {
            if (expr === 'url' || expr === 'location.href') {
              const chrome = (await invokeBrowserContributionDirect(
                pluginId,
                'tab.chrome',
                { tabId }
              )) as { url?: string };
              consoleLogs.push({
                type: 'res',
                text: JSON.stringify(chrome?.url ?? currentUrl),
              });
            } else if (expr === 'title' || expr === 'document.title') {
              const res = (await invokeBrowserContributionDirect(
                pluginId,
                'tab.title',
                { tabId }
              )) as { title?: string };
              consoleLogs.push({
                type: 'res',
                text: JSON.stringify(res?.title ?? currentTitle),
              });
            } else if (expr === 'chrome') {
              const chrome = await invokeBrowserContributionDirect(
                pluginId,
                'tab.chrome',
                { tabId }
              );
              consoleLogs.push({
                type: 'res',
                text: JSON.stringify(chrome, null, 2),
              });
            } else if (expr.startsWith('find:')) {
              const query = expr.slice(5).trim();
              const found = await invokeBrowserContributionDirect(
                pluginId,
                'tab.find',
                { tabId, query, forward: true }
              );
              consoleLogs.push({
                type: 'res',
                text: JSON.stringify(found),
              });
            } else {
              const res = await invokeBrowserContributionDirect(
                pluginId,
                'eval.run',
                { tabId, code: expr }
              );
              consoleLogs.push({
                type: 'res',
                text: JSON.stringify(res, null, 2),
              });
            }
          } catch (err) {
            consoleLogs.push({
              type: 'err',
              text: err instanceof Error ? err.message : String(err),
            });
          }
          renderDock();
        };

        inputRow.appendChild(promptSym);
        inputRow.appendChild(cmdInput);
        inputRow.appendChild(runBtn);
        body.appendChild(logList);
        body.appendChild(inputRow);
      } else {
        const infoBox = document.createElement('div');
        infoBox.className = 'min-h-0 flex-1 overflow-auto p-3 space-y-1.5 font-mono text-[11px]';
        const rows = [
          ['Tab ID', tabId || '—'],
          ['当前地址 (URL)', currentUrl],
          ['页面标题 (Title)', currentTitle],
          ['站点源 (Origin)', String(currentOrigin)],
          ['Agent 共享权限 (Grant)', String(currentGrant)],
        ];
        rows.forEach(([k, v]) => {
          const line = document.createElement('div');
          line.className = 'flex items-baseline gap-2';
          const keyEl = document.createElement('span');
          keyEl.className = 'w-40 shrink-0 text-muted-foreground';
          keyEl.textContent = k;
          const valEl = document.createElement('span');
          valEl.className = 'break-all text-foreground';
          valEl.textContent = v;
          line.appendChild(keyEl);
          line.appendChild(valEl);
          infoBox.appendChild(line);
        });
        body.appendChild(infoBox);
      }

      dock.appendChild(body);
    };

    const loadSnapshot = async () => {
      const tabInfo = getActiveTabFromPanelElement(panelRoot);
      const tabId = tabInfo?.tabId;
      if (!tabId) {
        snapshotText = '当前标签页尚未初始化。';
        renderDock();
        return;
      }
      snapshotText = '正在读取页面结构...';
      renderDock();
      try {
        const snap = (await invokeBrowserContributionDirect(
          pluginId,
          'snapshot',
          { tabId }
        )) as { snapshot?: string; url?: string; title?: string };
        snapshotText =
          snap?.snapshot ||
          `URL: ${snap?.url ?? tabInfo.url}\n(页面暂无可序列化无障碍节点)`;
      } catch (err) {
        try {
          const chrome = (await invokeBrowserContributionDirect(
            pluginId,
            'tab.chrome',
            { tabId }
          )) as { url?: string; title?: string; favicon?: string };
          snapshotText = `页面标题: ${chrome?.title || tabInfo.title || '(无标题)'}\n当前 URL: ${chrome?.url || tabInfo.url}\nFavicon: ${chrome?.favicon || '—'}\n\n提示: 如需读取完整无障碍 DOM 树，请将当前标签页的 Agent 共享权限设为「仅限读取」或「允许控制」。\n(${err instanceof Error ? err.message : String(err)})`;
        } catch {
          snapshotText = err instanceof Error ? err.message : String(err);
        }
      }
      renderDock();
    };

    panelRoot.appendChild(dock);
    void loadSnapshot();
  };

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest('button');
      if (!btn) return;
      const hasBugIcon = Boolean(btn.querySelector('svg.lucide-bug'));
      const label = `${btn.getAttribute('aria-label') ?? ''} ${btn.getAttribute('title') ?? ''}`;
      if (
        !hasBugIcon &&
        !label.includes('开发者工具') &&
        !label.toLowerCase().includes('devtools')
      ) {
        return;
      }
      if (!isEnabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const panelRoot = btn.closest('div.flex.h-full.min-h-0.w-full');
      if (
        panelRoot instanceof HTMLElement &&
        panelRoot.querySelector('[data-testid="host-browser-surface"]')
      ) {
        toggleDevtoolsDock(panelRoot);
      }
    },
    true
  );

  const observer = new MutationObserver(() => {
    syncToolbarButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  syncToolbarButtons();

  win[DEVTOOLS_GLOBAL_KEY] = {
    get enabled() {
      return isEnabled;
    },
    setEnabled(next: boolean) {
      isEnabled = next;
      syncToolbarButtons();
    },
  };
}

// ============================================================================
// Tahoe Native UI Primitives
// ============================================================================

const Icons = {
  Link: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  Shield: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  Cpu: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </svg>
  ),
  Layers: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </svg>
  ),
  User: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  ),
  Eraser: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  ),
  Trash: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  ),
  Globe: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  ),
};

function SwitchControl({
  id,
  checked,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-[var(--surface-control)] transition-colors data-[state=checked]:border-[var(--switch-checked-border)] data-[state=checked]:bg-[var(--switch-checked-track)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        data-state={checked ? 'checked' : 'unchecked'}
        className="pointer-events-none block h-4 w-4 translate-x-0.5 rounded-full bg-background shadow-[var(--shadow-switch-thumb)] ring-0 transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[var(--switch-checked-thumb)] data-[state=unchecked]:translate-x-0.5"
      />
    </button>
  );
}

function AstryxSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  size = 'default',
  width = 210,
}: {
  id?: string;
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (next: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  size?: 'default' | 'compact';
  width?: number | string;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedOption =
    selectedIndex >= 0 ? options[selectedIndex] : options[0];

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh =
      typeof window !== 'undefined' ? window.innerHeight || 768 : 768;
    const vw =
      typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024;
    const gap = 4;
    const menuWidth =
      typeof width === 'number'
        ? Math.max(rect.width, width)
        : Math.max(rect.width, 160);
    const spaceBelow = vh - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      280,
      Math.max(120, flipUp ? spaceAbove - 8 : spaceBelow - 8)
    );
    const estHeight = Math.min(maxHeight, options.length * 32 + 10);
    const top = flipUp
      ? Math.max(8, rect.top - gap - estHeight)
      : rect.bottom + gap;
    const left = Math.max(
      8,
      Math.min(
        rect.right > 0 ? rect.right - menuWidth : rect.left,
        vw - menuWidth - 8
      )
    );
    setPos({ top, left, width: menuWidth, maxHeight });
  }, [options.length, width]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        (rootRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const selectAt = (index: number) => {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (open) {
        setActiveIndex((prev) => (prev + 1) % options.length);
      } else {
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) {
        setActiveIndex(
          (prev) => (prev - 1 + options.length) % options.length
        );
      } else {
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open && activeIndex >= 0) {
        selectAt(activeIndex);
      } else {
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const menuNode =
    open && pos ? (
      <div
        ref={menuRef}
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        data-floating-layer="popover"
        className="astryx-select-menu tahoe-popover"
        style={{
          position: 'fixed',
          zIndex: 20000,
          top: `${pos.top}px`,
          left: `${pos.left}px`,
          width: `${pos.width}px`,
          maxHeight: `${pos.maxHeight}px`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {options.map((opt, idx) => {
          const isSelected = opt.value === value;
          const isActive = activeIndex === idx;
          return (
            <div
              key={String(opt.value)}
              role="option"
              aria-selected={isSelected}
              data-active={isActive ? 'true' : undefined}
              data-disabled={opt.disabled ? 'true' : undefined}
              className="astryx-select-option"
              onMouseEnter={() => {
                if (!opt.disabled) setActiveIndex(idx);
              }}
              onClick={() => selectAt(idx)}
            >
              <span className="astryx-select-option-label">{opt.label}</span>
              {isSelected ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="astryx-select-option-check"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <span
      ref={rootRef}
      className={`astryx-select ${
        size === 'compact' ? 'astryx-select--compact' : ''
      }`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        maxWidth: '100%',
        flexShrink: 0,
      }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        className={`astryx-select-trigger ${open ? 'is-open' : ''}`}
        style={{
          height: size === 'compact' ? '28px' : '32px',
          minHeight: size === 'compact' ? '28px' : '32px',
          borderRadius: '8px',
        }}
        onClick={() => {
          if (disabled) return;
          if (open) {
            setOpen(false);
          } else {
            setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
            setOpen(true);
          }
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="astryx-select-trigger-label">
          {selectedOption ? selectedOption.label : ''}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="astryx-select-chevron"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menuNode
        ? typeof document !== 'undefined' && document.body
          ? createPortal(menuNode, document.body)
          : menuNode
        : null}
    </span>
  );
}

function SectionGroup({
  title,
  description,
  icon,
  action,
  children,
}: {
  title: string;
  description?: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {icon}
            </span>
            <span>{title}</span>
          </h3>
          {description ? (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div
        className="settings-card rounded-lg border"
        style={{
          border: '1px solid var(--border-content, hsl(var(--border)))',
          borderRadius: 'var(--radius, 14px)',
          background: 'var(--surface-content, hsl(var(--card)))',
        }}
      >
        {children}
      </div>
    </section>
  );
}

function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      aria-label={`${label} ${count}`}
      className="settings-meta-chip inline-flex shrink-0 items-center justify-center rounded-full px-2.5 py-0.5 font-mono text-xs font-medium"
      style={{
        minWidth: '28px',
        height: '22px',
        borderRadius: '9999px',
        border: '1px solid var(--border-subtle, hsl(var(--border)))',
        background: 'var(--surface-control, hsl(var(--muted) / 0.4))',
        color: 'var(--text-secondary, hsl(var(--muted-foreground)))',
      }}
    >
      {count}
    </span>
  );
}

function SettingsButton({
  label,
  onClick,
  disabled = false,
  title,
  ariaLabel,
  iconOnly = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  iconOnly?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onClick={onClick}
      data-variant="secondary"
      data-size="sm"
      data-elevation="none"
      data-astryx-pressable={disabled ? undefined : ''}
      data-icon-only={iconOnly ? '' : undefined}
      className="astryx-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        height: '28px',
        minHeight: '28px',
        width: iconOnly ? '28px' : undefined,
        paddingInline: iconOnly ? '0' : '10px',
        fontSize: '12px',
        lineHeight: '16px',
        border: '0',
        borderRadius:
          'var(--_button-radius, var(--radius-element, var(--radius, 8px)))',
        background: 'var(--surface-control-solid, var(--color-neutral, #e5e5e5))',
        color: 'var(--text-strong, var(--color-text-primary, inherit))',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {iconOnly ? (
        children
      ) : (
        <span className="astryx-button__label" style={{ fontSize: '12px' }}>
          {children ?? label}
        </span>
      )}
    </button>
  );
}

function NestedList({
  title,
  description,
  count,
  countLabel,
  listLabel,
  action,
  children,
}: {
  title: string;
  description: string;
  count: number;
  countLabel: string;
  listLabel: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex w-full items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">{title}</div>
            <CountBadge count={count} label={countLabel} />
          </div>
          <p className="settings-row__description text-sm">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div
        role="list"
        aria-label={listLabel}
        className="mt-2 w-full overflow-hidden"
        style={{
          borderRadius: '8px',
          border: '1px solid var(--border-subtle, hsl(var(--border)))',
          background: 'var(--surface-control, hsl(var(--muted) / 0.25))',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ProfileList({
  profiles,
  busyProfile,
  confirmClearProfile,
  onRequestClear,
  onCancelClear,
  onConfirmClear,
  onRemoveProfile,
}: {
  profiles: BrowserProfileRecord[];
  busyProfile: string | null;
  confirmClearProfile: string | null;
  onRequestClear: (profileId: string) => void;
  onCancelClear: () => void;
  onConfirmClear: (profileId: string, displayName: string) => void;
  onRemoveProfile: (profileId: string, displayName: string) => void;
}) {
  return (
    <div
      role="list"
      aria-label="浏览器配置文件列表"
      className="w-full overflow-hidden rounded-lg border"
      style={{
        borderRadius: '8px',
        border: '1px solid var(--border-subtle, hsl(var(--border)))',
        background: 'var(--surface-control, hsl(var(--muted) / 0.25))',
      }}
    >
      {profiles.map((profile, idx) => {
        const isDefault = profile.id === 'default';
        const isBusy = busyProfile === profile.id;
        const confirmingClear = confirmClearProfile === profile.id;
        const displayName = formatProfileDisplayName(profile);

        return (
          <div
            key={profile.id}
            role="listitem"
            className={`flex items-center justify-between gap-2.5 px-3 py-1 ${
              idx > 0
                ? 'border-t border-[var(--border-subtle,hsl(var(--border)))]'
                : ''
            }`}
            style={{ minHeight: '32px' }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
                <Icons.User />
              </span>
              <span className="truncate text-xs font-medium text-foreground">
                {displayName}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {confirmingClear ? (
                <>
                  <SettingsButton
                    label="确认清理"
                    disabled={isBusy}
                    onClick={() => onConfirmClear(profile.id, displayName)}
                  />
                  <SettingsButton
                    label="取消"
                    disabled={isBusy}
                    onClick={onCancelClear}
                  />
                </>
              ) : (
                <SettingsButton
                  label={`清理「${displayName}」的站点数据`}
                  iconOnly
                  disabled={isBusy}
                  title={`清理「${displayName}」的站点存储与 Cookie`}
                  onClick={() => onRequestClear(profile.id)}
                >
                  <Icons.Eraser />
                </SettingsButton>
              )}
              {!isDefault ? (
                <SettingsButton
                  label={`删除配置文件「${displayName}」`}
                  iconOnly
                  disabled={isBusy}
                  title={`删除配置文件「${displayName}」`}
                  onClick={() => onRemoveProfile(profile.id, displayName)}
                >
                  <Icons.Trash />
                </SettingsButton>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Main Browser Settings Component (Tahoe Native Design)
// ============================================================================

export default function BrowserSettingsRemoteView({
  environment,
}: {
  environment?: PluginRemoteEnvironment;
}) {
  const [settings, setSettings] = useState<BrowserSettings>(() =>
    readLocalCache()
  );
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(
    null
  );
  const [tabs, setTabs] = useState<BrowserTabItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const [rulePattern, setRulePattern] = useState('');
  const [ruleAction, setRuleAction] = useState<HostRuleAction>('builtin');
  const [ruleError, setRuleError] = useState<string | null>(null);

  const [profileDraft, setProfileDraft] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [busyProfile, setBusyProfile] = useState<string | null>(null);
  const [confirmClearProfile, setConfirmClearProfile] = useState<string | null>(
    null
  );

  const [statusMessage, setStatusMessage] = useState<{
    tone: 'success' | 'danger' | 'neutral';
    text: string;
  } | null>(null);

  const ruleInputId = useId();
  const profileInputId = useId();
  const defaultGrantSelectId = useId();
  const evalApprovalSelectId = useId();
  const defaultProfileSelectId = useId();

  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pluginId = environment?.pluginId || 'vibex.browser';

  const dispatch = useCallback(
    <T = unknown,>(
      operation: string,
      input: Record<string, unknown> = {}
    ): Promise<T> => {
      const payload = JSON.parse(JSON.stringify(input ?? {})) as Record<
        string,
        unknown
      >;
      const run = async (): Promise<T> => {
        if (getTauriInvoke()) {
          try {
            return await invokeBrowserContributionDirect<T>(
              pluginId,
              operation,
              payload
            );
          } catch (tauriErr) {
            if (!environment?.invoke) {
              throw tauriErr;
            }
          }
        }
        const invoke = environment?.invoke;
        if (!invoke) {
          throw new Error('插件桥接尚未就绪');
        }
        const res = await invoke('surface.createSession', {
          operation,
          input: payload,
        });
        if (
          res &&
          typeof res === 'object' &&
          'ready' in (res as Record<string, unknown>) &&
          Object.keys(res as Record<string, unknown>).length === 1
        ) {
          return (await invoke('browser.dispatch', {
            operation,
            input: payload,
          })) as T;
        }
        return res as T;
      };
      const next = queueRef.current.then(run, run);
      queueRef.current = next.catch(() => undefined);
      return next;
    },
    [environment, pluginId]
  );

  useEffect(() => {
    ensureBrowserDevtoolsBridge(pluginId, settings.devtools);
  }, [pluginId, settings.devtools]);

  const flashStatus = useCallback(
    (tone: 'success' | 'danger' | 'neutral', text: string) => {
      setStatusMessage({ tone, text });
    },
    []
  );

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const refreshAll = useCallback(
    async (updateSettingsState = true) => {
      if (!environment?.invoke && !getTauriInvoke()) {
        setLoading(false);
        return;
      }
      try {
        const boot = await dispatch<{
          settings?: unknown;
          capabilities?: BrowserCapabilities | null;
          tabs?: BrowserTabItem[];
        }>('bootstrap', {});
        if (boot && typeof boot === 'object' && 'settings' in boot) {
          if (updateSettingsState) {
            const normalized = normalizeSettings(boot.settings);
            setSettings(normalized);
            writeLocalCache(normalized);
          }
          if (boot.capabilities) setCapabilities(boot.capabilities);
          if (Array.isArray(boot.tabs)) setTabs(boot.tabs);
          setLoading(false);
          return;
        }
      } catch {
        // Fallback to individual calls
      }

      if (updateSettingsState) {
        try {
          const rawSettings = await dispatch('settings.get', {});
          const normalized = normalizeSettings(rawSettings);
          setSettings(normalized);
          writeLocalCache(normalized);
        } catch {
          // Keep cached settings
        }
      }

      try {
        const caps = await dispatch<BrowserCapabilities>('capabilities', {});
        if (caps && typeof caps === 'object') {
          setCapabilities(caps);
        }
      } catch {
        // Ignore
      }

      try {
        const listed = await dispatch<{ tabs?: BrowserTabItem[] }>(
          'tab.list',
          {}
        );
        if (Array.isArray(listed?.tabs)) {
          setTabs(listed.tabs);
        }
      } catch {
        // Ignore
      }

      setLoading(false);
    },
    [dispatch, environment]
  );

  useEffect(() => {
    void refreshAll(true);
  }, [refreshAll]);

  // Poll open tabs & remembered origin grants while Settings page is mounted
  // so changes made in the Browser Panel toolbar sync back immediately.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void dispatch<{
        settings?: unknown;
        tabs?: BrowserTabItem[];
      }>('bootstrap', {})
        .then((boot) => {
          if (!boot || typeof boot !== 'object') return;
          if (Array.isArray(boot.tabs)) {
            setTabs(boot.tabs);
          }
          if (boot.settings) {
            const normalized = normalizeSettings(boot.settings);
            setSettings((prev) => {
              if (
                JSON.stringify(prev.originGrants) !==
                JSON.stringify(normalized.originGrants)
              ) {
                writeLocalCache(normalized);
                return normalized;
              }
              return prev;
            });
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [dispatch]);

  const applyPatch = useCallback(
    async (patch: Partial<BrowserSettings>, successToast?: string) => {
      const optimistic = normalizeSettings({
        ...settings,
        ...patch,
        defaultTarget: patch.defaultTarget
          ? { ...settings.defaultTarget, ...patch.defaultTarget }
          : settings.defaultTarget,
      });
      setSettings(optimistic);
      writeLocalCache(optimistic);

      if (typeof patch.devtools === 'boolean') {
        ensureBrowserDevtoolsBridge(pluginId, patch.devtools);
      }

      try {
        const saved = await dispatch(
          'settings.set',
          optimistic as unknown as Record<string, unknown>
        );
        const normalized = normalizeSettings(saved ?? optimistic);
        setSettings(normalized);
        writeLocalCache(normalized);
        if (successToast) {
          flashStatus('success', successToast);
        }
      } catch (error) {
        flashStatus(
          'danger',
          error instanceof Error ? error.message : '保存设置失败'
        );
      }
    },
    [dispatch, flashStatus, pluginId, settings]
  );

  const defaultLinkTarget: 'builtin' | 'system' =
    settings.defaultTarget.transcript === 'system' ? 'system' : 'builtin';

  const setUnifiedLinkTarget = (target: 'builtin' | 'system') => {
    void applyPatch(
      {
        defaultTarget: {
          transcript: target,
          toolCard: target,
          terminal: target,
          editor: target,
          notification: target,
        },
      },
      `链接默认打开方式已设为「${
        target === 'builtin' ? '内置浏览器' : '系统浏览器'
      }」`
    );
  };

  const addRule = (customPattern?: string, customAction?: HostRuleAction) => {
    const rawPattern = customPattern ?? rulePattern;
    const actionToUse = customAction ?? ruleAction;
    const err = validateHostRulePattern(rawPattern);
    if (err) {
      setRuleError(err);
      return;
    }
    const pattern = rawPattern.trim();
    const duplicate = settings.hostRules.some(
      (r) =>
        r.pattern.toLowerCase() === pattern.toLowerCase() &&
        r.action === actionToUse
    );
    if (duplicate) {
      setRuleError('该站点规则已存在');
      return;
    }
    const nextRules = [
      ...settings.hostRules.filter(
        (r) => r.pattern.toLowerCase() !== pattern.toLowerCase()
      ),
      { pattern, action: actionToUse },
    ];
    if (!customPattern) {
      setRulePattern('');
    }
    setRuleError(null);
    void applyPatch({ hostRules: nextRules }, `已添加规则 ${pattern}`);
  };

  const removeRule = (index: number) => {
    const removed = settings.hostRules[index];
    const nextRules = settings.hostRules.filter((_, idx) => idx !== index);
    void applyPatch(
      { hostRules: nextRules },
      removed ? `已移除规则 ${removed.pattern}` : '规则已移除'
    );
  };

  const handleCreateProfile = async () => {
    const trimmed = profileDraft.trim();
    if (!trimmed) {
      setProfileError('请输入配置文件名称');
      return;
    }
    if (trimmed.length > 36) {
      setProfileError('配置文件名称最长 36 个字符');
      return;
    }
    if (isReservedProfileName(trimmed)) {
      setProfileError('「无痕」是内置配置，已可在「新标签页使用」中选择');
      return;
    }
    if (
      settings.profiles.some(
        (p) =>
          p.label.toLowerCase() === trimmed.toLowerCase() ||
          p.id.toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      setProfileError('该配置文件已存在');
      return;
    }
    setProfileError(null);
    setBusyProfile(trimmed);
    try {
      await dispatch('profile.create', { label: trimmed });
      setProfileDraft('');
      await refreshAll(true);
      flashStatus('success', `已添加配置文件「${trimmed}」`);
    } catch (error) {
      flashStatus(
        'danger',
        error instanceof Error ? error.message : '创建配置文件失败'
      );
    } finally {
      setBusyProfile(null);
    }
  };

  const handleClearProfile = async (
    profileId: string,
    displayLabel: string
  ) => {
    setBusyProfile(profileId);
    try {
      await dispatch('profile.clear', { profileId });
      setConfirmClearProfile(null);
      await refreshAll(true);
      flashStatus('success', `已清理「${displayLabel}」的站点存储与 Cookie`);
    } catch (error) {
      flashStatus(
        'danger',
        error instanceof Error ? error.message : '清理配置数据失败'
      );
    } finally {
      setBusyProfile(null);
    }
  };

  const handleRemoveProfile = async (
    profileId: string,
    displayLabel: string
  ) => {
    setBusyProfile(profileId);
    try {
      await dispatch('profile.remove', { profileId });
      await refreshAll(true);
      flashStatus('success', `已删除配置文件「${displayLabel}」`);
    } catch (error) {
      flashStatus(
        'danger',
        error instanceof Error ? error.message : '删除配置文件失败'
      );
    } finally {
      setBusyProfile(null);
    }
  };

  const handleTabGrantChange = async (
    tabId: string,
    level: BrowserGrantLevel
  ) => {
    // 1. Optimistically update the tab list in Settings immediately
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.tabId !== tabId) return tab;
        const origin = tab.origin || tab.url;
        return {
          ...tab,
          grant:
            level === 'none'
              ? null
              : {
                  level,
                  origin,
                  grantedAt: Date.now(),
                },
        };
      })
    );

    try {
      const updated = await dispatch<BrowserTabItem>('grant.set', {
        tabId,
        level,
      });
      syncHostBrowserPanelsInDom(tabId, level, updated);
      await refreshAll(true);
      flashStatus('success', '已更新标签页共享权限');
    } catch (error) {
      await refreshAll(false);
      flashStatus(
        'danger',
        error instanceof Error ? error.message : '更新标签页权限失败'
      );
    }
  };

  const handleCloseTab = async (tabId: string) => {
    setTabs((prev) => prev.filter((t) => t.tabId !== tabId));
    try {
      await dispatch('tab.close', { tabId });
      await refreshAll(false);
    } catch {
      // Ignore
    }
  };

  const profileSelectOptions = useMemo<Array<SelectOption<string>>>(() => {
    const options: Array<SelectOption<string>> = [
      {
        value: 'default',
        label: profileOptionLabel('default', settings.profiles),
      },
      {
        value: EPHEMERAL_PROFILE_ID,
        label: '无痕',
      },
    ];
    for (const profile of settings.profiles) {
      if (profile.id === 'default' || profile.id === EPHEMERAL_PROFILE_ID) {
        continue;
      }
      options.push({
        value: profile.id,
        label: formatProfileDisplayName(profile),
      });
    }
    return options;
  }, [settings.profiles]);

  const originEntries = Object.entries(settings.originGrants);
  const isAvailable = capabilities?.available !== false;
  const proxyNote = describeProxy(capabilities);

  return (
    <div className="settings-page" data-testid="plugin-browser-settings-view">
      <div className="settings-content">
        <header className="settings-page-header flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2>浏览器</h2>
              <span
                className={`px-2 py-0.5 text-xs font-medium ${
                  isAvailable
                    ? 'settings-status-pill-success'
                    : 'settings-status-pill-warning'
                }`}
              >
                {loading
                  ? '加载中…'
                  : isAvailable
                    ? '内置浏览器已就绪'
                    : '受限模式'}
              </span>
              {capabilities?.platform ? (
                <span className="settings-meta-chip px-2 py-0.5 font-mono text-xs">
                  {capabilities.platform}
                </span>
              ) : null}
            </div>
          </div>

          {statusMessage ? (
            <span
              className={`px-2.5 py-1 text-xs font-medium ${
                statusMessage.tone === 'success'
                  ? 'settings-status-pill-success'
                  : statusMessage.tone === 'danger'
                    ? 'settings-status-pill-danger'
                    : 'settings-status-pill-neutral'
              }`}
            >
              {statusMessage.text}
            </span>
          ) : null}
        </header>

        <div className="settings-sections">
          {/* 1. 基础设置 */}
          <SectionGroup icon={<Icons.Cpu />} title="基础设置">
            <div className="settings-row">
              <div>
                <label
                  htmlFor="browser-default-link-target"
                  className="text-sm font-medium"
                >
                  链接默认打开方式
                </label>
                <p className="settings-row__description text-sm">
                  点击工作区中的外部 HTTP/HTTPS 链接时默认使用的浏览器。
                </p>
              </div>
              <AstryxSelect
                id="browser-default-link-target"
                ariaLabel="链接默认打开方式"
                width={180}
                value={defaultLinkTarget}
                options={DEFAULT_LINK_TARGET_OPTIONS}
                onChange={(next) => setUnifiedLinkTarget(next)}
              />
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">
                  允许打开开发者工具 (DevTools)
                </div>
                <p className="settings-row__description text-sm">
                  在内置浏览器工具栏中启用开发者工具检查器入口（支持查看页面结构、控制台与网络请求信息）。
                </p>
              </div>
              <SwitchControl
                id="browser-devtools-switch"
                checked={settings.devtools}
                onChange={(checked) =>
                  void applyPatch(
                    { devtools: checked },
                    checked
                      ? '已启用浏览器开发者工具'
                      : '已禁用浏览器开发者工具'
                  )
                }
                ariaLabel="允许打开开发者工具 (DevTools)"
              />
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">
                  自动休眠后台隐藏标签页
                </div>
                <p className="settings-row__description text-sm">
                  当标签页处于非活动或折叠状态时自动暂停页面音视频播放并降低后台定时器频率。
                </p>
              </div>
              <SwitchControl
                id="browser-suspend-tabs"
                checked={settings.suspendBackgroundTabs}
                onChange={(checked) =>
                  void applyPatch(
                    { suspendBackgroundTabs: checked },
                    checked
                      ? '已开启后台标签页自动休眠'
                      : '已关闭后台标签页自动休眠'
                  )
                }
                ariaLabel="自动休眠后台隐藏标签页"
              />
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">
                  OAuth / SSO 登录兼容 User-Agent
                </div>
                <p className="settings-row__description text-sm">
                  发送标准桌面浏览器标识，避免 Google、GitHub 等单点登录页面拦截内嵌 WebView。
                </p>
              </div>
              <SwitchControl
                id="browser-signin-ua"
                checked={settings.signInUserAgent}
                onChange={(checked) =>
                  void applyPatch(
                    { signInUserAgent: checked },
                    checked
                      ? '已启用 OAuth / SSO 兼容 User-Agent'
                      : '已恢复系统默认 WebView User-Agent'
                  )
                }
                ariaLabel="OAuth / SSO 登录兼容 User-Agent"
              />
            </div>

            {proxyNote ? (
              <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
                <div>
                  <div className="text-sm font-medium">网络代理状态</div>
                  <p className="settings-row__description text-sm">
                    {proxyNote}
                  </p>
                </div>
                <span className="settings-status-pill-neutral px-2 py-0.5 text-xs font-medium">
                  继承宿主代理
                </span>
              </div>
            ) : null}

            {capabilities?.downloadsDir ? (
              <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
                <div>
                  <div className="text-sm font-medium">默认下载目录</div>
                  <p className="settings-row__description text-sm">
                    内置浏览器触发文件下载时的默认保存位置。
                  </p>
                </div>
                <code className="settings-kbd max-w-xs truncate rounded px-2 py-0.5 font-mono text-xs">
                  {capabilities.downloadsDir}
                </code>
              </div>
            ) : null}
          </SectionGroup>

          {/* 2. Agent功能设置 */}
          <SectionGroup
            icon={<Icons.Shield />}
            title="Agent功能设置"
            description="启用或修改Agent的Browser Use（浏览器控制）功能"
          >
            <div className="settings-row">
              <div>
                <div className="text-sm font-medium">
                  启用 Agent 浏览器工具 (MCP)
                </div>
                <p className="settings-row__description text-sm">
                  开启后向 Agent 暴露内置浏览器工具；Agent 仅能访问已授予「仅限读取」或「允许控制」权限的标签页。
                </p>
              </div>
              <SwitchControl
                id="browser-tools-enabled"
                checked={settings.toolsEnabled}
                onChange={(checked) =>
                  void applyPatch(
                    { toolsEnabled: checked },
                    checked
                      ? '已启用 Agent 浏览器工具'
                      : '已停用 Agent 浏览器工具'
                  )
                }
                ariaLabel="启用 Agent 浏览器工具 (MCP)"
              />
            </div>

            <fieldset
              className="settings-subrows"
              disabled={!settings.toolsEnabled}
            >
              <div className="settings-row">
                <div className="settings-row__copy">
                  <label
                    htmlFor={defaultGrantSelectId}
                    className="text-sm font-medium"
                  >
                    新标签页默认共享权限
                  </label>
                  <p className="settings-row__description text-sm">
                    打开新标签页时默认赋予 AI Agent 的访问与操作级别。
                  </p>
                </div>
                <AstryxSelect
                  id={defaultGrantSelectId}
                  ariaLabel="新标签页默认共享权限"
                  width={240}
                  disabled={!settings.toolsEnabled}
                  value={settings.defaultGrant}
                  options={DEFAULT_GRANT_OPTIONS}
                  onChange={(next) =>
                    void applyPatch(
                      { defaultGrant: next },
                      '已更新新标签页默认共享权限'
                    )
                  }
                />
              </div>

              <div className="settings-row">
                <div className="settings-row__copy">
                  <div className="text-sm font-medium">
                    允许运行页面 JavaScript (browser_eval)
                  </div>
                  <p className="settings-row__description text-sm">
                    允许 Agent 在已授权「允许控制」的标签页中执行自定义 JavaScript 表达式。
                  </p>
                </div>
                <SwitchControl
                  id="browser-eval-enabled"
                  checked={settings.evalEnabled}
                  disabled={!settings.toolsEnabled}
                  onChange={(checked) =>
                    void applyPatch(
                      { evalEnabled: checked },
                      checked
                        ? '已开启 JavaScript 执行能力'
                        : '已关闭 JavaScript 执行能力'
                    )
                  }
                  ariaLabel="允许运行页面 JavaScript (browser_eval)"
                />
              </div>

              {settings.evalEnabled ? (
                <div className="settings-row">
                  <div className="settings-row__copy">
                    <label
                      htmlFor={evalApprovalSelectId}
                      className="text-sm font-medium"
                    >
                      JavaScript 执行审批模式
                    </label>
                    <p className="settings-row__description text-sm">
                      选择每次执行脚本前弹窗确认，或在已授权控制的标签页上静默执行。
                    </p>
                  </div>
                  <AstryxSelect
                    id={evalApprovalSelectId}
                    ariaLabel="JavaScript 执行审批模式"
                    width={240}
                    disabled={!settings.toolsEnabled}
                    value={settings.evalApproval}
                    options={EVAL_APPROVAL_OPTIONS}
                    onChange={(next) =>
                      void applyPatch(
                        { evalApproval: next },
                        '已更新 JavaScript 审批模式'
                      )
                    }
                  />
                </div>
              ) : null}
            </fieldset>

            {originEntries.length > 0 ? (
              <NestedList
                title="已记住的站点共享授权"
                description="跨标签页自动应用的按站点 (Origin) 共享权限记录。"
                count={originEntries.length}
                countLabel="已记住的站点授权数量"
                listLabel="已记住的站点共享授权"
                action={
                  <SettingsButton
                    label="清空全部"
                    onClick={() =>
                      void applyPatch(
                        { originGrants: {} },
                        '已清空所有记住的站点授权'
                      )
                    }
                  />
                }
              >
                {originEntries.map(([origin, level], index) => (
                  <div
                    key={origin}
                    role="listitem"
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                    style={{
                      minHeight: '36px',
                      borderTop:
                        index > 0
                          ? '1px solid var(--border-subtle, hsl(var(--border)))'
                          : undefined,
                    }}
                  >
                    <code className="min-w-0 truncate font-mono text-sm">
                      {origin}
                    </code>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="settings-meta-chip px-1.5 py-0.5 font-mono text-xs">
                        {level === 'control'
                          ? '允许控制'
                          : level === 'read'
                            ? '仅限读取'
                            : '禁止访问'}
                      </span>
                      <SettingsButton
                        label="移除"
                        onClick={() => {
                          const nextOrigins = { ...settings.originGrants };
                          delete nextOrigins[origin];
                          void applyPatch({ originGrants: nextOrigins });
                        }}
                      />
                    </div>
                  </div>
                ))}
              </NestedList>
            ) : null}

            <NestedList
              title="当前打开的内置浏览器标签页"
              description="实时查看并调整每个活动标签页对 AI Agent 的共享权限，修改将立即与浏览器工具栏同步。"
              count={tabs.length}
              countLabel="当前打开标签页数量"
              listLabel="当前打开的内置浏览器标签页"
            >
              {tabs.length === 0 ? (
                <div
                  role="listitem"
                  className="px-3 py-4 text-center text-sm text-muted-foreground"
                >
                  当前没有打开的内置浏览器标签页。可在工作区右侧面板打开内置浏览器。
                </div>
              ) : (
                tabs.map((tab, index) => {
                  const currentLevel: BrowserGrantLevel =
                    tab.grant?.level ?? 'none';
                  const profileLabel = profileOptionLabel(
                    tab.profileId || 'default',
                    settings.profiles
                  );
                  return (
                    <div
                      key={tab.tabId}
                      role="listitem"
                      className="flex items-center justify-between gap-3 px-3 py-2"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--border-subtle, hsl(var(--border)))'
                            : undefined,
                      }}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">
                            {tab.title || '(无标题页面)'}
                          </span>
                          <span className="settings-meta-chip px-1.5 py-0.5 text-xs">
                            {profileLabel}
                          </span>
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {tab.url}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <AstryxSelect
                          ariaLabel={`标签页 ${tab.tabId} 共享权限`}
                          size="compact"
                          width={148}
                          value={currentLevel}
                          options={TAB_GRANT_OPTIONS}
                          onChange={(next) =>
                            void handleTabGrantChange(tab.tabId, next)
                          }
                        />
                        <SettingsButton
                          label="关闭"
                          onClick={() => void handleCloseTab(tab.tabId)}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </NestedList>
          </SectionGroup>

          {/* 3. 配置与站点规则 (Moved to bottom) */}
          <SectionGroup
            icon={<Icons.Layers />}
            title="配置与站点规则"
            description="管理独立的浏览器配置文件（Cookie、站点存储与登录状态隔离）以及按域名匹配的链接打开规则。"
          >
            {/* 3A. 配置文件 */}
            <div
              className="settings-row settings-row--stacked"
              style={{ gap: '10px' }}
            >
              <div className="settings-row__stack">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                    <Icons.User />
                  </span>
                  <span>配置文件</span>
                </div>
                <p className="settings-row__description text-sm">
                  每个配置文件有自己的 Cookie、站点存储和登录状态。新标签页在下方选定的配置文件中打开；标签页工具栏可以把当前页面在另一个配置文件里打开。
                </p>
              </div>

              <div className="flex w-full items-center justify-between gap-3">
                <label
                  htmlFor={defaultProfileSelectId}
                  className="inline-flex items-center gap-1.5 text-xs font-medium"
                >
                  <span className="text-muted-foreground">+</span>
                  <span>新标签页使用</span>
                </label>
                <AstryxSelect
                  id={defaultProfileSelectId}
                  ariaLabel="新标签页使用"
                  size="compact"
                  width={160}
                  value={settings.newTabProfile}
                  options={profileSelectOptions}
                  onChange={(next) => {
                    const name = profileOptionLabel(next, settings.profiles);
                    void applyPatch(
                      { newTabProfile: next },
                      `新标签页默认配置已切换为「${name}」`
                    );
                  }}
                />
              </div>

              <ProfileList
                profiles={settings.profiles}
                busyProfile={busyProfile}
                confirmClearProfile={confirmClearProfile}
                onRequestClear={(id) => setConfirmClearProfile(id)}
                onCancelClear={() => setConfirmClearProfile(null)}
                onConfirmClear={(id, name) => void handleClearProfile(id, name)}
                onRemoveProfile={(id, name) =>
                  void handleRemoveProfile(id, name)
                }
              />

              <div className="flex w-full items-center gap-2">
                <input
                  id={profileInputId}
                  type="text"
                  value={profileDraft}
                  onChange={(e) => {
                    setProfileDraft(e.target.value);
                    if (profileError) setProfileError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCreateProfile();
                    }
                  }}
                  placeholder="配置文件名称，例如「工作」"
                  className="min-w-[180px] flex-1 border px-3 text-xs outline-none"
                  style={{
                    height: '28px',
                    minHeight: '28px',
                    borderRadius: '8px',
                    padding: '0 10px',
                    border:
                      '1px solid var(--border-subtle, hsl(var(--border)))',
                    background:
                      'var(--surface-raised-control, var(--surface-control))',
                  }}
                />
                <SettingsButton
                  label="添加配置文件"
                  disabled={!profileDraft.trim() || busyProfile !== null}
                  onClick={() => void handleCreateProfile()}
                >
                  + 添加配置文件
                </SettingsButton>
              </div>

              {profileError ? (
                <p className="text-xs text-destructive" role="alert">
                  {profileError}
                </p>
              ) : null}
            </div>

            {/* 3B. 站点规则 */}
            <div
              className="settings-row settings-row--stacked border-t border-[var(--border-subtle,hsl(var(--border)))]"
              style={{ gap: '10px' }}
            >
              <div className="settings-row__stack">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                    <Icons.Globe />
                  </span>
                  <span>站点规则</span>
                </div>
                <p className="settings-row__description text-sm">
                  按域名与端口匹配，优先级高于默认链接打开方式。支持通配符（如{' '}
                  <code>*.corp.internal</code> 或 <code>localhost:*</code>）。
                </p>
              </div>

              <div className="flex w-full flex-wrap items-center gap-2">
                <input
                  id={ruleInputId}
                  aria-label="站点规则域名匹配模式"
                  type="text"
                  value={rulePattern}
                  onChange={(e) => {
                    setRulePattern(e.target.value);
                    if (ruleError) setRuleError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addRule();
                    }
                  }}
                  placeholder="例如 *.corp.internal、localhost:* 或 github.com"
                  className="h-8 min-w-[220px] flex-1 rounded-md border px-2.5 font-mono text-xs"
                  style={{
                    height: '32px',
                    minHeight: '32px',
                    borderRadius: '8px',
                    border:
                      '1px solid var(--border-subtle, hsl(var(--border)))',
                    background:
                      'var(--surface-raised-control, var(--surface-control))',
                  }}
                />
                <AstryxSelect
                  ariaLabel="站点规则动作"
                  width={180}
                  value={ruleAction}
                  options={RULE_ACTION_OPTIONS}
                  onChange={(next) => setRuleAction(next)}
                />
                <SettingsButton
                  label="添加规则"
                  disabled={!rulePattern.trim()}
                  onClick={() => addRule()}
                />
              </div>

              <div className="flex w-full flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">快速添加：</span>
                <SettingsButton
                  label="添加 localhost:* 内置规则"
                  onClick={() => addRule('localhost:*', 'builtin')}
                >
                  + localhost:* (内置)
                </SettingsButton>
                <SettingsButton
                  label="添加 127.0.0.1:* 内置规则"
                  onClick={() => addRule('127.0.0.1:*', 'builtin')}
                >
                  + 127.0.0.1:* (内置)
                </SettingsButton>
                <SettingsButton
                  label="添加 *.internal 系统规则"
                  onClick={() => addRule('*.internal', 'system')}
                >
                  + *.internal (系统)
                </SettingsButton>
              </div>

              {ruleError ? (
                <p className="text-xs text-destructive" role="alert">
                  {ruleError}
                </p>
              ) : null}
            </div>

            {settings.hostRules.map((rule, index) => (
              <div
                key={`${rule.pattern}-${rule.action}-${index}`}
                className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]"
              >
                <code className="settings-kbd rounded px-1.5 py-0.5 font-mono text-xs">
                  {rule.pattern}
                </code>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 text-[11px] font-medium ${
                      rule.action === 'block'
                        ? 'settings-status-pill-danger'
                        : rule.action === 'builtin'
                          ? 'settings-status-pill-success'
                          : 'settings-status-pill-neutral'
                    }`}
                  >
                    {ruleActionLabel(rule.action)}
                  </span>
                  <SettingsButton
                    label="移除"
                    onClick={() => removeRule(index)}
                  />
                </div>
              </div>
            ))}
          </SectionGroup>
        </div>
      </div>
    </div>
  );
}
