import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import appCss from '../../runtime/app.css?inline';
import { retainStyle } from '../styles/retainStyles';

// ============================================================================
// Types matching vibex-computer-helper daemon RPC responses (service.rs)
// ============================================================================

export type GrantLevel = 'none' | 'read' | 'control';
export type ActDelivery = 'background' | 'foreground';

export interface DefaultBlockEntry {
  key: string;
  name: string;
  blocked: boolean;
}

export interface LocalAppEntry {
  name: string;
  identifier: string;
  exeName?: string | null;
  path?: string | null;
  running?: boolean;
}

export interface PickedExecutable {
  canceled: boolean;
  path?: string | null;
  fileName?: string | null;
  name?: string | null;
}

export interface ComputerToolsSettings {
  enabled: boolean;
  envOverride: boolean | null;
  grantTimeoutSecs: number;
  stopShortcut: string;
  defaultStopShortcut: string;
  allowForeground: boolean;
  defaultDelivery: ActDelivery;
  defaultBlocklist: DefaultBlockEntry[];
  customBlocklist: string[];
  launchEnabled: boolean;
  clipboardEnabled: boolean;
  screenEnabled: boolean;
  showIndicator: boolean;
}

export interface PermissionGrant {
  kind: 'accessibility' | 'screen_recording' | 'input_monitoring';
  granted: boolean;
  canPrompt: boolean;
}

export interface PermissionReport {
  required: boolean;
  accessibility: boolean;
  screenRecording: boolean;
}

export interface VibexTccStatus {
  accessibility: boolean;
  screenRecording: boolean;
  selfResponsible: boolean;
}

export interface BackendStatusInfo {
  state?: 'ready' | 'starting' | 'stopped' | 'failed' | string;
  driverVersion?: string | null;
  peer?: string | null;
  detail?: string | null;
}

export interface ComputerStatus {
  enabled: boolean;
  platform: 'macos' | 'windows' | 'linux';
  shipping?: boolean;
  verifiedPlatform?: boolean;
  driverAvailable?: boolean;
  driverPath?: string | null;
  helperBundlePath?: string | null;
  backend?: BackendStatusInfo | null;
  permissions?: PermissionGrant[] | PermissionReport | null;
  vibexTcc?: VibexTccStatus | null;
  vibex?: VibexTccStatus | null;
  shared?: SharedWindow[];
  sharedCount?: number;
  screenOffered?: boolean;
  error?: string | null;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShareableWindow {
  targetId: string;
  windowId?: number;
  pid: number;
  appName: string;
  appKey?: string;
  appId?: string | null;
  title: string;
  bounds: WindowBounds;
  onScreen?: boolean;
  minimized: boolean;
  hidden: boolean;
  wholeApp?: boolean;
  wholeScreen?: boolean;
  notGrantable?: 'vibex' | 'blocklist' | 'unidentified' | string | null;
  grantable?: boolean;
  unshareableReason?: string | null;
  level: GrantLevel;
}

export interface SharedWindow {
  targetId: string;
  pid?: number;
  appName: string;
  appKey?: string;
  title: string;
  level: GrantLevel;
  grantedAt?: number;
  lastUsedAt?: number;
  wholeApp?: boolean;
  appId?: string | null;
  wholeScreen?: boolean;
  expiresAtMs?: number | null;
}

export interface SharedApp {
  appId: string;
  pid?: number;
  appName: string;
  appKey?: string;
  level: GrantLevel;
  grantedAt?: number;
  lastUsedAt?: number;
  windows?: number;
  windowCount?: number;
  expiresAtMs?: number | null;
}

export interface SharedScreen {
  targetId?: string;
  level: GrantLevel;
  windows?: number;
  grantedAt?: number;
  lastUsedAt?: number;
  expiresAtMs?: number | null;
}

export interface SharedState {
  shared: SharedWindow[];
  apps: SharedApp[];
  screen?: SharedScreen | null;
}

export type DriverState =
  | 'ready'
  | 'not_installed'
  | 'installing'
  | 'uninstalling'
  | 'unsupported';

export interface DriverTaskInfo {
  kind: 'installing' | 'uninstalling';
  downloadedMb?: number | null;
  totalMb?: number | null;
}

export interface DriverInfo {
  version: string;
  supported: boolean;
  state?: DriverState;
  installed?: string[];
  installedVersion?: string | null;
  path?: string | null;
  binaryPath?: string | null;
  task?: DriverTaskInfo | null;
  downloadedBytes?: number;
  totalBytes?: number | null;
  error?: string | null;
}

export interface StopKeyStatus {
  active?: string | null;
  failed?: string | null;
  detail?: string | null;
}

export interface ComputerActivityPayload {
  id?: string;
  targetId: string;
  app?: string | null;
  appName?: string;
  windowTitle?: string;
  action: string;
  delivery?: ActDelivery | null;
  outcome: 'done' | 'refused' | 'failed';
  at?: number;
  timestampMs?: number;
}

export interface PluginRemoteEnvironment {
  pluginId: string;
  surfaceId: string;
  slot: string;
  workspaceId?: string | null;
  projectId?: string | null;
  invoke: (
    handler: string,
    input?: Record<string, unknown> | null
  ) => Promise<unknown>;
}

// ============================================================================
// Constants & Helpers
// ============================================================================

const KEY_BY_CODE: Record<string, string> = {
  Escape: 'Escape',
  Minus: 'Minus',
  Equal: 'Equal',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Backquote: 'Backquote',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
  Digit0: 'Digit0',
  Digit1: 'Digit1',
  Digit2: 'Digit2',
  Digit3: 'Digit3',
  Digit4: 'Digit4',
  Digit5: 'Digit5',
  Digit6: 'Digit6',
  Digit7: 'Digit7',
  Digit8: 'Digit8',
  Digit9: 'Digit9',
  KeyA: 'KeyA',
  KeyB: 'KeyB',
  KeyC: 'KeyC',
  KeyD: 'KeyD',
  KeyE: 'KeyE',
  KeyF: 'KeyF',
  KeyG: 'KeyG',
  KeyH: 'KeyH',
  KeyI: 'KeyI',
  KeyJ: 'KeyJ',
  KeyK: 'KeyK',
  KeyL: 'KeyL',
  KeyM: 'KeyM',
  KeyN: 'KeyN',
  KeyO: 'KeyO',
  KeyP: 'KeyP',
  KeyQ: 'KeyQ',
  KeyR: 'KeyR',
  KeyS: 'KeyS',
  KeyT: 'KeyT',
  KeyU: 'KeyU',
  KeyV: 'KeyV',
  KeyW: 'KeyW',
  KeyX: 'KeyX',
  KeyY: 'KeyY',
  KeyZ: 'KeyZ',
};

const PRETTY_KEY_NAMES: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

const GRANT_TTL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 300, label: '5 分钟（闲置自动撤销）' },
  { value: 900, label: '15 分钟' },
  { value: 1800, label: '30 分钟（默认）' },
  { value: 3600, label: '1 小时' },
  { value: 0, label: '从不自动过期（仅手动停止）' },
];

const ACTION_LABELS: Record<string, string> = {
  screenshot: '截图',
  snapshot: '无障碍快照',
  verify: '元素校验',
  click: '点击',
  drag: '拖拽',
  scroll: '滚动',
  type: '输入文本',
  key: '按键',
  set_value: '设置值',
  invoke_menu: '菜单命令',
  window: '调整窗口',
  launch: '启动应用',
  clipboard: '剪贴板',
};

const DEFAULT_BLOCK_LABELS: Record<string, string> = {
  'system-settings': '系统设置 (System Settings)',
  'credential-prompts': '系统凭据与密码弹窗 (Password prompts)',
  keychain: '钥匙串访问 (Keychain Access)',
  seahorse: '密码和密钥 (Passwords and Keys)',
  kwallet: 'KWallet 密码管理器 (KWallet Manager)',
  passwords: '密码 (Passwords)',
};

const OPEN_BROKER_KINDS = new Set([
  'settings_page',
  'app_tab',
  'app_panel',
  'kanban_view',
  'app_surface',
]);

type BrokerCatalogItem = {
  pluginId?: string;
  id?: string;
  kind?: string;
  generation?: number;
};

export function catalogItems(catalog: unknown): BrokerCatalogItem[] {
  if (Array.isArray(catalog)) return catalog as BrokerCatalogItem[];
  if (
    catalog &&
    typeof catalog === 'object' &&
    Array.isArray((catalog as { items?: unknown }).items)
  ) {
    return (catalog as { items: BrokerCatalogItem[] }).items;
  }
  return [];
}

/** Status popovers are not App surfaces. Bind their Worker calls to the
 *  plugin's settings page (or another openable surface) instead. */
export function resolveBrokerSurface(
  items: BrokerCatalogItem[],
  pluginId: string,
  requestedId: string
): { id: string; generation: number } {
  const own = items.find(
    (item) => item.pluginId === pluginId && item.id === requestedId
  );
  if (
    own &&
    typeof own.kind === 'string' &&
    OPEN_BROKER_KINDS.has(own.kind) &&
    typeof own.generation === 'number'
  ) {
    return { id: requestedId, generation: own.generation };
  }
  const openable = items.filter(
    (item) =>
      item.pluginId === pluginId &&
      typeof item.id === 'string' &&
      typeof item.kind === 'string' &&
      OPEN_BROKER_KINDS.has(item.kind) &&
      typeof item.generation === 'number'
  );
  const chosen =
    openable.find((item) => item.kind === 'settings_page') ?? openable[0];
  if (chosen?.id && typeof chosen.generation === 'number') {
    return { id: chosen.id, generation: chosen.generation };
  }
  return {
    id: requestedId,
    generation: typeof own?.generation === 'number' ? own.generation : 1,
  };
}

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    for (const key of [
      'message',
      'error',
      'detail',
      'reason',
      'description',
      'cause',
    ]) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim()) {
        return val;
      }
      if (val && typeof val === 'object') {
        const nested = formatErrorMessage(val);
        if (nested && nested !== '[object Object]') {
          return nested;
        }
      }
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      // ignore
    }
  }
  return String(err);
}

function settingsEqual(
  a: ComputerToolsSettings | null,
  b: ComputerToolsSettings | null
): boolean {
  if (!a || !b) return false;
  if (
    a.grantTimeoutSecs !== b.grantTimeoutSecs ||
    a.allowForeground !== b.allowForeground ||
    a.defaultDelivery !== b.defaultDelivery ||
    a.launchEnabled !== b.launchEnabled ||
    a.clipboardEnabled !== b.clipboardEnabled ||
    a.screenEnabled !== b.screenEnabled ||
    a.showIndicator !== b.showIndicator ||
    a.stopShortcut !== b.stopShortcut
  ) {
    return false;
  }
  const aCustom = a.customBlocklist ?? [];
  const bCustom = b.customBlocklist ?? [];
  if (aCustom.length !== bCustom.length) return false;
  if (!aCustom.every((item, idx) => item === bCustom[idx])) return false;
  const aDefault = a.defaultBlocklist ?? [];
  const bDefault = b.defaultBlocklist ?? [];
  if (aDefault.length !== bDefault.length) return false;
  return aDefault.every(
    (item, idx) =>
      item.key === bDefault[idx]?.key &&
      item.blocked === bDefault[idx]?.blocked
  );
}

