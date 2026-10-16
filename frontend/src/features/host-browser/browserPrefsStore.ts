import { useSyncExternalStore } from 'react';
import { backendCall } from '@/lib/backendTransport';

export type LinkOpenTarget = 'builtin' | 'system' | 'ask';
export type LinkOpenSource =
  | 'transcript'
  | 'toolCard'
  | 'terminal'
  | 'editor'
  | 'notification';

export type HostRuleAction = 'builtin' | 'system' | 'block';
export type BrowserRuleAction = HostRuleAction;

export interface HostRule {
  pattern: string;
  action: HostRuleAction;
}
export type BrowserHostRule = HostRule;

export type BrowserGrantLevel = 'none' | 'read' | 'control';
export type EvalApprovalMode = 'ask' | 'silent';
export type ServiceAutoOpenMode = 'off' | 'toast' | 'auto';
export type SurfaceOverrideMode = 'auto' | 'window';
export type BrowserSurfaceOverride = SurfaceOverrideMode;

export interface BrowserProfileRecord {
  id: string;
  label: string;
}

export interface BrowserDefaultTargets {
  transcript: LinkOpenTarget;
  toolCard: LinkOpenTarget;
  terminal: LinkOpenTarget;
  editor: LinkOpenTarget;
  notification: LinkOpenTarget;
}

export interface BrowserSettings {
  defaultTarget: BrowserDefaultTargets;
  hostRules: HostRule[];
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

export interface BrowserCapabilities {
  available: boolean;
  platform: string;
  surface: string;
  profiles: boolean;
  docGuest: boolean;
  proxy: {
    supported?: boolean;
    active?: string | null;
    source?: string;
    perProfile?: boolean;
    note?: string | null;
  };
  downloadsDir?: string | null;
  policy: {
    source: string;
    enabled: boolean;
    path?: string | null;
    managedRules: HostRule[];
    rulesCount: number;
  };
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  defaultTarget: {
    transcript: 'builtin',
    toolCard: 'builtin',
    terminal: 'builtin',
    editor: 'builtin',
    notification: 'builtin',
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
  profiles: [{ id: 'default', label: 'Default' }],
  newTabProfile: 'default',
};

const STORAGE_KEY = 'vibex:host-browser-prefs:v1';

export type HostRuleValidationError =
  | 'empty'
  | 'path'
  | 'scheme'
  | 'port'
  | 'wildcard'
  | 'host';

export type ParsedHostPattern = {
  scheme: 'http' | 'https' | null;
  wildcardSubdomain: boolean;
  host: string;
  port: '*' | number | null;
};

export function validateHostRulePattern(
  raw: string
): HostRuleValidationError | null {
  let trimmed = raw.trim().toLowerCase();
  if (!trimmed) return 'empty';

  if (trimmed.includes('://')) {
    if (trimmed.startsWith('http://')) {
      trimmed = trimmed.slice('http://'.length);
    } else if (trimmed.startsWith('https://')) {
      trimmed = trimmed.slice('https://'.length);
    } else {
      return 'scheme';
    }
  }

  if (
    trimmed.includes('/') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return 'path';
  }

  if (!trimmed) return 'host';

  let hostPart = trimmed;
  let portPart: string | null = null;

  if (trimmed.startsWith('[')) {
    const closeBracket = trimmed.indexOf(']');
    if (closeBracket < 0) return 'host';
    hostPart = trimmed.slice(0, closeBracket + 1);
    const rest = trimmed.slice(closeBracket + 1);
    if (rest.startsWith(':')) {
      portPart = rest.slice(1);
    } else if (rest.length > 0) {
      return 'host';
    }
  } else {
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx >= 0) {
      if (trimmed.indexOf(':') !== colonIdx) return 'host';
      hostPart = trimmed.slice(0, colonIdx);
      portPart = trimmed.slice(colonIdx + 1);
    }
  }

  if (portPart !== null) {
    if (portPart !== '*') {
      if (!/^\d+$/.test(portPart)) return 'port';
      const parsedPort = Number(portPart);
      if (parsedPort < 1 || parsedPort > 65535) return 'port';
    }
  }

  if (hostPart === '*') {
    return null;
  }
  if (hostPart.startsWith('*.')) {
    hostPart = hostPart.slice(2);
    if (!hostPart || hostPart.includes('*')) return 'wildcard';
  } else if (hostPart.includes('*')) {
    return 'wildcard';
  }

  if (!hostPart || /\s/.test(hostPart)) return 'host';
  if (hostPart.startsWith('[') && hostPart.endsWith(']')) {
    try {
      const hostname = new URL(`http://${hostPart}`).hostname;
      if (!hostname.includes(':')) return 'host';
    } catch {
      return 'host';
    }
    return null;
  }

  if (!/^[a-z0-9.-]+$/i.test(hostPart) || hostPart.startsWith('.') || hostPart.endsWith('.')) {
    return 'host';
  }

  return null;
}

export function parseHostRulePattern(raw: string): ParsedHostPattern | null {
  if (validateHostRulePattern(raw) !== null) return null;
  let trimmed = raw.trim().toLowerCase();
  let scheme: 'http' | 'https' | null = null;
  if (trimmed.startsWith('https://')) {
    scheme = 'https';
    trimmed = trimmed.slice('https://'.length);
  } else if (trimmed.startsWith('http://')) {
    scheme = 'http';
    trimmed = trimmed.slice('http://'.length);
  }

  let hostPart = trimmed;
  let portSpec: '*' | number | null = null;
  if (trimmed.startsWith('[')) {
    const closeBracket = trimmed.indexOf(']');
    hostPart = trimmed.slice(0, closeBracket + 1);
    const rest = trimmed.slice(closeBracket + 1);
    if (rest.startsWith(':')) {
      const portStr = rest.slice(1);
      portSpec = portStr === '*' ? '*' : Number(portStr);
    }
  } else {
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx > 0) {
      hostPart = trimmed.slice(0, colonIdx);
      const portStr = trimmed.slice(colonIdx + 1);
      portSpec = portStr === '*' ? '*' : Number(portStr);
    }
  }

  let wildcardSubdomain = false;
  if (hostPart.startsWith('*.')) {
    wildcardSubdomain = true;
    hostPart = hostPart.slice(2);
  }
  if (hostPart.startsWith('[') && hostPart.endsWith(']')) {
    try {
      hostPart = new URL(`http://${hostPart}`).hostname;
    } catch {
      return null;
    }
  }

  return {
    scheme,
    wildcardSubdomain,
    host: hostPart,
    port: portSpec,
  };
}

export function matchHostRule(pattern: string, rawUrl: string): boolean {
  const parsed = parseHostRulePattern(pattern);
  if (!parsed) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const urlScheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (parsed.scheme && parsed.scheme !== urlScheme) {
    return false;
  }

  const urlHost = url.hostname.toLowerCase();
  const hostOk =
    parsed.host === '*'
      ? true
      : parsed.wildcardSubdomain
        ? urlHost === parsed.host || urlHost.endsWith(`.${parsed.host}`)
        : urlHost === parsed.host;
  if (!hostOk) return false;

  const explicitPort = url.port ? Number(url.port) : null;
  const effectivePort =
    explicitPort ??
    (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : null);

  if (parsed.port === '*') {
    if (explicitPort === null && effectivePort === null) return false;
  } else if (typeof parsed.port === 'number') {
    if (effectivePort !== parsed.port) return false;
  }

  return true;
}

type RuleScore = [number, number, number, number];

function ruleScore(rule: HostRule, rawUrl: string): RuleScore | null {
  if (!matchHostRule(rule.pattern, rawUrl)) return null;
  const parsed = parseHostRulePattern(rule.pattern);
  if (!parsed) return null;
  let kind = 2;
  let len = parsed.host.length;
  if (parsed.host === '*') {
    kind = 0;
    len = 0;
  } else if (parsed.wildcardSubdomain) {
    kind = 1;
    len = parsed.host.length + 1;
  }
  const pinned = typeof parsed.port === 'number' ? 1 : 0;
  const restrict =
    rule.action === 'block' ? 2 : rule.action === 'system' ? 1 : 0;
  return [kind, len, pinned, restrict];
}