function formatShortcutParts(
  shortcut: string,
  platform: 'macos' | 'windows' | 'linux'
): string[] {
  if (!shortcut) return [];
  return shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (platform === 'macos') {
        if (lower === 'command' || lower === 'cmd' || lower === 'super')
          return '⌘';
        if (lower === 'option' || lower === 'opt' || lower === 'alt')
          return '⌥';
        if (lower === 'control' || lower === 'ctrl') return '⌃';
        if (lower === 'shift') return '⇧';
      } else {
        if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
        if (lower === 'alt' || lower === 'opt' || lower === 'option')
          return 'Alt';
        if (lower === 'shift') return 'Shift';
        if (lower === 'super' || lower === 'win' || lower === 'meta')
          return 'Win';
      }
      if (part === 'Escape') return 'Esc';
      if (part.startsWith('Key') && part.length === 4) return part.slice(3);
      if (part.startsWith('Digit') && part.length === 6) return part.slice(5);
      return PRETTY_KEY_NAMES[part] ?? part;
    });
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return '刚刚';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 5) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour} 小时前`;
}

function normalizePermissions(
  permissions: ComputerStatus['permissions']
): PermissionGrant[] {
  if (!permissions) return [];
  if (Array.isArray(permissions)) return permissions;
  if (typeof permissions === 'object' && 'required' in permissions) {
    if (!permissions.required) return [];
    return [
      {
        kind: 'accessibility',
        granted: Boolean(permissions.accessibility),
        canPrompt: true,
      },
      {
        kind: 'screen_recording',
        granted: Boolean(permissions.screenRecording),
        canPrompt: true,
      },
    ];
  }
  return [];
}

function resolveDriverView(
  driverInfo: DriverInfo | null,
  status: ComputerStatus | null
) {
  const taskKind = driverInfo?.task?.kind;
  const installedList = Array.isArray(driverInfo?.installed)
    ? driverInfo.installed
    : [];
  const binaryPath =
    driverInfo?.binaryPath ?? driverInfo?.path ?? status?.driverPath ?? null;
  const version =
    driverInfo?.version ?? status?.backend?.driverVersion ?? '0.32.0';
  const installedVersion =
    driverInfo?.installedVersion ??
    installedList[0] ??
    (binaryPath ? version : null);

  let state: DriverState = 'not_installed';
  if (driverInfo?.state) {
    state = driverInfo.state;
  } else if (taskKind === 'installing') {
    state = 'installing';
  } else if (taskKind === 'uninstalling') {
    state = 'uninstalling';
  } else if (driverInfo && driverInfo.supported === false) {
    state = 'unsupported';
  } else if (
    binaryPath ||
    installedList.length > 0 ||
    status?.driverAvailable ||
    status?.backend?.state === 'ready'
  ) {
    state = 'ready';
  }

  const downloadedBytes =
    driverInfo?.downloadedBytes ??
    (driverInfo?.task?.downloadedMb != null
      ? Math.round(driverInfo.task.downloadedMb * 1024 * 1024)
      : 0);
  const totalBytes =
    driverInfo?.totalBytes ??
    (driverInfo?.task?.totalMb != null
      ? Math.round(driverInfo.task.totalMb * 1024 * 1024)
      : null);

  const isAvailable =
    state === 'ready' ||
    Boolean(status?.driverAvailable) ||
    status?.backend?.state === 'ready';

  const error =
    driverInfo?.error ??
    (status?.backend?.state === 'failed' ? status?.backend?.detail : null) ??
    null;

  return {
    version,
    state,
    binaryPath,
    installedVersion,
    downloadedBytes,
    totalBytes,
    isAvailable,
    error,
  };
}


// ============================================================================
// Tahoe Settings Primitive Components
// ============================================================================

function SwitchControl({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-[var(--surface-control)] transition-colors data-[state=checked]:border-[var(--switch-checked-border)] data-[state=checked]:bg-[var(--switch-checked-track)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        data-state={checked ? 'checked' : 'unchecked'}
        className="pointer-events-none block h-4 w-4 translate-x-0.5 rounded-full bg-background shadow-[var(--shadow-switch-thumb)] ring-0 transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[var(--switch-checked-thumb)] data-[state=unchecked]:translate-x-0.5"
      />
    </button>
  );
}

function AstryxButton({
  variant = 'secondary',
  size = 'md',
  disabled = false,
  onClick,
  title,
  ariaLabel,
  icon,
  children,
  className = '',
  style,
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'mini' | 'compact' | 'sm' | 'md';
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  title?: string;
  ariaLabel?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const variantClasses =
    variant === 'primary'
      ? 'x1ewilqj x17wrial x1ilzqfv xq8i9tn x17nn4n9 xkzo27j x1wfwxd8 x13aywxo'
      : variant === 'ghost'
        ? 'xjbqb8w x1tgivj0 x1ilzqfv xq8i9tn x17nn4n9 xkzo27j x1wfwxd8 x13aywxo'
        : variant === 'destructive'
          ? 'destructive x1pjz0fi x1m024r3 x1ilzqfv xq8i9tn x1p73he7 xkzo27j x1wfwxd8 x13aywxo'
          : 'x17x4s8c x1tgivj0 x1ilzqfv xq8i9tn x17nn4n9 xkzo27j x1wfwxd8 x13aywxo';

  const sizeClass = size === 'md' ? 'x1ueg155' : 'x6k0iem';
  const metrics =
    size === 'mini'
      ? { height: 22, font: '11px', pad: 7, icon: 12, gap: 4 }
      : size === 'compact'
        ? { height: 26, font: '12px', pad: 8, icon: 14, gap: 5 }
        : size === 'sm'
          ? {
              height: 28,
              font: 'var(--text-label-size, 0.875rem)',
              pad: 12,
              icon: 16,
              gap: 8,
            }
          : {
              height: 32,
              font: 'var(--text-label-size, 0.875rem)',
              pad: 12,
              icon: 16,
              gap: 8,
            };
  const disabledClasses = disabled
    ? 'x1h6gzvc xbyyjgo x18o3ruo x1c071of x1pdlv7q'
    : 'x3oybdh xk4oym4';

  const fallbackBg =
    variant === 'primary'
      ? 'var(--color-accent, hsl(var(--primary)))'
      : variant === 'ghost'
        ? 'transparent'
        : variant === 'destructive'
          ? 'var(--color-negative, hsl(var(--destructive)))'
          : 'var(--color-neutral, var(--surface-control-solid, hsl(220 14% 94%)))';

  const fallbackColor =
    variant === 'primary'
      ? 'var(--color-on-accent, hsl(var(--primary-foreground)))'
      : variant === 'destructive'
        ? 'var(--color-on-negative, #ffffff)'
        : 'var(--color-text-primary, var(--text-strong, hsl(var(--foreground))))';

  const resolvedFontSize = metrics.font;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      data-variant={variant}
      data-size={size}
      className={`astryx-button ${variant} ${size} x1n2onr6 x3nfvp2 x6s0dn4 xl56j7k x1txdalj xce4md1 xrrkdod xc342km xng3xce x1jxw6zd xjb2p0i x1kq96og x1e4wzip xuxw1ft x1ypdohk xrafxwg xuedmi6 x12w9bfk xlr8y92 x1gnnqk1 ${sizeClass} ${variantClasses} ${disabledClasses} ${className}`.trim()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: `${metrics.gap}px`,
        height: `${metrics.height}px`,
        minHeight: `${metrics.height}px`,
        paddingInline: `${metrics.pad}px`,
        border: 'none',
        borderRadius: 'var(--_button-radius, var(--radius-element, 8px))',
        backgroundColor: fallbackBg,
        color: fallbackColor,
        fontSize: resolvedFontSize,
        fontWeight: 'var(--font-weight-medium, 500)',
        lineHeight: 'var(--text-label-leading, 1.4286)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        boxShadow: 'none',
        ...style,
      }}
    >
      {icon ? (
        <span
          className="astryx-button-icon x3nfvp2 x6s0dn4 xl56j7k x2lah0s"
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: `${metrics.icon}px`,
            height: `${metrics.icon}px`,
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
      ) : null}
      <span
        className="astryx-button-content xjp7ctv"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: resolvedFontSize,
          lineHeight: 1,
        }}
      >
        {children}
      </span>
    </button>
  );
}

function AstryxSearchInput({
  id: idProp,
  value,
  onChange,
  onKeyDown,
  placeholder,
  ariaLabel,
  className = '',
  style,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  ariaLabel?: string;
  showSearchIcon?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const generatedId = useId();
  const inputId = idProp ?? `astryx-ti-${generatedId}`;
  const labelId = `astryx-ti-label-${generatedId}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const labelText = ariaLabel || placeholder || '搜索';

  return (
    <div
      className={`astryx-field ${className}`.trim()}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 200px',
        minWidth: 0,
        width: '100%',
        ...style,
      }}
    >
            <label
        id={labelId}
        htmlFor={inputId}
        className="astryx-field-label"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {labelText}
      </label>
      <div
        data-size="md"
        className="astryx-text-input md"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={value}
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="astryx-text-input__inner"
        />
        {value !== '' ? (
          <button
            type="button"
            className="astryx-text-input__clear"
            aria-label={`清除 ${labelText}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              inputRef.current?.focus();
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: '16px', height: '16px', display: 'block' }}
              aria-hidden="true"
            >
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface SettingsSelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

function SettingsSelect<T extends string | number>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  size = 'default',
  width = 220,
}: {
  id?: string;
  value: T;
  options: Array<SettingsSelectOption<T>>;
  onChange: (next: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  size?: 'default' | 'compact';
  width?: number | string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : options[0];

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportH =
      typeof window !== 'undefined' ? window.innerHeight || 768 : 768;
    const viewportW =
      typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024;
    const gap = 4;
    const minMenuWidth =
      typeof width === 'number'
        ? Math.max(rect.width, width)
        : Math.max(rect.width, 120);
    const spaceBelow = viewportH - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      280,
      Math.max(120, openAbove ? spaceAbove - 8 : spaceBelow - 8)
    );
    const estimatedMenuHeight = Math.min(maxHeight, options.length * 32 + 10);
    const top = openAbove
      ? Math.max(8, rect.top - gap - estimatedMenuHeight)
      : rect.bottom + gap;
    const left = Math.max(
      8,
      Math.min(rect.left, viewportW - minMenuWidth - 8)
    );
    setMenuPos({
      top,
      left,
      width: minMenuWidth,
      maxHeight,
    });
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
    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (rootRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const selectAtIndex = (index: number) => {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      } else {
        setActiveIndex((prev) => (prev + 1) % options.length);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      } else {
        setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && activeIndex >= 0) {
        selectAtIndex(activeIndex);
      } else {
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const portalRoot =
    rootRef.current?.closest('.settings-page, [data-astryx-theme], .legacy-design') ??
    (typeof document !== 'undefined' ? document.body : null);

  const resolvedFontSize = size === 'compact' ? '11.5px' : '12px';

  const menuNode =
    open && menuPos ? (
      <div
        ref={menuRef}
        id={menuId}
        role="listbox"
        aria-label={ariaLabel}
        data-floating-layer="popover"
        className="astryx-select-menu tahoe-popover x1n2onr6 x1prclbq x1hviunn x1i5ehqx xrzjruh"
        style={{
          position: 'fixed',
          zIndex: 10005,
          top: `${menuPos.top}px`,
          left: `${menuPos.left}px`,
          width: `${menuPos.width}px`,
          maxHeight: `${menuPos.maxHeight}px`,
          padding: 'var(--spacing-1, 4px)',
          borderRadius: 'var(--radius-container, 12px)',
          backgroundColor:
            'var(--color-background-popover, var(--surface-popover, #ffffff))',
          border:
            '1px solid var(--border-glass, var(--color-border, rgba(0, 0, 0, 0.08)))',
          boxShadow:
            'var(--shadow-popover, var(--shadow-low, 0 8px 24px rgba(0, 0, 0, 0.12)))',
          fontSize: resolvedFontSize,
          lineHeight: 1.35,
          boxSizing: 'border-box',
          overflowY: 'auto',
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
              className={`astryx-select-option x9f619 x78zum5 x6s0dn4 x1qughib x1txdalj xh8yej3 xlsj2fj xh6dtrn x9ynric x1tgivj0 xjbqb8w x1ypdohk x1yc453h x1a2a7pz ${
                size === 'compact' ? 'xu0wf1k xf314gf' : 'x1vofgu7'
              } ${isActive ? 'x1lmrjuc' : ''} ${isSelected ? 'x1e4wzip' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--spacing-2, 8px)',
                padding:
                  size === 'compact'
                    ? 'var(--spacing-1, 5px) var(--spacing-2, 8px)'
                    : 'var(--spacing-1-5, 6px) var(--spacing-2, 8px)',
                borderRadius: 'var(--radius-element, 8px)',
                fontSize: resolvedFontSize,
                lineHeight: 1.35,
                fontWeight: isSelected
                  ? 'var(--font-weight-medium, 500)'
                  : 'var(--font-weight-normal, 400)',
                color: 'var(--color-text-primary, var(--text-strong))',
                backgroundColor: isActive
                  ? 'var(--color-overlay-hover, var(--surface-control-hover, rgba(0, 0, 0, 0.05)))'
                  : 'transparent',
                cursor: opt.disabled ? 'not-allowed' : 'pointer',
                opacity: opt.disabled ? 0.5 : 1,
                userSelect: 'none',
              }}
              onMouseEnter={() => {
                if (!opt.disabled) setActiveIndex(idx);
              }}
              onClick={() => selectAtIndex(idx)}
            >
              <span
                className="astryx-select-option-label"
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: resolvedFontSize,
                  lineHeight: 1.35,
                }}
              >
                {opt.label}
              </span>
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
                  style={{
                    flexShrink: 0,
                    width: '14px',
                    height: '14px',
                    color: 'var(--color-icon-accent, var(--color-accent, hsl(var(--primary))))',
                  }}
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
      className={`astryx-select ${size === 'compact' ? 'astryx-select--compact' : ''}`}
      style={{
        display: 'inline-block',
        width: typeof width === 'number' ? `${width}px` : width,
        maxWidth: '100%',
        flexShrink: 0,
      }}
    >
      <div
        ref={triggerRef}
        id={id}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-disabled={disabled || undefined}
        className={`astryx-selector input ${
          size === 'compact' ? 'sm x6k0iem' : 'md x1ueg155'
        } astryx-select-trigger ${
          open ? 'is-open' : ''
        } x9f619 x1n2onr6 x1vjfegm x78zum5 x6s0dn4 x1litavf x1y0btm7 xvy26l8 x6q1khz x1832zxr xvdfih8 x10xzikg x12zzom9 xuedmi6 x12w9bfk xlr8y92 x1gnnqk1 x12y27fx xuihb5h x1a2a7pz x1qughib x1txdalj xh8yej3 xce4md1 xrrkdod x9ynric x1kq96og x1tgivj0 x1ypdohk`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: size === 'compact' ? '6px' : 'var(--spacing-2, 8px)',
          width: '100%',
          height:
            size === 'compact'
              ? 'var(--size-element-sm, 28px)'
              : 'var(--size-element-md, 32px)',
          minHeight:
            size === 'compact'
              ? 'var(--size-element-sm, 28px)'
              : 'var(--size-element-md, 32px)',
          paddingInline:
            size === 'compact' ? 'var(--spacing-2, 8px)' : '10px',
          borderRadius: 'var(--_field-radius, var(--radius-element, 10px))',
          fontSize: resolvedFontSize,
          lineHeight: 1.25,
          fontWeight: 'var(--font-weight-normal, 400)',
          userSelect: 'none',
          boxSizing: 'border-box',
          ...(open
            ? {
                borderColor: 'var(--color-accent, hsl(var(--primary)))',
                boxShadow:
                  'inset 0 0 0 2px var(--color-accent-muted, hsl(var(--primary) / 0.16))',
              }
            : {}),
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
        <span
          className="astryx-select-trigger-label x1lliihq x6ikm8r x10wlt62 xlyipyv xuxw1ft"
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: resolvedFontSize,
            lineHeight: 1.25,
          }}
        >
          {selected ? selected.label : ''}
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
          style={{
            flexShrink: 0,
            width: size === 'compact' ? '12px' : '14px',
            height: size === 'compact' ? '12px' : '14px',
            color: 'var(--color-icon-secondary, var(--text-muted))',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>

      {menuNode
        ? portalRoot
          ? createPortal(menuNode, portalRoot)
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
            <p className="settings-section__description">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="settings-card rounded-lg border">
        {children}
      </div>
    </section>
  );
}

const Icons = {
  Monitor: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  ),
  AppWindow: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 4v4" />
      <path d="M2 8h20" />
      <path d="M6 4v4" />
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
      <path d="M15 2v2" />
      <path d="M15 20v2" />
      <path d="M2 15h2" />
      <path d="M2 9h2" />
      <path d="M20 15h2" />
      <path d="M20 9h2" />
      <path d="M9 2v2" />
      <path d="M9 20v2" />
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
    </svg>
  ),
  MousePointer: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      <path d="m13 13 6 6" />
    </svg>
  ),
  Ban: () => (
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
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  ),
  Activity: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </svg>
  ),
  Refresh: ({ spinning }: { spinning?: boolean }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 ${spinning ? 'animate-spin' : ''}`}
      style={{ width: '13px', height: '13px' }}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  ),
  OctagonStop: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  ),
};

// ============================================================================
// Window & Application Picker Modal
// ============================================================================

function isWindowGrantable(win: ShareableWindow): boolean {
  if (typeof win.grantable === 'boolean') return win.grantable;
  return !win.notGrantable;
}

function getUnshareableReason(win: ShareableWindow): string | null {
  if (win.unshareableReason) return win.unshareableReason;
  if (win.notGrantable === 'vibex') return '宿主自身窗口受保护';
  if (win.notGrantable === 'blocklist') return '位于永不共享名单中';
  if (win.notGrantable) return String(win.notGrantable);
  return null;
}

const THUMB_TTL_MS = 8_000;
const THUMB_MAX_INFLIGHT = 3;
const thumbCache = new Map<string, { url: string; key: string; at: number }>();
let thumbInflight = 0;
const thumbWaiters: Array<() => void> = [];

function thumbCacheKey(win: ShareableWindow): string {
  return `${win.targetId}:${Math.round(win.bounds.width)}x${Math.round(win.bounds.height)}:${win.minimized ? 1 : 0}:${win.hidden ? 1 : 0}`;
}

async function withThumbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (thumbInflight >= THUMB_MAX_INFLIGHT) {
    await new Promise<void>((resolve) => {
      thumbWaiters.push(resolve);
    });
  }
  thumbInflight += 1;
  try {
    return await fn();
  } finally {
    thumbInflight -= 1;
    thumbWaiters.shift()?.();
  }
}

function WindowPreview({
  win,
  invoke,
}: {
  win: ShareableWindow;
  invoke: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const requestKey = thumbCacheKey(win);
  const grantable = isWindowGrantable(win);
  const [src, setSrc] = useState<string | null>(() => {
    const hit = thumbCache.get(win.targetId);
    if (hit && hit.key === requestKey && Date.now() - hit.at < THUMB_TTL_MS) {
      return hit.url;
    }
    return null;
  });

  useEffect(() => {
    const hit = thumbCache.get(win.targetId);
    if (hit && hit.key === requestKey && Date.now() - hit.at < THUMB_TTL_MS) {
      setSrc(hit.url);
      return;
    }
    setSrc(null);
    if (!grantable || win.minimized || win.hidden) return;

    let cancelled = false;
    const load = () => {
      const cached = thumbCache.get(win.targetId);
      if (
        cached &&
        cached.key === requestKey &&
        Date.now() - cached.at < THUMB_TTL_MS
      ) {
        if (!cancelled) setSrc(cached.url);
        return;
      }
      void withThumbSlot(async () => {
        if (cancelled) return;
        try {
          const dataUrl = await invoke('computer.windowThumbnail', {
            targetId: win.targetId,
          });
          if (cancelled) return;
          if (typeof dataUrl === 'string' && dataUrl) {
            thumbCache.set(win.targetId, {
              url: dataUrl,
              key: requestKey,
              at: Date.now(),
            });
            setSrc(dataUrl);
          }
        } catch {
          // placeholder stays
        }
      });
    };

    const node = hostRef.current;
    if (typeof IntersectionObserver === 'undefined' || !node) {
      load();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
          io.disconnect();
        }
      },
      { rootMargin: '120px' }
    );
    io.observe(node);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [
    grantable,
    invoke,
    requestKey,
    win.hidden,
    win.minimized,
    win.targetId,
  ]);

  return (
    <div
      ref={hostRef}
      className="relative mb-2.5 flex h-28 w-full items-center justify-center overflow-hidden rounded-md border border-[var(--border-subtle,hsl(var(--border)))] bg-black/20"
    >
      {src ? (
        <img
          src={src}
          alt={win.title || win.appName}
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="text-xs text-muted-foreground">
          {win.appName} ({win.bounds.width}×{win.bounds.height})
        </span>
      )}
      {win.level !== 'none' ? (
        <span
          className={`absolute top-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
            win.level === 'control'
              ? 'bg-primary text-primary-foreground'
              : 'settings-status-pill-success'
          }`}
        >
          {win.level === 'control' ? '允许控制' : '仅查看'}
        </span>
      ) : null}
    </div>
  );
}

function WindowPickerModal({
  open,
  onClose,
  screenEnabled,
  sharedState,
  invoke,
  onSharedChanged,
  embedded = false,
}: {
  open: boolean;
  onClose: () => void;
  screenEnabled: boolean;
  embedded?: boolean;
  sharedState: SharedState | null;
  invoke: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  onSharedChanged: (nextState: SharedState) => void;
}) {
  const [windows, setWindows] = useState<ShareableWindow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showBlocked, setShowBlocked] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadWindows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await invoke('computer.listShareableWindows', {})) as
        | ShareableWindow[]
        | null;
      const items = Array.isArray(list) ? list : [];
      setWindows(items);
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  useEffect(() => {
    if (open) {
      void loadWindows();
    }
  }, [open, loadWindows]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const filteredWindows = windows.filter((win) => {
    if (!showBlocked && !isWindowGrantable(win)) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      win.appName.toLowerCase().includes(q) ||
      win.title.toLowerCase().includes(q) ||
      String(win.pid).includes(q)
    );
  });

  const handleShareWindow = async (targetId: string, level: GrantLevel) => {
    setBusyId(targetId);
    setError(null);
    try {
      await invoke('computer.shareWindow', { targetId, level });
      const nextState = (await invoke(
        'computer.sharedState',
        {}
      )) as SharedState;
      onSharedChanged(nextState);
      setWindows((prev) =>
        prev.map((w) => (w.targetId === targetId ? { ...w, level } : w))
      );
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleShareApp = async (targetId: string, level: GrantLevel) => {
    setBusyId(`app:${targetId}`);
    setError(null);
    try {
      const nextState = (await invoke('computer.shareApp', {
        targetId,
        level,
      })) as SharedState;
      onSharedChanged(nextState);
      await loadWindows();
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleShareScreen = async (level: GrantLevel) => {
    setBusyId('screen');
    setError(null);
    try {
      const nextState = (await invoke('computer.shareScreen', {
        level,
      })) as SharedState;
      onSharedChanged(nextState);
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const currentScreenLevel: GrantLevel = sharedState?.screen?.level ?? 'none';

  return (
    <div
      data-floating-layer={embedded ? undefined : 'modal'}
      className={
        embedded
          ? 'flex h-full min-h-0 w-full flex-col'
          : 'fixed inset-0 z-[9999] flex items-center justify-center p-4'
      }
      style={
        embedded
          ? { display: 'flex', height: '100%', minHeight: 0, width: '100%' }
          : {
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
            }
      }
    >
      {embedded ? null : (
        <div
          className="dialog-backdrop fixed inset-0"
          aria-hidden="true"
          style={{ position: 'fixed', inset: 0 }}
          onClick={onClose}
        />
      )}
      <div
        role="dialog"
        aria-modal={embedded ? undefined : true}
        aria-label={embedded ? '电脑控制' : '选择要共享给 Agent 的桌面窗口'}
        className="dialog-surface relative z-[9999] flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border"
        style={{
          position: 'relative',
          zIndex: embedded ? 1 : 9999,
          display: 'flex',
          flexDirection: 'column',
          width: embedded ? '100%' : 'min(100%, 720px)',
          height: embedded ? '100%' : undefined,
          maxHeight: embedded ? '100%' : 'min(78vh, 620px)',
          overflow: 'hidden',
          borderRadius: embedded ? 0 : 'var(--radius-container, 12px)',
          border: embedded
            ? 'none'
            : '1px solid var(--border-glass, hsl(var(--border)))',
          background: 'var(--surface-dialog, hsl(var(--popover)))',
          boxShadow: embedded
            ? 'none'
            : 'var(--shadow-popover, 0 24px 64px rgba(0, 0, 0, 0.28))',
        }}
      >
        <div
          className="flex items-start justify-between gap-4"
          style={{ flexShrink: 0, padding: '22px 24px 14px' }}
        >
          <div style={{ minWidth: 0 }}>
            <h3
              className="text-sm font-semibold"
              style={{
                margin: 0,
                fontSize: '15px',
                fontWeight: 600,
                lineHeight: 1.4,
                color: 'var(--color-text-primary, var(--text-strong))',
              }}
            >
              选择共享窗口或应用
            </h3>
            <p
              className="text-xs text-muted-foreground"
              style={{
                margin: '4px 0 0',
                fontSize: '12px',
                lineHeight: 1.5,
                color: 'var(--color-text-secondary, var(--text-muted))',
              }}
            >
              仅被明确授权的窗口可被 Agent 查看或操作；未授权窗口将保持隔离。
            </p>
          </div>
          {embedded ? null : (
            <AstryxButton variant="primary" size="md" onClick={onClose}>
              完成
            </AstryxButton>
          )}
        </div>

        <div
          className="flex flex-wrap items-center gap-2.5"
          style={{ flexShrink: 0, padding: '0 24px 14px' }}
        >
          <AstryxSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="搜索窗口标题、应用名称或 PID..."
            ariaLabel="搜索窗口标题、应用名称或 PID"
            className="min-w-0 flex-1"
            style={{ flex: '1 1 200px', minWidth: '180px' }}
          />
          <div className="flex shrink-0 items-center gap-2">
            <SwitchControl
              checked={showBlocked}
              onChange={setShowBlocked}
              ariaLabel="显示受保护/不可共享窗口"
            />
            <span
              onClick={() => setShowBlocked(!showBlocked)}
              className="cursor-pointer text-xs text-muted-foreground select-none"
            >
              显示受保护/不可共享窗口
            </span>
          </div>
          <AstryxButton
            variant="secondary"
            size="md"
            disabled={loading}
            onClick={() => void loadWindows()}
            icon={<Icons.Refresh spinning={loading} />}
          >
            刷新列表
          </AstryxButton>
        </div>

        {error ? (
          <div
            className="settings-message settings-message-error px-3 py-2 text-xs"
            role="alert"
            style={{ flexShrink: 0, margin: '0 24px 12px' }}
          >
            {error}
          </div>
        ) : null}

        {screenEnabled ? (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-content,hsl(var(--border)))] bg-[var(--surface-control,hsl(var(--muted)/0.3))] px-3.5 py-2.5"
            style={{ flexShrink: 0, margin: '0 24px 12px' }}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Icons.Monitor />
                <span>共享整个屏幕 (Entire Screen)</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                允许 Agent 查看或操作屏幕上除拒绝共享应用名单外的所有窗口。
              </p>
            </div>
            <div className="shrink-0">
              <SettingsSelect<GrantLevel>
                ariaLabel="共享整个屏幕权限级别"
                size="compact"
                width={112}
                disabled={busyId === 'screen'}
                value={currentScreenLevel}
                options={[
                  { value: 'none', label: '关闭' },
                  { value: 'read', label: '仅查看' },
                  { value: 'control', label: '控制' },
                ]}
                onChange={(lvl) => void handleShareScreen(lvl)}
              />
            </div>
          </div>
        ) : null}

        <div
          className="flex-1 overflow-y-auto"
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            padding: '4px 24px 24px',
          }}
        >
          {loading && windows.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
              正在枚举桌面窗口与无障碍句柄...
            </div>
          ) : filteredWindows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground">
              <p>未找到匹配的桌面窗口。</p>
              <p className="mt-1">
                请确认目标窗口未最小化或被归入“拒绝共享应用名单”。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {filteredWindows.map((win) => {
                const grantable = isWindowGrantable(win);
                const unshareableReason = getUnshareableReason(win);
                const isBusy =
                  busyId === win.targetId || busyId === `app:${win.targetId}`;
                return (
                  <div
                    key={win.targetId}
                    className={`flex flex-col justify-between rounded-lg border p-3 transition-colors ${
                      win.level !== 'none'
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-[var(--border-content,hsl(var(--border)))] bg-[var(--surface-control,transparent)]'
                    } ${!grantable ? 'opacity-60' : ''}`}
                  >
                    <div>
                      <WindowPreview win={win} invoke={invoke} />
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-semibold">
                          {win.title || win.appName}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          PID {win.pid}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {win.appName}
                        {win.minimized ? ' · 已最小化' : ''}
                        {win.hidden ? ' · 已隐藏' : ''}
                      </p>
                      {!grantable && unshareableReason ? (
                        <p className="mt-1 text-[11px] text-amber-500">
                          不可共享：{unshareableReason}
                        </p>
                      ) : null}
                    </div>

                    {grantable ? (
                      <div className="mt-2.5 flex items-center justify-between gap-2">
                        <SettingsSelect<GrantLevel>
                          ariaLabel={`${win.title || win.appName} 共享权限级别`}
                          size="compact"
                          width={112}
                          disabled={isBusy}
                          value={win.level}
                          options={[
                            { value: 'none', label: '关闭' },
                            { value: 'read', label: '仅查看' },
                            { value: 'control', label: '控制' },
                          ]}
                          onChange={(lvl) =>
                            void handleShareWindow(win.targetId, lvl)
                          }
                        />
                        <AstryxButton
                          variant="secondary"
                          size="sm"
                          disabled={isBusy}
                          onClick={() =>
                            void handleShareApp(win.targetId, 'control')
                          }
                          title="共享该应用的全部窗口"
                        >
                          共享整个应用
                        </AstryxButton>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Local Application Scanner & Picker Modal (for "拒绝共享应用名单")
// ============================================================================

function formatAppBlockEntry(app: LocalAppEntry): string {
  const name = app.name.trim();
  const exe = (app.exeName || app.identifier || '').trim();
  if (!exe) return name;
  const stem = exe.replace(/\.(exe|app)$/i, '');
  if (!name || name.toLowerCase() === exe.toLowerCase() || name.toLowerCase() === stem.toLowerCase()) {
    return exe;
  }
  return `${name} (${exe})`;
}

function LocalAppPickerModal({
  open,
  onClose,
  invoke,
  existingMatchers,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  invoke: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  existingMatchers: Set<string>;
  onConfirm: (selectedEntries: string[]) => void;
}) {
  const [apps, setApps] = useState<LocalAppEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const scanApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke('computer.listLocalApps', {})) as
        | LocalAppEntry[]
        | null;
      setApps(Array.isArray(res) ? res : []);
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  useEffect(() => {
    if (open) {
      setSelectedKeys(new Set());
      setSearchQuery('');
      void scanApps();
    }
  }, [open, scanApps]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isAlreadyBlocked = (app: LocalAppEntry): boolean => {
    const formatted = formatAppBlockEntry(app).toLowerCase();
    const nameLower = app.name.trim().toLowerCase();
    const exeLower = (app.exeName || app.identifier || '').trim().toLowerCase();
    const stemLower = exeLower.replace(/\.(exe|app)$/i, '');
    return (
      existingMatchers.has(formatted) ||
      (Boolean(nameLower) && existingMatchers.has(nameLower)) ||
      (Boolean(exeLower) && existingMatchers.has(exeLower)) ||
      (Boolean(stemLower) && existingMatchers.has(stemLower))
    );
  };

  const filteredApps = apps.filter((app) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      app.name.toLowerCase().includes(q) ||
      app.identifier.toLowerCase().includes(q) ||
      (app.exeName && app.exeName.toLowerCase().includes(q)) ||
      (app.path && app.path.toLowerCase().includes(q))
    );
  });

  const toggleSelect = (entryStr: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(entryStr)) {
        next.delete(entryStr);
      } else {
        next.add(entryStr);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    if (selectedKeys.size > 0) {
      onConfirm(Array.from(selectedKeys));
    }
    onClose();
  };

  return (
    <div
      data-floating-layer="modal"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        className="dialog-backdrop fixed inset-0"
        aria-hidden="true"
        style={{ position: 'fixed', inset: 0 }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="选择本机拒绝共享的应用"
        className="dialog-surface relative z-[9999] flex w-full max-w-xl flex-col overflow-hidden rounded-xl border"
        style={{
          position: 'relative',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          width: 'min(100%, 600px)',
          maxHeight: 'min(78vh, 580px)',
          overflow: 'hidden',
          borderRadius: 'var(--radius-container, 12px)',
          border: '1px solid var(--border-glass, hsl(var(--border)))',
          background: 'var(--surface-dialog, hsl(var(--popover)))',
          boxShadow: 'var(--shadow-popover, 0 24px 64px rgba(0, 0, 0, 0.28))',
        }}
      >
        <div
          style={{ flexShrink: 0, padding: '22px 24px 14px' }}
        >
          <h3
            className="text-sm font-semibold"
            style={{
              margin: 0,
              fontSize: '15px',
              fontWeight: 600,
              lineHeight: 1.4,
              color: 'var(--color-text-primary, var(--text-strong))',
            }}
          >
            选择本机应用
          </h3>
          <p
            className="text-xs text-muted-foreground"
            style={{
              margin: '4px 0 0',
              fontSize: '12px',
              lineHeight: 1.5,
              color: 'var(--color-text-secondary, var(--text-muted))',
            }}
          >
            扫描本机运行中及已安装的应用，勾选需要加入拒绝共享名单的应用。
          </p>
        </div>

        <div
          className="flex items-center gap-2.5"
          style={{ flexShrink: 0, padding: '0 24px 14px' }}
        >
          <AstryxSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="搜索应用名称、执行文件名 (.exe) 或安装路径..."
            ariaLabel="搜索本机应用"
            className="min-w-0 flex-1"
            style={{ flex: '1 1 200px', minWidth: 0 }}
          />
          <AstryxButton
            variant="secondary"
            size="md"
            disabled={loading}
            onClick={() => void scanApps()}
            icon={<Icons.Refresh spinning={loading} />}
          >
            重新扫描
          </AstryxButton>
        </div>

        {error ? (
          <div
            className="settings-message settings-message-error px-3 py-2 text-xs"
            role="alert"
            style={{ flexShrink: 0, margin: '0 24px 12px' }}
          >
            {error}
          </div>
        ) : null}

        <div
          className="flex-1 overflow-y-auto"
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            padding: '4px 24px 16px',
          }}
        >
          {loading && apps.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
              正在扫描本机应用列表...
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground">
              <p>未找到匹配的本机应用。</p>
              <p className="mt-1">
                您也可以通过「选择执行文件」直接定位应用程序的 .exe 文件。
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle,hsl(var(--border)))] rounded-lg border border-[var(--border-subtle,hsl(var(--border)))]">
              {filteredApps.map((app) => {
                const entryStr = formatAppBlockEntry(app);
                const already = isAlreadyBlocked(app);
                const checked = already || selectedKeys.has(entryStr);
                return (
                  <label
                    key={`${app.identifier}-${app.path ?? ''}`}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-xs transition-colors ${
                      already
                        ? 'opacity-60 cursor-default'
                        : checked
                          ? 'bg-primary/5'
                          : 'hover:bg-[var(--surface-control-hover,hsl(var(--muted)/0.4))]'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={already}
                        onChange={() => !already && toggleSelect(entryStr)}
                        className="rounded"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium text-foreground">
                            {app.name}
                          </span>
                          {app.exeName &&
                          app.exeName.toLowerCase() !== app.name.toLowerCase() ? (
                            <span className="settings-meta-chip px-1.5 py-0.2 font-mono text-[11px] text-muted-foreground">
                              {app.exeName}
                            </span>
                          ) : null}
                          {app.running ? (
                            <span className="agent-registry-status settings-status-pill-success">
                              运行中
                            </span>
                          ) : null}
                        </div>
                        {app.path ? (
                          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                            {app.path}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {already ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        已在名单中
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-between border-t border-[var(--border-subtle,hsl(var(--border)))]"
          style={{ flexShrink: 0, padding: '14px 24px' }}
        >
          <span className="text-xs text-muted-foreground">
            已选择 {selectedKeys.size} 个应用
          </span>
          <div className="flex items-center gap-2">
            <AstryxButton variant="secondary" size="md" onClick={onClose}>
              取消
            </AstryxButton>
            <AstryxButton
              variant="primary"
              size="md"
              disabled={selectedKeys.size === 0}
              onClick={handleConfirm}
            >
              确定添加
            </AstryxButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Computer Use Settings View (Tahoe Settings Design System)
// ============================================================================

const DAEMON_URL_STORAGE_KEY = 'vibex.computerUse.daemonUrl';

function readCachedDaemonUrl(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(DAEMON_URL_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function writeCachedDaemonUrl(url: string | undefined | null): void {
  if (!url || typeof url !== 'string') return;
  try {
    globalThis.sessionStorage?.setItem(DAEMON_URL_STORAGE_KEY, url);
  } catch {
    // ignore
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function postDaemonRpc(
  daemonUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${daemonUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  if (!res.ok) {
    throw new Error(`Daemon HTTP ${res.status}`);
  }
  const payload = (await res.json()) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  if (!payload.ok) {
    throw new Error(payload.error || `Daemon RPC error on ${method}`);
  }
  return payload.result;
}

async function callDaemonDirectHttp(
  daemonUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (method === 'computer.snapshotState') {
    try {
      const snapshot = (await postDaemonRpc(
        daemonUrl,
        'computer.snapshotState',
        {}
      )) as Record<string, unknown>;
      return { daemonUrl, ...snapshot };
    } catch {
      const [
        settings,
        status,
        sharedState,
        stopKeyStatus,
        driverInfo,
        activity,
      ] = await Promise.all([
        postDaemonRpc(daemonUrl, 'computer.getSettings', {}),
        postDaemonRpc(daemonUrl, 'computer.status', {}),
        postDaemonRpc(daemonUrl, 'computer.sharedState', {}),
        postDaemonRpc(daemonUrl, 'computer.stopKeyStatus', {}),
        postDaemonRpc(daemonUrl, 'computer.driverInfo', {}),
        postDaemonRpc(daemonUrl, 'computer.activity', {}),
      ]);
      return {
        daemonUrl,
        settings,
        status,
        sharedState,
        stopKeyStatus,
        driverInfo,
        activity,
      };
    }
  }
  return await postDaemonRpc(daemonUrl, method, params);
}

export default function ComputerUseSettingsView({
  environment,
}: {
  environment?: PluginRemoteEnvironment;
}) {
  const [savedSettings, setSavedSettings] =
    useState<ComputerToolsSettings | null>(null);
  const [draft, setDraft] = useState<ComputerToolsSettings | null>(null);
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [sharedState, setSharedState] = useState<SharedState | null>(null);
  const [stopKeyStatus, setStopKeyStatus] = useState<StopKeyStatus | null>(
    null
  );
  const [driverInfo, setDriverInfo] = useState<DriverInfo | null>(null);
  const [activity, setActivity] = useState<ComputerActivityPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [pickingExe, setPickingExe] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [customBlockInput, setCustomBlockInput] = useState('');

  const selectTtlId = useId();
  const selectDeliveryId = useId();
  const customBlockInputId = useId();

  useEffect(() => retainStyle('vibex-plugin-computer-use', appCss), [appCss]);

  const invokeQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const daemonUrlRef = useRef<string | null>(readCachedDaemonUrl());
  const renewedSessionRef = useRef<{
    token: string;
    surfaceId: string;
    generation: number;
    sequence: number;
  } | null>(null);

  const invoke = useCallback(
    async (
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<unknown> => {
      const cleanParams = (
        params && Object.keys(params).length === 0
          ? params
          : JSON.parse(JSON.stringify(params ?? {}))
      ) as Record<string, unknown>;

      const tryRenewedTauriInvoke = async (): Promise<unknown> => {
        const tauriInternals = (
          globalThis as unknown as {
            __TAURI_INTERNALS__?: {
              invoke?: (
                cmd: string,
                args?: Record<string, unknown>
              ) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        if (typeof tauriInternals?.invoke !== 'function') {
          throw new Error('Tauri internals unavailable');
        }
        const pluginId = environment?.pluginId || 'vibex-plugin-computer-use';
        let surfaceId = environment?.surfaceId || 'computer-use';

        const callAppCmd = async (
          command: string,
          args: Record<string, unknown>
        ) => {
          const res = (await tauriInternals.invoke!('application_call', {
            command,
            operationId: globalThis.crypto.randomUUID(),
            args,
          })) as { data?: unknown } | unknown;
          return res && typeof res === 'object' && 'data' in res
            ? (res as { data: unknown }).data
            : res;
        };

        if (!renewedSessionRef.current) {
          let generation = 1;
          try {
            const catalog = await callAppCmd('plugin_contribution_catalog', {});
            const broker = resolveBrokerSurface(
              catalogItems(catalog),
              pluginId,
              surfaceId
            );
            surfaceId = broker.id;
            generation = broker.generation;
          } catch {
            // use the requested surface and generation 1
          }
          const bytes = new Uint8Array(24);
          globalThis.crypto.getRandomValues(bytes);
          const clientToken = Array.from(bytes, (b) =>
            b.toString(16).padStart(2, '0')
          ).join('');
          const opened = (await callAppCmd('plugin_surface_open', {
            pluginId,
            surfaceId,
            generation,
            token: clientToken,
          })) as { token?: string } | null;
          if (!opened?.token) {
            throw new Error('Failed to renew plugin surface session');
          }
          renewedSessionRef.current = {
            token: opened.token,
            surfaceId,
            generation,
            sequence: 0,
          };
        }

        const session = renewedSessionRef.current;
        session.sequence += 1;
        try {
          return await callAppCmd('plugin_surface_invoke', {
            pluginId,
            surfaceId: session.surfaceId,
            generation: session.generation,
            token: session.token,
            requestId: globalThis.crypto.randomUUID(),
            sequence: session.sequence,
            method: 'surface.createSession',
            params: {
              rpcMethod: method,
              rpcParams: cleanParams,
            },
          });
        } catch (err) {
          renewedSessionRef.current = null;
          throw err;
        }
      };

      const run = async () => {
        if (daemonUrlRef.current) {
          try {
            return await callDaemonDirectHttp(
              daemonUrlRef.current,
              method,
              cleanParams
            );
          } catch {
            daemonUrlRef.current = null;
          }
        }

        if (environment?.invoke && !renewedSessionRef.current) {
          try {
            const res = await environment.invoke('surface.createSession', {
              rpcMethod: method,
              rpcParams: cleanParams,
            });
            if (
              res &&
              typeof res === 'object' &&
              'daemonUrl' in res &&
              typeof (res as { daemonUrl?: unknown }).daemonUrl === 'string'
            ) {
              const url = (res as { daemonUrl: string }).daemonUrl;
              daemonUrlRef.current = url;
              writeCachedDaemonUrl(url);
            }
            return res;
          } catch (hostErr) {
            const msg = formatErrorMessage(hostErr);
            const isSessionError =
              msg.includes('expired') ||
              msg.includes('revoked') ||
              msg.includes('generation') ||
              msg.includes('sequence') ||
              msg.includes('Worker');
            if (!isSessionError && !daemonUrlRef.current) {
              throw hostErr;
            }
            // Fall through to Direct Daemon HTTP or Tauri Session Renewal
            if (daemonUrlRef.current) {
              try {
                return await callDaemonDirectHttp(
                  daemonUrlRef.current,
                  method,
                  cleanParams
                );
              } catch {
                // try Tauri session renewal next
              }
            }
            try {
              const renewedRes = await tryRenewedTauriInvoke();
              if (
                renewedRes &&
                typeof renewedRes === 'object' &&
                'daemonUrl' in renewedRes &&
                typeof (renewedRes as { daemonUrl?: unknown }).daemonUrl ===
                  'string'
              ) {
                const url = (renewedRes as { daemonUrl: string }).daemonUrl;
                daemonUrlRef.current = url;
                writeCachedDaemonUrl(url);
              }
              return renewedRes;
            } catch {
              throw hostErr;
            }
          }
        }

        if (daemonUrlRef.current) {
          try {
            return await callDaemonDirectHttp(
              daemonUrlRef.current,
              method,
              cleanParams
            );
          } catch {
            // fall through to Tauri session renewal
          }
        }

        return await tryRenewedTauriInvoke();
      };

      if (daemonUrlRef.current) {
        return await run();
      }
      const next = invokeQueueRef.current.then(run, run);
      invokeQueueRef.current = next.catch(() => undefined);
      return await next;
    },
    [environment]
  );

  const refreshLiveState = useCallback(
    async (updateSettings = false) => {
      try {
        const snapshot = (await invoke('computer.snapshotState', {})) as {
          daemonUrl?: string;
          settings?: ComputerToolsSettings;
          status?: ComputerStatus;
          sharedState?: SharedState;
          stopKeyStatus?: StopKeyStatus;
          driverInfo?: DriverInfo;
          activity?: ComputerActivityPayload[];
        } | null;

        if (snapshot?.daemonUrl) {
          daemonUrlRef.current = snapshot.daemonUrl;
          writeCachedDaemonUrl(snapshot.daemonUrl);
        }

        if (snapshot && snapshot.status && snapshot.sharedState) {
          if (updateSettings && snapshot.settings) {
            setSavedSettings((prev) =>
              sameJson(prev, snapshot.settings) ? prev : snapshot.settings!
            );
            setDraft((prev) => prev ?? structuredClone(snapshot.settings!));
          }
          setStatus((prev) =>
            sameJson(prev, snapshot.status) ? prev : snapshot.status!
          );
          setSharedState((prev) =>
            sameJson(prev, snapshot.sharedState) ? prev : snapshot.sharedState!
          );
          if (snapshot.stopKeyStatus) {
            setStopKeyStatus((prev) =>
              sameJson(prev, snapshot.stopKeyStatus)
                ? prev
                : snapshot.stopKeyStatus!
            );
          }
          if (snapshot.driverInfo) {
            setDriverInfo((prev) =>
              sameJson(prev, snapshot.driverInfo) ? prev : snapshot.driverInfo!
            );
          }
          if (Array.isArray(snapshot.activity)) {
            setActivity((prev) =>
              sameJson(prev, snapshot.activity) ? prev : snapshot.activity!
            );
          }
          setError((prev) => (prev === null ? prev : null));
          return;
        }

        const [
          nextSettings,
          nextStatus,
          nextShared,
          nextStopKey,
          nextDriver,
          nextActivity,
        ] = (await Promise.all([
          updateSettings
            ? invoke('computer.getSettings')
            : Promise.resolve(null),
          invoke('computer.status'),
          invoke('computer.sharedState'),
          invoke('computer.stopKeyStatus'),
          invoke('computer.driverInfo'),
          invoke('computer.activity'),
        ])) as [
          ComputerToolsSettings | null,
          ComputerStatus,
          SharedState,
          StopKeyStatus,
          DriverInfo,
          ComputerActivityPayload[],
        ];

        if (nextSettings) {
          setSavedSettings((prev) =>
            sameJson(prev, nextSettings) ? prev : nextSettings
          );
          setDraft((prev) => prev ?? structuredClone(nextSettings));
        }
        if (nextStatus) {
          setStatus((prev) => (sameJson(prev, nextStatus) ? prev : nextStatus));
        }
        if (nextShared) {
          setSharedState((prev) =>
            sameJson(prev, nextShared) ? prev : nextShared
          );
        }
        if (nextStopKey) {
          setStopKeyStatus((prev) =>
            sameJson(prev, nextStopKey) ? prev : nextStopKey
          );
        }
        if (nextDriver) {
          setDriverInfo((prev) =>
            sameJson(prev, nextDriver) ? prev : nextDriver
          );
        }
        if (Array.isArray(nextActivity)) {
          setActivity((prev) =>
            sameJson(prev, nextActivity) ? prev : nextActivity
          );
        }
        setError((prev) => (prev === null ? prev : null));
      } catch (err) {
        if (updateSettings) {
          setError(formatErrorMessage(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [invoke]
  );

  useEffect(() => {
    void refreshLiveState(true);
  }, [refreshLiveState]);

  const driverView = useMemo(
    () => resolveDriverView(driverInfo, status),
    [driverInfo, status]
  );
  const normalizedPermissions = useMemo(
    () => normalizePermissions(status?.permissions),
    [status?.permissions]
  );

  const isDriverBusy =
    driverView.state === 'installing' || driverView.state === 'uninstalling';

  useEffect(() => {
    const intervalMs = isDriverBusy ? 600 : 4000;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshLiveState(false);
    };
    const timer = setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void refreshLiveState(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isDriverBusy, refreshLiveState]);

  const dirty = useMemo(
    () => !settingsEqual(savedSettings, draft),
    [savedSettings, draft]
  );

  const platform: 'macos' | 'windows' | 'linux' = status?.platform ?? 'windows';

  // Stop shortcut key recorder (matches StopShortcut::parse canonical spelling)
  useEffect(() => {
    if (!recordingShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (
        (event.code === 'Escape' || event.key === 'Escape') &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setRecordingShortcut(false);
        return;
      }

      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        return;
      }

      let key = KEY_BY_CODE[event.code];
      if (!key && event.key) {
        if (event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
          key = `Key${event.key.toUpperCase()}`;
        } else if (event.key.length === 1 && /[0-9]/.test(event.key)) {
          key = `Digit${event.key}`;
        } else if (event.key === 'Escape' || event.key === 'Esc') {
          key = 'Escape';
        } else if (/^F([1-9]|1[0-2])$/i.test(event.key)) {
          key = event.key.toUpperCase();
        }
      }
      if (!key) return;

      const mods: string[] = [];
      if (event.ctrlKey) mods.push('Control');
      if (event.altKey) mods.push('Alt');
      if (event.shiftKey) mods.push('Shift');
      if (platform === 'macos' && event.metaKey) mods.push('Command');

      const hasPrimaryMod =
        mods.includes('Control') ||
        (platform === 'macos' && mods.includes('Command'));
      if (mods.length < 2 || !hasPrimaryMod) {
        return;
      }

      const nextShortcut = [...mods, key].join('+');
      setDraft((prev) =>
        prev ? { ...prev, stopShortcut: nextShortcut } : prev
      );
      setRecordingShortcut(false);
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [recordingShortcut, platform]);

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    setTogglingEnabled(true);
    setError(null);
    try {
      const nextSettings = (await invoke('computer.setEnabled', {
        enabled: nextEnabled,
      })) as ComputerToolsSettings;
      setSavedSettings(nextSettings);
      setDraft((prev) =>
        prev ? { ...prev, enabled: nextSettings.enabled } : nextSettings
      );
      await refreshLiveState(false);
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleSavePreferences = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const unblockedDefaults = draft.defaultBlocklist
        .filter((d) => !d.blocked)
        .map((d) => d.key);
      const nextSettings = (await invoke('computer.setPreferences', {
        grantTimeoutSecs: draft.grantTimeoutSecs,
        stopShortcut: draft.stopShortcut,
        allowForeground: draft.allowForeground,
        defaultDelivery: draft.defaultDelivery,
        unblockedDefaults,
        customBlocklist: draft.customBlocklist,
        launchEnabled: draft.launchEnabled,
        clipboardEnabled: draft.clipboardEnabled,
        screenEnabled: draft.screenEnabled,
        showIndicator: draft.showIndicator,
      })) as ComputerToolsSettings;
      setSavedSettings(nextSettings);
      setDraft(structuredClone(nextSettings));
      await refreshLiveState(false);
    } catch (err) {
      setSaveError(formatErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscardPreferences = () => {
    if (!savedSettings) return;
    setDraft(structuredClone(savedSettings));
    setSaveError(null);
  };

  const handleEmergencyStop = async () => {
    try {
      await invoke('computer.stop', {});
      await refreshLiveState(false);
    } catch (err) {
      setError(formatErrorMessage(err));
    }
  };

  const handleRevokeAll = async () => {
    try {
      await invoke('computer.revokeAll', {});
      await refreshLiveState(false);
    } catch (err) {
      setError(formatErrorMessage(err));
    }
  };

  const handleInstallDriver = async () => {
    setError(null);
    try {
      const info = (await invoke('computer.driverInstall', {})) as DriverInfo;
      setDriverInfo(info);
      await refreshLiveState(false);
    } catch (err) {
      setError(formatErrorMessage(err));
    }
  };

  const handleUninstallDriver = async () => {
    setError(null);
    try {
      const info = (await invoke('computer.driverUninstall', {})) as DriverInfo;
      setDriverInfo(info);
      await refreshLiveState(true);
    } catch (err) {
      setError(formatErrorMessage(err));
    }
  };

  const addBlocklistEntries = useCallback((rawList: string[]) => {
    setDraft((prev) => {
      if (!prev) return prev;
      let nextDefaults = [...prev.defaultBlocklist];
      const nextCustom = [...prev.customBlocklist];

      for (const raw of rawList) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        const stem = lower.replace(/\.(exe|app)$/i, '');

        // Check if it matches an unblocked default entry
        const matchedDefaultIdx = nextDefaults.findIndex(
          (d) =>
            d.key.toLowerCase() === lower ||
            d.key.toLowerCase() === stem ||
            d.name.toLowerCase() === lower ||
            d.name.toLowerCase() === stem
        );
        if (matchedDefaultIdx >= 0) {
          if (!nextDefaults[matchedDefaultIdx].blocked) {
            nextDefaults = nextDefaults.map((d, idx) =>
              idx === matchedDefaultIdx ? { ...d, blocked: true } : d
            );
          }
          continue;
        }

        const existsInCustom = nextCustom.some(
          (item) => item.toLowerCase() === lower
        );
        if (!existsInCustom) {
          nextCustom.push(trimmed);
        }
      }

      return {
        ...prev,
        defaultBlocklist: nextDefaults,
        customBlocklist: nextCustom,
      };
    });
  }, []);

  const handleAddCustomBlockEntry = () => {
    const trimmed = customBlockInput.trim();
    if (!trimmed) return;
    addBlocklistEntries([trimmed]);
    setCustomBlockInput('');
  };

  const handleRemoveDefaultBlockEntry = (key: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        defaultBlocklist: prev.defaultBlocklist.map((entry) =>
          entry.key === key ? { ...entry, blocked: false } : entry
        ),
      };
    });
  };

  const handleRemoveCustomBlockEntry = (entry: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        customBlocklist: prev.customBlocklist.filter((item) => item !== entry),
      };
    });
  };

  const handleRestoreDefaultBlocklist = () => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        defaultBlocklist: prev.defaultBlocklist.map((entry) => ({
          ...entry,
          blocked: true,
        })),
      };
    });
  };

  const handlePickExecutableFile = async () => {
    setPickingExe(true);
    setSaveError(null);
    try {
      const picked = (await invoke(
        'computer.pickExecutableFile',
        {}
      )) as PickedExecutable | null;
      if (picked && !picked.canceled) {
        const fileName = (picked.fileName || '').trim();
        const name = (picked.name || '').trim();
        const path = (picked.path || '').trim();
        const stem = fileName.replace(/\.(exe|app)$/i, '');
        let entry = '';
        if (
          name &&
          fileName &&
          name.toLowerCase() !== fileName.toLowerCase() &&
          name.toLowerCase() !== stem.toLowerCase()
        ) {
          entry = `${name} (${fileName})`;
        } else if (fileName) {
          entry = fileName;
        } else if (path) {
          entry = path;
        }
        if (entry) {
          addBlocklistEntries([entry]);
        }
      }
    } catch (err) {
      setSaveError(formatErrorMessage(err));
    } finally {
      setPickingExe(false);
    }
  };

  const unifiedBlocklist = useMemo(() => {
    if (!draft) return [];
    const items: Array<{
      id: string;
      kind: 'default' | 'custom';
      value: string;
      title: string;
      subtitle: string | null;
    }> = [];

    for (const entry of draft.defaultBlocklist ?? []) {
      if (!entry.blocked) continue;
      const label = DEFAULT_BLOCK_LABELS[entry.key] ?? entry.name;
      items.push({
        id: `default:${entry.key}`,
        kind: 'default',
        value: entry.key,
        title: label,
        subtitle: null,
      });
    }

    for (const raw of draft.customBlocklist ?? []) {
      const match = /^(.+?)\s*\(([^()]+)\)$/.exec(raw.trim());
      if (match) {
        items.push({
          id: `custom:${raw}`,
          kind: 'custom',
          value: raw,
          title: match[1].trim(),
          subtitle: match[2].trim(),
        });
      } else {
        items.push({
          id: `custom:${raw}`,
          kind: 'custom',
          value: raw,
          title: raw,
          subtitle: null,
        });
      }
    }

    return items;
  }, [draft]);

  const existingBlockedMatchers = useMemo(() => {
    const set = new Set<string>();
    if (!draft) return set;
    for (const d of draft.defaultBlocklist ?? []) {
      if (d.blocked) {
        set.add(d.key.toLowerCase());
        set.add(d.name.toLowerCase());
        set.add(`${d.name.toLowerCase()}.exe`);
      }
    }
    for (const c of draft.customBlocklist ?? []) {
      const lower = c.trim().toLowerCase();
      set.add(lower);
      const match = /^(.+?)\s*\(([^()]+)\)$/.exec(lower);
      if (match) {
        set.add(match[1].trim());
        set.add(match[2].trim());
      }
    }
    return set;
  }, [draft]);

  const hasRemovedDefaultBlock = useMemo(
    () => (draft?.defaultBlocklist ?? []).some((d) => !d.blocked),
    [draft?.defaultBlocklist]
  );

  if (environment?.slot === 'status.after-mcp') {
    return (
      <div className="settings-page" style={{ width: '100%', height: '100%', minHeight: 0 }}>
        <WindowPickerModal
          open
          embedded
          onClose={() => undefined}
          screenEnabled={draft?.screenEnabled ?? savedSettings?.screenEnabled ?? false}
          sharedState={sharedState}
          invoke={invoke}
          onSharedChanged={setSharedState}
        />
      </div>
    );
  }

  if (loading && !draft) {
    return (
      <div className="settings-page">
        <div className="settings-content flex items-center justify-center py-16 text-sm text-muted-foreground">
          正在连接电脑控制守护进程...
        </div>
      </div>
    );
  }

  const isEnabled = savedSettings?.enabled ?? false;
  const sharedWindows = (sharedState?.shared ?? []).filter(
    (w) => !w.wholeScreen && !w.wholeApp
  );
  const sharedApps = sharedState?.apps ?? [];
  const sharedScreen = sharedState?.screen ?? null;
  const totalSharedCount =
    sharedWindows.length + sharedApps.length + (sharedScreen ? 1 : 0);

  const shortcutParts = formatShortcutParts(
    draft?.stopShortcut ?? '',
    platform
  );

  const statusPill = (() => {
    if (!isEnabled) {
      return { label: '已关闭', className: 'settings-status-pill-neutral' };
    }
    if (driverView.state === 'installing') {
      return {
        label: '正在安装驱动',
        className: 'settings-status-pill-warning',
      };
    }
    if (!driverView.isAvailable) {
      return { label: '需安装驱动', className: 'settings-status-pill-warning' };
    }
    const missingPerm = normalizedPermissions.some((p) => !p.granted);
    if (missingPerm) {
      return {
        label: '需授予系统权限',
        className: 'settings-status-pill-warning',
      };
    }
    return {
      label:
        totalSharedCount > 0 ? `已就绪 · ${totalSharedCount} 项共享` : '已就绪',
      className: 'settings-status-pill-success',
    };
  })();

  return (
    <div className="settings-page">
            <div className="settings-content">
        <header className="settings-page-header flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2>电脑控制</h2>
              <span
                className={`agent-registry-status ${statusPill.className}`}
              >
                {statusPill.label}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isEnabled ? (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                style={{
                  height: '32px',
                  minHeight: '32px',
                  borderRadius: 'var(--radius)',
                }}
              >
                <Icons.AppWindow />
                选择共享窗口...
              </button>
            ) : null}
            {totalSharedCount > 0 ? (
              <button
                type="button"
                onClick={() => void handleEmergencyStop()}
                className="inline-flex items-center gap-1.5 px-3 text-xs font-medium transition-colors hover:opacity-90"
                style={{
                  height: '32px',
                  minHeight: '32px',
                  borderRadius: 'var(--radius)',
                  border: '1px solid hsl(var(--destructive) / 0.28)',
                  background: 'hsl(var(--destructive) / 0.08)',
                  color: 'hsl(var(--destructive))',
                }}
              >
                <Icons.OctagonStop />
                紧急停止
              </button>
            ) : null}
          </div>
        </header>

        {error ? (
          <div
            className="settings-message settings-message-error mb-4 px-3.5 py-2.5 text-xs"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {status && status.shipping === false ? (
          <div className="settings-message settings-message-warning mb-4 px-3.5 py-2.5 text-xs">
            当前平台 ({status.platform}) 的电脑控制驱动处于实验性支持阶段。
          </div>
        ) : null}

        <div className="settings-sections">
          {/* 1. Master Switch & Active Shared Windows */}
          <SectionGroup icon={<Icons.Monitor />} title="服务开关与实时共享">
            <div className="settings-row">
              <div>
                <div className="text-sm font-medium">
                  启用电脑控制 (Computer Use)
                </div>
                <p className="settings-row__description">
                  关闭开关会立即终止辅助进程并撤销所有正在共享的窗口授权。
                </p>
              </div>
              <SwitchControl
                checked={isEnabled}
                disabled={togglingEnabled}
                onChange={(next) => void handleToggleEnabled(next)}
                ariaLabel="启用电脑控制"
              />
            </div>

            {isEnabled ? (
              <div className="border-t border-[var(--border-subtle,hsl(var(--border)))]">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <div>
                    <div className="text-sm font-medium">
                      当前已授权的共享目标 ({totalSharedCount})
                    </div>
                    <p className="settings-row__description">
                      可随时切换单个目标的“仅查看 / 允许控制”级别或立即停止共享。
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <AstryxButton
                      variant="secondary"
                      size="compact"
                      onClick={() => setPickerOpen(true)}
                    >
                      + 添加共享窗口
                    </AstryxButton>
                    {totalSharedCount > 0 ? (
                      <AstryxButton
                        variant="secondary"
                        size="compact"
                        onClick={() => void handleRevokeAll()}
                      >
                        撤销全部
                      </AstryxButton>
                    ) : null}
                  </div>
                </div>

                {totalSharedCount === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--border-subtle,hsl(var(--border)))] py-6 text-center text-xs text-muted-foreground">
                    当前没有共享任何窗口。点击上方「选择共享窗口...」为 Agent 授权可访问的窗口或应用。
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {sharedScreen ? (
                      <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,transparent)] px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-semibold">
                            <span>整个屏幕 (Entire Screen)</span>
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {sharedScreen.windows != null
                                ? `${sharedScreen.windows} 个窗口`
                                : sharedScreen.targetId || '全屏'}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            排除永不共享名单与 VibeX 自身窗口后的全部桌面区域
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <SettingsSelect<GrantLevel>
                            ariaLabel="全屏共享权限级别"
                            size="compact"
                            width={148}
                            value={sharedScreen.level}
                            options={[
                              { value: 'read', label: '仅查看 (Read)' },
                              { value: 'control', label: '允许控制 (Control)' },
                            ]}
                            onChange={(nextLevel) =>
                              void invoke('computer.shareScreen', {
                                level: nextLevel,
                              }).then((next) =>
                                setSharedState(next as SharedState)
                              )
                            }
                          />
                          <AstryxButton
                            variant="secondary"
                            size="mini"
                            onClick={() =>
                              void invoke('computer.shareScreen', {
                                level: 'none',
                              }).then((next) =>
                                setSharedState(next as SharedState)
                              )
                            }
                          >
                            移除
                          </AstryxButton>
                        </div>
                      </div>
                    ) : null}

                    {sharedApps.map((app) => (
                      <div
                        key={app.appId}
                        className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,transparent)] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-semibold">
                            <span className="truncate">{app.appName}</span>
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              整个应用 ({app.windows ?? app.windowCount ?? 0} 个窗口)
                            </span>
                          </div>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {app.pid ? `PID ${app.pid}` : app.appKey || app.appId}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <SettingsSelect<GrantLevel>
                            ariaLabel={`${app.appName} 应用共享权限级别`}
                            size="compact"
                            width={148}
                            value={app.level}
                            options={[
                              { value: 'read', label: '仅查看 (Read)' },
                              { value: 'control', label: '允许控制 (Control)' },
                            ]}
                            onChange={(nextLevel) =>
                              void invoke('computer.shareApp', {
                                appId: app.appId,
                                level: nextLevel,
                              }).then((next) =>
                                setSharedState(next as SharedState)
                              )
                            }
                          />
                          <AstryxButton
                            variant="secondary"
                            size="mini"
                            onClick={() =>
                              void invoke('computer.shareApp', {
                                appId: app.appId,
                                level: 'none',
                              }).then((next) =>
                                setSharedState(next as SharedState)
                              )
                            }
                          >
                            移除
                          </AstryxButton>
                        </div>
                      </div>
                    ))}

                    {sharedWindows.map((win) => (
                      <div
                        key={win.targetId}
                        className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,transparent)] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-semibold">
                            <span className="truncate">
                              {win.title || win.appName}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {win.targetId}
                            </span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {win.appName}
                            {win.pid ? ` · PID ${win.pid}` : win.appKey ? ` · ${win.appKey}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <SettingsSelect<GrantLevel>
                            ariaLabel={`${win.title || win.appName} 窗口共享权限级别`}
                            size="compact"
                            width={148}
                            value={win.level}
                            options={[
                              { value: 'read', label: '仅查看 (Read)' },
                              { value: 'control', label: '允许控制 (Control)' },
                            ]}
                            onChange={(nextLevel) =>
                              void invoke('computer.shareWindow', {
                                targetId: win.targetId,
                                level: nextLevel,
                              }).then(() => refreshLiveState(false))
                            }
                          />
                          <AstryxButton
                            variant="secondary"
                            size="mini"
                            onClick={() =>
                              void invoke('computer.shareWindow', {
                                targetId: win.targetId,
                                level: 'none',
                              }).then(() => refreshLiveState(false))
                            }
                          >
                            移除
                          </AstryxButton>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </SectionGroup>

          {/* 2. cua-driver Card & OS Permissions */}
          <SectionGroup icon={<Icons.Cpu />} title="驱动与系统权限">
            <div className="settings-row">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">cua-driver 桌面驱动</span>
                  <span className="settings-meta-chip px-1.5 py-0.5 font-mono text-[11px]">
                    v{driverView.version}
                  </span>
                  {driverView.state === 'ready' ? (
                    <span className="agent-registry-status settings-status-pill-success">
                      已安装
                    </span>
                  ) : driverView.state === 'installing' ? (
                    <span className="agent-registry-status settings-status-pill-warning">
                      下载安装中...
                    </span>
                  ) : (
                    <span className="agent-registry-status settings-status-pill-neutral">
                      未安装
                    </span>
                  )}
                </div>
                <p className="settings-row__description">
                  {driverView.binaryPath
                    ? `安装路径：${driverView.binaryPath}`
                    : '提供跨平台无障碍树读取、截图缩放与后台事件合成能力。'}
                </p>
                {driverView.state === 'installing' ? (
                  <div className="mt-2 max-w-md">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{
                          width: driverView.totalBytes
                            ? `${Math.min(
                                100,
                                Math.round(
                                  (driverView.downloadedBytes /
                                    driverView.totalBytes) *
                                    100
                                )
                              )}%`
                            : '45%',
                        }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      已下载 {formatBytes(driverView.downloadedBytes)}
                      {driverView.totalBytes
                        ? ` / ${formatBytes(driverView.totalBytes)}`
                        : ''}
                    </p>
                  </div>
                ) : null}
                {driverView.error ? (
                  <p className="mt-1 text-xs text-destructive">
                    {driverView.error}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {driverView.state === 'ready' ? (
                  <>
                    {driverView.installedVersion &&
                    driverView.installedVersion !== driverView.version ? (
                      <button
                        type="button"
                        onClick={() => void handleInstallDriver()}
                        className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
                      >
                        升级至 v{driverView.version}
                      </button>
                    ) : null}
                    <AstryxButton
                      variant="secondary"
                      size="compact"
                      onClick={() => void handleUninstallDriver()}
                    >
                      移除驱动
                    </AstryxButton>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={
                      isDriverBusy || driverView.state === 'unsupported'
                    }
                    onClick={() => void handleInstallDriver()}
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {driverView.state === 'installing'
                      ? '正在安装...'
                      : '安装驱动'}
                  </button>
                )}
              </div>
            </div>

            {normalizedPermissions.length > 0 ? (
              normalizedPermissions.map((perm) => {
                const label =
                  perm.kind === 'accessibility'
                    ? '辅助功能权限 (Accessibility)'
                    : perm.kind === 'screen_recording'
                      ? '屏幕录制权限 (Screen Recording)'
                      : '输入监听权限 (Input Monitoring)';
                return (
                  <div
                    key={perm.kind}
                    className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]"
                  >
                    <div>
                      <div className="text-sm font-medium">{label}</div>
                      <p className="settings-row__description">
                        {perm.granted
                          ? '已向 vibex-computer-helper 授予权限'
                          : '需要向辅助进程授予此系统权限以正常工作'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {perm.granted ? (
                        <span className="agent-registry-status settings-status-pill-success">
                          已授权
                        </span>
                      ) : (
                        <>
                          {perm.canPrompt ? (
                            <button
                              type="button"
                              onClick={() =>
                                void invoke('computer.requestPermission', {
                                  kind: perm.kind,
                                }).then(() => refreshLiveState(false))
                              }
                              className="inline-flex h-8 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"
                            >
                              请求权限
                            </button>
                          ) : null}
                          <AstryxButton
                            variant="secondary"
                            size="compact"
                            onClick={() =>
                              void invoke('computer.openPermissionSettings', {
                                kind: perm.kind,
                              })
                            }
                          >
                            打开系统设置
                          </AstryxButton>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
                <div>
                  <div className="text-sm font-medium">
                    系统桌面接口 (
                    {platform === 'windows'
                      ? 'Windows UI Automation & Win32'
                      : platform}
                    )
                  </div>
                  <p className="settings-row__description">
                    当前操作系统无需额外 TCC 弹窗授权，将自动遵循窗口级共享边界与 UIPI 完整性级别。
                  </p>
                </div>
                <span className="agent-registry-status settings-status-pill-success">
                  已就绪
                </span>
              </div>
            )}
          </SectionGroup>

          {/* 3. Unified Capability Settings (Grant Timeout, Stop Key, Delivery, Extended Tools & Blocklist) */}
          <SectionGroup
            icon={<Icons.Shield />}
            title="能力设置"
            description="配置授权有效时长、全局紧急停止热键、前后台输入投递方式、扩展工具开关及拒绝共享应用名单。"
          >
            <div className="settings-row">
              <div>
                <label
                  htmlFor={selectTtlId}
                  className="text-sm font-medium"
                >
                  共享闲置自动过期时间
                </label>
                <p className="settings-row__description">
                  当某个已共享窗口在此时间内未被 Agent 读取或操作时，自动撤销其共享授权。
                </p>
              </div>
              <SettingsSelect<number>
                id={selectTtlId}
                ariaLabel="共享闲置自动过期时间"
                width={220}
                value={draft?.grantTimeoutSecs ?? 1800}
                options={GRANT_TTL_OPTIONS}
                onChange={(nextVal) =>
                  setDraft((prev) =>
                    prev
                      ? { ...prev, grantTimeoutSecs: Number(nextVal) }
                      : prev
                  )
                }
              />
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">全局紧急停止快捷键</span>
                  {stopKeyStatus?.active ? (
                    <span className="agent-registry-status settings-status-pill-success">
                      已生效
                    </span>
                  ) : stopKeyStatus?.failed ? (
                    <span
                      className="agent-registry-status settings-status-pill-warning"
                      title={stopKeyStatus.detail ?? undefined}
                    >
                      快捷键被占用
                    </span>
                  ) : (
                    <span className="agent-registry-status settings-status-pill-neutral">
                      未注册
                    </span>
                  )}
                </div>
                <p className="settings-row__description">
                  按下快捷键立即撤销所有窗口授权并中断正在执行的驱动动作（需至少包含两个修饰键且含 Ctrl 或 Cmd）。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {recordingShortcut ? (
                  <span className="rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                    请按下组合键 (Esc 取消)...
                  </span>
                ) : shortcutParts.length > 0 ? (
                  <div className="flex items-center gap-1">
                    {shortcutParts.map((part, idx) => (
                      <kbd
                        key={`${part}-${idx}`}
                        className="settings-kbd px-2 py-1 text-[11px] font-mono"
                      >
                        {part}
                      </kbd>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">已停用</span>
                )}

                <AstryxButton
                  variant="secondary"
                  size="compact"
                  onClick={() => setRecordingShortcut((prev) => !prev)}
                >
                  {recordingShortcut ? '取消录制' : '录制快捷键'}
                </AstryxButton>
                {draft &&
                draft.stopShortcut !== draft.defaultStopShortcut ? (
                  <AstryxButton
                    variant="secondary"
                    size="compact"
                    onClick={() =>
                      setDraft((prev) =>
                        prev
                          ? { ...prev, stopShortcut: prev.defaultStopShortcut }
                          : prev
                      )
                    }
                  >
                    恢复默认
                  </AstryxButton>
                ) : null}
                {draft?.stopShortcut ? (
                  <AstryxButton
                    variant="secondary"
                    size="compact"
                    onClick={() =>
                      setDraft((prev) =>
                        prev ? { ...prev, stopShortcut: '' } : prev
                      )
                    }
                  >
                    停用
                  </AstryxButton>
                ) : null}
              </div>
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">显示桌面共享状态指示条</div>
                <p className="settings-row__description">
                  当存在共享窗口或全屏共享时，在每个共享窗口边缘显示呼吸光带。
                </p>
              </div>
              <SwitchControl
                checked={draft?.showIndicator ?? true}
                onChange={(next) =>
                  setDraft((prev) =>
                    prev ? { ...prev, showIndicator: next } : prev
                  )
                }
                ariaLabel="显示桌面共享状态指示条"
              />
            </div>

            <div
              className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]"
              style={{ paddingBottom: '4px' }}
            >
              <div>
                <div className="text-sm font-medium">
                  允许前台输入投递 (Foreground Delivery)
                </div>
                <p className="settings-row__description">
                  默认使用无障碍动作与虚拟指针在后台操作窗口；开启后允许在不支持后台投递的应用中将窗口置前操作。
                </p>
              </div>
              <SwitchControl
                checked={draft?.allowForeground ?? true}
                onChange={(next) =>
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          allowForeground: next,
                          defaultDelivery: next
                            ? prev.defaultDelivery
                            : 'background',
                        }
                      : prev
                  )
                }
                ariaLabel="允许前台输入投递"
              />
            </div>

            <fieldset
              className="settings-subrows"
              disabled={!draft?.allowForeground}
              style={{ marginTop: 0, paddingTop: 0 }}
            >
              <div
                className="settings-row"
                style={{ paddingTop: '4px' }}
              >
                <div className="settings-row__copy">
                  <label
                    htmlFor={selectDeliveryId}
                    className="text-sm font-medium"
                  >
                    默认输入投递模式
                  </label>
                  <p className="settings-row__description">
                    当 Agent 调用点击、输入或按键工具未显式指定 delivery 参数时采用的默认方式。
                  </p>
                </div>
                <SettingsSelect<ActDelivery>
                  id={selectDeliveryId}
                  ariaLabel="默认输入投递模式"
                  width={248}
                  disabled={!draft?.allowForeground}
                  value={draft?.defaultDelivery ?? 'background'}
                  options={[
                    {
                      value: 'background',
                      label: '后台投递 (Background · 不抢占焦点)',
                    },
                    {
                      value: 'foreground',
                      label: '前台投递 (Foreground · 置前窗口)',
                    },
                  ]}
                  onChange={(nextDelivery) =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            defaultDelivery: nextDelivery,
                          }
                        : prev
                    )
                  }
                />
              </div>
            </fieldset>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">
                  允许启动应用与调整窗口位置
                </div>
                <p className="settings-row__description">
                  向 Agent 开放 computer_launch_app 与 computer_set_window_frame 工具（受拒绝共享应用名单约束）。
                </p>
              </div>
              <SwitchControl
                checked={draft?.launchEnabled ?? false}
                onChange={(next) =>
                  setDraft((prev) =>
                    prev ? { ...prev, launchEnabled: next } : prev
                  )
                }
                ariaLabel="允许启动应用与调整窗口位置"
              />
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">允许读写系统剪贴板</div>
                <p className="settings-row__description">
                  向 Agent 开放 computer_clipboard_read 与 computer_clipboard_write 工具。
                </p>
              </div>
              <SwitchControl
                checked={draft?.clipboardEnabled ?? false}
                onChange={(next) =>
                  setDraft((prev) =>
                    prev ? { ...prev, clipboardEnabled: next } : prev
                  )
                }
                ariaLabel="允许读写系统剪贴板"
              />
            </div>

            <div className="settings-row border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div>
                <div className="text-sm font-medium">
                  允许在窗口选择器中共享整个屏幕
                </div>
                <p className="settings-row__description">
                  开启后可在「选择共享窗口」弹窗中启用整个屏幕级别的共享授权。
                </p>
              </div>
              <SwitchControl
                checked={draft?.screenEnabled ?? false}
                onChange={(next) =>
                  setDraft((prev) =>
                    prev ? { ...prev, screenEnabled: next } : prev
                  )
                }
                ariaLabel="允许在窗口选择器中共享整个屏幕"
              />
            </div>

            <div className="settings-row settings-row--stacked border-t border-[var(--border-subtle,hsl(var(--border)))]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="settings-row__stack">
                  <label
                    htmlFor={customBlockInputId}
                    className="text-sm font-medium"
                  >
                    拒绝共享应用名单 ({unifiedBlocklist.length})
                  </label>
                  <p className="settings-row__description">
                    名单中的应用无论在单窗口、整应用还是全屏模式下均不会被 Agent 读取、截图或控制。
                  </p>
                </div>
                {hasRemovedDefaultBlock ? (
                  <AstryxButton
                    variant="secondary"
                    size="mini"
                    onClick={handleRestoreDefaultBlocklist}
                  >
                    恢复默认名单
                  </AstryxButton>
                ) : null}
              </div>

              {unifiedBlocklist.length === 0 ? (
                <div className="mt-2.5 rounded-md border border-dashed border-[var(--border-subtle,hsl(var(--border)))] py-5 text-center text-xs text-muted-foreground">
                  当前拒绝共享应用名单为空。可在下方选择本机应用、选择执行文件或输入应用名称添加。
                </div>
              ) : (
                <div
                  className="mt-2.5 divide-y divide-[var(--border-subtle,hsl(var(--border)))] overflow-y-auto rounded-lg border border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,transparent)]"
                  style={{ maxHeight: '220px' }}
                >
                  {unifiedBlocklist.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                          <Icons.Ban />
                        </span>
                        <span className="truncate font-medium text-foreground">
                          {item.title}
                        </span>
                        {item.subtitle ? (
                          <span className="settings-meta-chip shrink-0 px-1.5 py-0.2 font-mono text-[11px] text-muted-foreground">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </div>
                      <AstryxButton
                        variant="secondary"
                        size="mini"
                        ariaLabel={`移除 ${item.title}`}
                        onClick={() =>
                          item.kind === 'default'
                            ? handleRemoveDefaultBlockEntry(item.value)
                            : handleRemoveCustomBlockEntry(item.value)
                        }
                      >
                        移除
                      </AstryxButton>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <AstryxButton
                  variant="secondary"
                  size="compact"
                  onClick={() => setAppPickerOpen(true)}
                  icon={<Icons.AppWindow />}
                >
                  选择应用...
                </AstryxButton>
                <AstryxButton
                  variant="secondary"
                  size="compact"
                  disabled={pickingExe}
                  onClick={() => void handlePickExecutableFile()}
                >
                  {pickingExe ? '正在打开...' : '选择执行文件...'}
                </AstryxButton>
                <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
                  <AstryxSearchInput
                    id={customBlockInputId}
                    value={customBlockInput}
                    onChange={setCustomBlockInput}
                    showSearchIcon={false}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCustomBlockEntry();
                      }
                    }}
                    placeholder="或输入应用名、进程名 (.exe) / Bundle ID..."
                    className="flex-1"
                    style={{ flex: '1 1 0%', minWidth: 0 }}
                  />
                  <AstryxButton
                    variant="secondary"
                    size="compact"
                    onClick={handleAddCustomBlockEntry}
                  >
                    添加
                  </AstryxButton>
                </div>
              </div>
            </div>
          </SectionGroup>

          {/* 6. Recent Agent Activity Log */}
          <SectionGroup
            icon={<Icons.Activity />}
            title="最近控制记录"
            description="实时展示 Agent 最近执行的窗口读取与键鼠动作记录。"
            action={
              activity.length > 0 ? (
                <AstryxButton
                  variant="secondary"
                  size="mini"
                  onClick={() =>
                    void invoke('computer.clearActivity', {}).then(() =>
                      setActivity([])
                    )
                  }
                >
                  清空记录
                </AstryxButton>
              ) : undefined
            }
          >
            {activity.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                暂无 Agent 电脑控制操作记录。
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle,hsl(var(--border)))]">
                {activity.slice(0, 15).map((item, idx) => {
                  const itemTime = item.timestampMs ?? item.at ?? Date.now();
                  return (
                    <div
                      key={item.id ?? `${itemTime}-${idx}`}
                      className="flex items-center justify-between gap-3 py-2 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="settings-meta-chip shrink-0 px-1.5 py-0.5 font-medium">
                          {ACTION_LABELS[item.action] ?? item.action}
                        </span>
                        <span className="truncate font-medium">
                          {item.windowTitle ||
                            item.appName ||
                            item.app ||
                            item.targetId}
                        </span>
                        {item.delivery ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            ({item.delivery === 'foreground' ? '前台' : '后台'})
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`agent-registry-status ${
                            item.outcome === 'done'
                              ? 'settings-status-pill-success'
                              : item.outcome === 'refused'
                                ? 'settings-status-pill-warning'
                                : 'settings-status-pill-danger'
                          }`}
                        >
                          {item.outcome === 'done'
                            ? '已完成'
                            : item.outcome === 'refused'
                              ? '已拦截'
                              : '失败'}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {formatRelativeTime(itemTime)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionGroup>
        </div>

        {/* Tahoe Unified Floating Action Bar for Unsaved Preference Changes */}
        {dirty ? (
          <div className="settings-action-bar" data-testid="settings-action-bar">
            <div className="settings-action-bar__stage rounded-xl border border-[var(--border-glass,hsl(var(--border)))] bg-[var(--surface-content,hsl(var(--card)))]/90 shadow-lg">
              <div className="settings-action-bar__inner h-full">
                <span className="settings-action-bar__message">
                  电脑控制偏好设置已修改，保存后立即生效
                </span>
                <div className="settings-action-bar__actions">
                  <AstryxButton
                    variant="secondary"
                    size="mini"
                    disabled={saving}
                    onClick={handleDiscardPreferences}
                  >
                    放弃更改
                  </AstryxButton>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSavePreferences()}
                    className="inline-flex h-7 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? '保存中...' : '保存更改'}
                  </button>
                </div>
              </div>
            </div>
            {saveError ? (
              <p className="settings-action-bar__error" role="alert">
                {saveError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <WindowPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        screenEnabled={savedSettings?.screenEnabled ?? false}
        sharedState={sharedState}
        invoke={invoke}
        onSharedChanged={(nextState) => setSharedState(nextState)}
      />

      <LocalAppPickerModal
        open={appPickerOpen}
        onClose={() => setAppPickerOpen(false)}
        invoke={invoke}
        existingMatchers={existingBlockedMatchers}
        onConfirm={(selectedEntries) => addBlocklistEntries(selectedEntries)}
      />
    </div>
  );
}