function scoreGreater(next: RuleScore, current: RuleScore): boolean {
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
}

export function evaluateHostRules(
  rules: readonly HostRule[],
  rawUrl: string
): HostRuleAction | null {
  let best: HostRuleAction | null = null;
  let bestScore: RuleScore | null = null;
  for (const rule of rules) {
    const score = ruleScore(rule, rawUrl);
    if (!score) continue;
    if (!bestScore || scoreGreater(score, bestScore)) {
      best = rule.action;
      bestScore = score;
    }
  }
  return best;
}

function parseLegacySiteRules(raw: string): HostRule[] {
  const result: HostRule[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    const colonIndex = trimmed.lastIndexOf(':');
    const sepIndex = eqIndex > 0 ? eqIndex : colonIndex;
    if (sepIndex <= 0) continue;
    const pattern = trimmed.slice(0, sepIndex).trim();
    const action = trimmed.slice(sepIndex + 1).trim().toLowerCase();
    if (
      (action === 'builtin' || action === 'system' || action === 'block') &&
      validateHostRulePattern(pattern) === null
    ) {
      result.push({ pattern, action });
    }
  }
  return result;
}

export function normalizeBrowserSettings(raw: unknown): BrowserSettings {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawTargets =
    obj.defaultTarget &&
    typeof obj.defaultTarget === 'object' &&
    !Array.isArray(obj.defaultTarget)
      ? (obj.defaultTarget as Record<string, unknown>)
      : obj.openLinks &&
          typeof obj.openLinks === 'object' &&
          !Array.isArray(obj.openLinks)
        ? (obj.openLinks as Record<string, unknown>)
        : {};

  const pickTarget = (val: unknown, fallback: LinkOpenTarget): LinkOpenTarget =>
    val === 'builtin' || val === 'system' || val === 'ask' ? val : fallback;

  const hostRules: HostRule[] = Array.isArray(obj.hostRules)
    ? obj.hostRules.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const rec = item as Record<string, unknown>;
        const pattern =
          typeof rec.pattern === 'string' ? rec.pattern.trim() : '';
        const action = rec.action;
        if (
          !pattern ||
          validateHostRulePattern(pattern) !== null ||
          (action !== 'builtin' && action !== 'system' && action !== 'block')
        ) {
          return [];
        }
        return [{ pattern, action }];
      })
    : typeof obj.siteRules === 'string'
      ? parseLegacySiteRules(obj.siteRules)
      : DEFAULT_BROWSER_SETTINGS.hostRules;

  const defaultGrant: BrowserGrantLevel =
    obj.defaultGrant === 'none' ||
    obj.defaultGrant === 'read' ||
    obj.defaultGrant === 'control'
      ? obj.defaultGrant
      : DEFAULT_BROWSER_SETTINGS.defaultGrant;

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

  const profiles: BrowserProfileRecord[] = Array.isArray(obj.profiles)
    ? obj.profiles.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === 'string' ? rec.id.trim() : '';
        const label = typeof rec.label === 'string' ? rec.label.trim() : '';
        if (!id || !label) return [];
        return [{ id, label }];
      })
    : [];
  if (!profiles.some((p) => p.id === 'default')) {
    profiles.unshift({ id: 'default', label: 'Default' });
  }

  const candidateProfile =
    typeof obj.newTabProfile === 'string' ? obj.newTabProfile.trim() : 'default';
  const newTabProfile =
    candidateProfile === 'ephemeral' ||
    (
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,35}$/.test(candidateProfile) &&
      profiles.some((p) => p.id === candidateProfile)
    )
      ? candidateProfile
      : 'default';

  return {
    defaultTarget: {
      transcript: pickTarget(
        rawTargets.transcript,
        DEFAULT_BROWSER_SETTINGS.defaultTarget.transcript
      ),
      toolCard: pickTarget(
        rawTargets.toolCard,
        DEFAULT_BROWSER_SETTINGS.defaultTarget.toolCard
      ),
      terminal: pickTarget(
        rawTargets.terminal,
        DEFAULT_BROWSER_SETTINGS.defaultTarget.terminal
      ),
      editor: pickTarget(
        rawTargets.editor,
        DEFAULT_BROWSER_SETTINGS.defaultTarget.editor
      ),
      notification: pickTarget(
        rawTargets.notification,
        DEFAULT_BROWSER_SETTINGS.defaultTarget.notification
      ),
    },
    hostRules,
    toolsEnabled:
      typeof obj.toolsEnabled === 'boolean'
        ? obj.toolsEnabled
        : DEFAULT_BROWSER_SETTINGS.toolsEnabled,
    defaultGrant,
    originGrants,
    evalEnabled:
      typeof obj.evalEnabled === 'boolean'
        ? obj.evalEnabled
        : DEFAULT_BROWSER_SETTINGS.evalEnabled,
    evalApproval:
      obj.evalApproval === 'silent' || obj.evalApproval === 'ask'
        ? obj.evalApproval
        : DEFAULT_BROWSER_SETTINGS.evalApproval,
    serviceAutoOpen:
      obj.serviceAutoOpen === 'off' ||
      obj.serviceAutoOpen === 'toast' ||
      obj.serviceAutoOpen === 'auto'
        ? obj.serviceAutoOpen
        : DEFAULT_BROWSER_SETTINGS.serviceAutoOpen,
    terminalClickMenu:
      typeof obj.terminalClickMenu === 'boolean'
        ? obj.terminalClickMenu
        : DEFAULT_BROWSER_SETTINGS.terminalClickMenu,
    devtools:
      typeof obj.devtools === 'boolean'
        ? obj.devtools
        : DEFAULT_BROWSER_SETTINGS.devtools,
    surfaceOverride:
      obj.surfaceOverride === 'window' || obj.surfaceOverride === 'auto'
        ? obj.surfaceOverride
        : DEFAULT_BROWSER_SETTINGS.surfaceOverride,
    suspendBackgroundTabs:
      typeof obj.suspendBackgroundTabs === 'boolean'
        ? obj.suspendBackgroundTabs
        : DEFAULT_BROWSER_SETTINGS.suspendBackgroundTabs,
    signInUserAgent:
      typeof obj.signInUserAgent === 'boolean'
        ? obj.signInUserAgent
        : DEFAULT_BROWSER_SETTINGS.signInUserAgent,
    profiles,
    newTabProfile,
  };
}

function readCachedSettings(): BrowserSettings {
  if (typeof window === 'undefined') return DEFAULT_BROWSER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BROWSER_SETTINGS;
    return normalizeBrowserSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_BROWSER_SETTINGS;
  }
}

function writeCachedSettings(settings: BrowserSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota errors */
  }
}

export type BrowserPrefsSnapshot = {
  pluginId: string | null;
  settings: BrowserSettings;
  capabilities: BrowserCapabilities | null;
  loading: boolean;
};

let state: BrowserPrefsSnapshot = {
  pluginId: null,
  settings: readCachedSettings(),
  capabilities: null,
  loading: false,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<BrowserPrefsSnapshot>): void {
  state = { ...state, ...patch };
  emit();
}

export function getBrowserPrefsSnapshot(): BrowserPrefsSnapshot {
  return state;
}

export function getBrowserSettings(): BrowserSettings {
  return state.settings;
}

export const getBrowserSettingsSnapshot = getBrowserSettings;

export function subscribeBrowserPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserPrefs(): BrowserPrefsSnapshot {
  return useSyncExternalStore(
    subscribeBrowserPrefs,
    getBrowserPrefsSnapshot,
    getBrowserPrefsSnapshot
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('vibex:browser-prefs-changed', (event) => {
    const custom = event as CustomEvent<unknown>;
    if (custom.detail && typeof custom.detail === 'object') {
      const normalized = normalizeBrowserSettings(custom.detail);
      state = { ...state, settings: normalized };
      emit();
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY && event.newValue) {
      try {
        const normalized = normalizeBrowserSettings(JSON.parse(event.newValue));
        state = { ...state, settings: normalized };
        emit();
      } catch {
        /* ignore */
      }
    }
  });
}

export async function resolveHostBrowserPluginId(
  explicitPluginId?: string | null
): Promise<string | null> {
  if (explicitPluginId) {
    if (state.pluginId !== explicitPluginId) {
      setState({ pluginId: explicitPluginId });
    }
    return explicitPluginId;
  }
  if (state.pluginId) return state.pluginId;
  try {
    const catalog = await backendCall<{
      items?: Array<{ pluginId: string; metadata?: unknown }>;
    }>('plugin_contribution_catalog');
    const match = (catalog?.items ?? []).find((item) => {
      const meta =
        item.metadata && typeof item.metadata === 'object'
          ? (item.metadata as Record<string, unknown>)
          : {};
      return meta.engine === 'host-browser';
    });
    if (match?.pluginId) {
      setState({ pluginId: match.pluginId });
      return match.pluginId;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function dispatchHostBrowser<T = unknown>(
  operation: string,
  input: Record<string, unknown> = {},
  explicitPluginId?: string | null
): Promise<T> {
  const pluginId = await resolveHostBrowserPluginId(explicitPluginId);
  if (!pluginId) {
    throw new Error('Host browser plugin is not enabled');
  }
  return backendCall<T>('plugin_invoke_contribution', {
    pluginId,
    handler: 'browser.dispatch',
    input: {
      operation,
      input,
    },
  });
}

export async function loadBrowserPrefs(
  explicitPluginId?: string | null
): Promise<BrowserPrefsSnapshot> {
  setState({ loading: true });
  const pluginId = await resolveHostBrowserPluginId(explicitPluginId);
  if (!pluginId) {
    setState({ loading: false });
    return state;
  }

  let merged = state.settings;
  try {
    const detail = await backendCall<{ config?: Record<string, unknown> }>(
      'plugin_product_detail',
      { pluginId }
    );
    if (detail?.config && typeof detail.config === 'object') {
      merged = normalizeBrowserSettings({ ...merged, ...detail.config });
    }
  } catch {
    /* fallback to cached or host state */
  }

  try {
    const synced = await dispatchHostBrowser<Record<string, unknown>>(
      'settings.set',
      merged as unknown as Record<string, unknown>,
      pluginId
    );
    merged = normalizeBrowserSettings(synced);
  } catch {
    try {
      const hostSettings = await dispatchHostBrowser<Record<string, unknown>>(
        'settings.get',
        {},
        pluginId
      );
      merged = normalizeBrowserSettings({ ...merged, ...hostSettings });
    } catch {
      /* keep merged */
    }
  }

  let capabilities = state.capabilities;
  try {
    capabilities = await dispatchHostBrowser<BrowserCapabilities>(
      'capabilities',
      {},
      pluginId
    );
  } catch {
    /* keep existing capabilities */
  }

  writeCachedSettings(merged);
  setState({
    pluginId,
    settings: merged,
    capabilities,
    loading: false,
  });
  return state;
}

export async function updateBrowserPrefs(
  patch: Partial<BrowserSettings>,
  explicitPluginId?: string | null
): Promise<BrowserSettings> {
  const next = normalizeBrowserSettings({
    ...state.settings,
    ...patch,
    defaultTarget: patch.defaultTarget
      ? { ...state.settings.defaultTarget, ...patch.defaultTarget }
      : state.settings.defaultTarget,
  });
  writeCachedSettings(next);
  setState({ settings: next });

  const pluginId = await resolveHostBrowserPluginId(explicitPluginId);
  if (!pluginId) return next;

  try {
    await backendCall('plugin_save_config', {
      pluginId,
      config: next as unknown as Record<string, unknown>,
    });
  } catch {
    /* ignore config file write error if worker sync succeeds */
  }

  try {
    const saved = await dispatchHostBrowser<Record<string, unknown>>(
      'settings.set',
      next as unknown as Record<string, unknown>,
      pluginId
    );
    const normalized = normalizeBrowserSettings(saved);
    writeCachedSettings(normalized);
    const capabilities = await dispatchHostBrowser<BrowserCapabilities>(
      'capabilities',
      {},
      pluginId
    ).catch(() => state.capabilities);
    setState({ settings: normalized, capabilities });
    return normalized;
  } catch {
    return next;
  }
}

export const updateBrowserSettings = updateBrowserPrefs;

export async function clearOriginGrants(
  explicitPluginId?: string | null
): Promise<BrowserSettings> {
  return updateBrowserPrefs({ originGrants: {} }, explicitPluginId);
}

export async function createBrowserProfile(
  label: string,
  explicitPluginId?: string | null
): Promise<BrowserProfileRecord> {
  const created = await dispatchHostBrowser<BrowserProfileRecord>(
    'profile.create',
    { label: label.trim() },
    explicitPluginId
  );
  await loadBrowserPrefs(explicitPluginId);
  const pluginId = await resolveHostBrowserPluginId(explicitPluginId);
  if (pluginId) {
    await backendCall('plugin_save_config', {
      pluginId,
      config: state.settings as unknown as Record<string, unknown>,
    }).catch(() => {});
  }
  return created;
}

export async function clearBrowserProfile(
  profileId: string,
  explicitPluginId?: string | null
): Promise<void> {
  await dispatchHostBrowser(
    'profile.clear',
    { profileId },
    explicitPluginId
  );
}

export async function removeBrowserProfile(
  profileId: string,
  explicitPluginId?: string | null
): Promise<void> {
  await dispatchHostBrowser(
    'profile.remove',
    { profileId },
    explicitPluginId
  );
  await loadBrowserPrefs(explicitPluginId);
  const pluginId = await resolveHostBrowserPluginId(explicitPluginId);
  if (pluginId) {
    await backendCall('plugin_save_config', {
      pluginId,
      config: state.settings as unknown as Record<string, unknown>,
    }).catch(() => {});
  }
}

export type ResolvedLinkDecision = 'builtin' | 'system' | 'ask' | 'block';

export function resolveLinkOpenAction(
  url: string,
  _source: LinkOpenSource = 'transcript',
  overrideSettings?: BrowserSettings
): ResolvedLinkDecision {
  const settings = overrideSettings ?? state.settings;
  const { capabilities } = state;
  if (capabilities?.policy && !capabilities.policy.enabled) {
    return 'system';
  }
  const managedRules = capabilities?.policy?.managedRules ?? [];
  const managedMatch = evaluateHostRules(managedRules, url);
  if (managedMatch) {
    return managedMatch;
  }
  const personalMatch = evaluateHostRules(settings.hostRules, url);
  if (personalMatch) {
    return personalMatch;
  }
  return settings.defaultTarget.transcript === 'system' ? 'system' : 'builtin';
}

/** Site-rule decision for the address bar. Ignores the default link opener. */
export function resolveSiteRuleAction(
  url: string,
  overrideSettings?: BrowserSettings
): HostRuleAction | null {
  const settings = overrideSettings ?? state.settings;
  const { capabilities } = state;
  if (capabilities?.policy && !capabilities.policy.enabled) {
    return 'system';
  }
  const managedMatch = evaluateHostRules(
    capabilities?.policy?.managedRules ?? [],
    url
  );
  if (managedMatch) return managedMatch;
  return evaluateHostRules(settings.hostRules, url);
}

export function resetBrowserPrefsForTests(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  state = {
    pluginId: null,
    settings: structuredClone(DEFAULT_BROWSER_SETTINGS),
    capabilities: null,
    loading: false,
  };
  emit();
}
