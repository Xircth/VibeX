import { Check, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type HostPairedDevice,
  type PendingDeviceConnectRequest,
  webServiceApi,
} from '@/lib/api/config';
import { settingsWindowApi } from '@/lib/api/settingsWindow';
import { isLocalDesktopHost } from '@/lib/desktopShell';
import { writeDesktopSharedPreferenceSection } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

const POLL_INTERVAL_MS = 1800;
const CONNECTED_FEEDBACK_MS = 3000;
const AUTO_CONNECT_BANNER_MS = 5000;
export const CONNECT_REQUESTS_CHANGED_EVENT = 'dimo:connect-requests-changed';
export const REMOTE_AUTO_CONNECT_KEY = 'dimo:remote-auto-connect';
export const HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY =
  '__same_account_auto_connect_v1';
export const MOBILE_IDLE_REMINDER_KEY = 'dimo:mobile-idle-reminder';
/** How long a shown or dismissed offline reminder stays quiet for that device. */
export const MOBILE_IDLE_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * Wait until the reminder has actually stayed on screen. Writing the cooldown
 * immediately would let React StrictMode's setup/cleanup/setup cycle record it
 * and then suppress the real mount.
 */
export const MOBILE_IDLE_REMINDER_ARM_MS = 1000;

export function getRemoteAutoConnect(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(REMOTE_AUTO_CONNECT_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setRemoteAutoConnect(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      REMOTE_AUTO_CONNECT_KEY,
      enabled ? 'true' : 'false'
    );
    void writeDesktopSharedPreferenceSection(
      HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY,
      enabled
    );
    notifyConnectRequestsChanged();
  } catch {
    // Ignore storage errors
  }
}

export function notifyConnectRequestsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CONNECT_REQUESTS_CHANGED_EVENT));
  }
}

interface IdleReminderRecord {
  devices: Record<string, number>;
}

function readIdleReminderSnoozes(): Record<string, number> {
  const raw = readLocalStorage(MOBILE_IDLE_REMINDER_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<IdleReminderRecord> | null;
    if (!parsed || typeof parsed.devices !== 'object' || !parsed.devices) {
      return {};
    }
    const devices: Record<string, number> = {};
    for (const [deviceId, snoozeUntil] of Object.entries(parsed.devices)) {
      if (typeof snoozeUntil === 'number' && Number.isFinite(snoozeUntil)) {
        devices[deviceId] = snoozeUntil;
      }
    }
    return devices;
  } catch {
    return {};
  }
}

export function isDeviceIdleReminderSnoozed(
  deviceId: string,
  now = Date.now()
): boolean {
  const snoozeUntil = readIdleReminderSnoozes()[deviceId];
  return typeof snoozeUntil === 'number' && snoozeUntil > now;
}

export function commitIdleReminder(deviceId: string, now = Date.now()): void {
  if (!deviceId) return;
  const devices = readIdleReminderSnoozes();
  devices[deviceId] = now + MOBILE_IDLE_REMINDER_COOLDOWN_MS;
  const record: IdleReminderRecord = { devices };
  writeLocalStorage(MOBILE_IDLE_REMINDER_KEY, JSON.stringify(record));
}

function isMobilePairedDevice(device: HostPairedDevice): boolean {
  const kind = device.client_kind?.toLowerCase();
  if (kind === 'mobile') return true;
  if (kind === 'web') return false;
  const name = (device.device_name || '').toLowerCase();
  if (
    /\b(iphone|ipad|android|pixel|mobile|ios|honor|huawei|xiaomi|redmi|oppo|vivo|oneplus|samsung|galaxy)\b/i.test(
      name
    ) ||
    name.includes('an00') ||
    name.includes('al00') ||
    name.startsWith('dio-') ||
    device.preset === 'companion'
  ) {
    return true;
  }
  return false;
}

function isActivelyConnectedRecently(
  device: HostPairedDevice,
  sessionStartMs: number
): boolean {
  const raw = device.last_connected_at;
  if (!raw) return false;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return false;
  return ts >= sessionStartMs || Date.now() - ts < 90_000;
}

function selectIdleReminderDevice(
  devices: HostPairedDevice[],
  sessionStartMs: number,
  shownDeviceId: string | null
): HostPairedDevice | null {
  if (shownDeviceId) {
    const shown = devices.find((device) => device.device_id === shownDeviceId);
    if (shown && !isActivelyConnectedRecently(shown, sessionStartMs)) {
      return shown;
    }
  }
  return (
    devices.find(
      (device) =>
        !isActivelyConnectedRecently(device, sessionStartMs) &&
        !isDeviceIdleReminderSnoozed(device.device_id)
    ) ?? null
  );
}

interface ConnectedMobileNotice {
  deviceName: string;
  sasCode?: string | null;
  accountDisplayName?: string | null;
  issuedDeviceId?: string | null;
}

export function MobileDeviceConnectBanner() {
  const [requests, setRequests] = useState<PendingDeviceConnectRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [connectedNotice, setConnectedNotice] =
    useState<ConnectedMobileNotice | null>(null);
  const [idleDevice, setIdleDevice] = useState<HostPairedDevice | null>(null);
  const sessionStartMsRef = useRef<number>(Date.now());
  const shownIdleDeviceIdRef = useRef<string | null>(null);
  const clearFeedbackTimerRef = useRef<number | null>(null);
  const respondedIdsRef = useRef<Set<string>>(new Set());
  const seenAutoApprovedIdsRef = useRef<Set<string>>(new Set());

  const dismissIdleReminder = useCallback(() => {
    const deviceId = shownIdleDeviceIdRef.current;
    if (deviceId) {
      commitIdleReminder(deviceId);
    }
    shownIdleDeviceIdRef.current = null;
    setIdleDevice(null);
  }, []);

  const showConnectedNotice = useCallback(
    (notice: ConnectedMobileNotice, durationMs: number) => {
      dismissIdleReminder();
      setConnectedNotice(notice);
      if (clearFeedbackTimerRef.current !== null) {
        window.clearTimeout(clearFeedbackTimerRef.current);
      }
      clearFeedbackTimerRef.current = window.setTimeout(() => {
        setConnectedNotice(null);
        clearFeedbackTimerRef.current = null;
      }, durationMs);
    },
    [dismissIdleReminder]
  );

  const handleRespond = useCallback(
    async (item: PendingDeviceConnectRequest, approve: boolean) => {
      setBusyId(item.request_id);
      try {
        await webServiceApi.respondConnectRequest(item.request_id, approve);
        respondedIdsRef.current.add(item.request_id);
        setRequests((prev) =>
          prev.filter((entry) => entry.request_id !== item.request_id)
        );
        notifyConnectRequestsChanged();
        if (approve) {
          showConnectedNotice(
            {
              deviceName: item.device_name,
              sasCode: item.sas_code,
              accountDisplayName: item.account_display_name ?? null,
            },
            CONNECTED_FEEDBACK_MS
          );
        }
      } catch (err) {
        console.warn('Failed to respond to mobile connect request:', err);
      } finally {
        setBusyId(null);
      }
    },
    [showConnectedNotice]
  );

  const handleDisconnectIssued = useCallback(async (deviceId: string) => {
    setRevokingDeviceId(deviceId);
    try {
      await webServiceApi.revokeDevice(deviceId);
      if (clearFeedbackTimerRef.current !== null) {
        window.clearTimeout(clearFeedbackTimerRef.current);
        clearFeedbackTimerRef.current = null;
      }
      setConnectedNotice(null);
      notifyConnectRequestsChanged();
    } catch (err) {
      console.warn('Failed to revoke auto-connected mobile device:', err);
    } finally {
      setRevokingDeviceId(null);
    }
  }, []);

  const refreshRequests = useCallback(async () => {
    if (!isLocalDesktopHost()) {
      return;
    }
    try {
      const [nextRequests, devices] = await Promise.all([
        webServiceApi.listConnectRequests(),
        webServiceApi.listDevices().catch(() => [] as HostPairedDevice[]),
      ]);
      const mobileDevices = Array.isArray(devices)
        ? devices.filter(isMobilePairedDevice)
        : [];
      const nextIdle = selectIdleReminderDevice(
        mobileDevices,
        sessionStartMsRef.current,
        shownIdleDeviceIdRef.current
      );
      shownIdleDeviceIdRef.current = nextIdle?.device_id ?? null;
      setIdleDevice((current) =>
        current?.device_id === nextIdle?.device_id ? current : nextIdle
      );

      const allItems = Array.isArray(nextRequests) ? nextRequests : [];
      const freshAutoApproved = allItems.find(
        (entry) =>
          entry.status === 'approved' &&
          !seenAutoApprovedIdsRef.current.has(entry.request_id)
      );
      if (freshAutoApproved) {
        seenAutoApprovedIdsRef.current.add(freshAutoApproved.request_id);
        showConnectedNotice(
          {
            deviceName: freshAutoApproved.device_name,
            sasCode: freshAutoApproved.sas_code,
            accountDisplayName: freshAutoApproved.account_display_name ?? null,
            issuedDeviceId: freshAutoApproved.issued_device_id ?? null,
          },
          AUTO_CONNECT_BANNER_MS
        );
      }

      const filtered = allItems.filter(
        (entry) =>
          entry.status !== 'approved' &&
          !respondedIdsRef.current.has(entry.request_id)
      );

      // If auto-connect is enabled and an already-paired mobile device with a matching Ed25519 public key is requesting connection, auto-approve.
      // Never auto-approve based on device_name alone or for non-mobile client_kind (which grants Workstation scopes).
      if (
        mobileDevices.length > 0 &&
        getRemoteAutoConnect() &&
        filtered.length > 0
      ) {
        const matched = filtered.find((req) => {
          if (req.client_kind?.trim().toLowerCase() !== 'mobile') {
            return false;
          }
          const reqPubkey = req.public_key_ed25519?.trim();
          if (!reqPubkey) {
            return false;
          }
          return mobileDevices.some(
            (dev) => dev.public_key_ed25519?.trim() === reqPubkey
          );
        });
        if (matched && !respondedIdsRef.current.has(matched.request_id)) {
          respondedIdsRef.current.add(matched.request_id);
          void handleRespond(matched, true);
          return;
        }
      }

      setRequests(filtered);
    } catch {
      // Ignore in non-host windows or before backend is ready
    }
  }, [handleRespond, showConnectedNotice]);

  useEffect(() => {
    void refreshRequests();
    const intervalId = window.setInterval(() => {
      void refreshRequests();
    }, POLL_INTERVAL_MS);
    const handleChanged = () => {
      void refreshRequests();
    };
    window.addEventListener(CONNECT_REQUESTS_CHANGED_EVENT, handleChanged);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener(CONNECT_REQUESTS_CHANGED_EVENT, handleChanged);
      if (clearFeedbackTimerRef.current !== null) {
        window.clearTimeout(clearFeedbackTimerRef.current);
      }
    };
  }, [refreshRequests]);

  useEffect(() => {
    if (!idleDevice) return;
    const deviceId = idleDevice.device_id;
    const timer = window.setTimeout(() => {
      commitIdleReminder(deviceId);
    }, MOBILE_IDLE_REMINDER_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [idleDevice]);

  // Active connect requests always show. The offline reminder is quieter: once
  // it has been on screen briefly, or the user dismisses it, that device stays
  // silent until the cooldown ends.
  const active = requests[0] ?? null;
  if (!active && !connectedNotice && !idleDevice) {
    return null;
  }

  return (
    <div
      data-testid="mobile-device-connect-banner"
      className="pointer-events-none absolute inset-x-0 top-2 z-30 flex items-center justify-center px-4"
    >
      <div
        role="region"
        aria-label="可用移动设备连接请求"
        className="pointer-events-auto inline-flex min-h-11 max-w-full items-center gap-3 rounded-full border border-border bg-secondary/95 px-4 py-2 text-sm text-foreground shadow-lg backdrop-blur-md transition-all duration-150"
      >
        {connectedNotice && !active ? (
          <>
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
              <Check className="h-4 w-4" />
            </span>
            <span className="truncate font-semibold">
              已连接移动设备「{connectedNotice.deviceName}」
            </span>
            {connectedNotice.accountDisplayName ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                同账号 · {connectedNotice.accountDisplayName}
              </span>
            ) : null}
            {connectedNotice.sasCode ? (
              <span
                className="shrink-0 rounded-md border border-border/70 bg-card px-2.5 py-1 font-mono text-xs font-semibold tabular-nums text-foreground"
                title="可与手机端显示的 4 位连接码对比核验"
              >
                连接码 {connectedNotice.sasCode}
              </span>
            ) : null}
            {connectedNotice.issuedDeviceId ? (
              <button
                type="button"
                disabled={revokingDeviceId === connectedNotice.issuedDeviceId}
                onClick={() => {
                  if (connectedNotice.issuedDeviceId) {
                    void handleDisconnectIssued(connectedNotice.issuedDeviceId);
                  }
                }}
                className="ml-1 inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-destructive disabled:opacity-50"
              >
                断开
              </button>
            ) : null}
          </>
        ) : active ? (
          <>
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
            </span>
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Smartphone className="h-4 w-4" />
            </span>
            <span className="truncate text-sm font-semibold text-foreground">
              发现可用移动设备「{active.device_name}」
            </span>
            {active.account_display_name ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                同账号 · {active.account_display_name}
              </span>
            ) : null}
            <span
              className="shrink-0 rounded-md border border-border/70 bg-card px-2.5 py-1 font-mono text-xs font-semibold tabular-nums text-foreground"
              title="请对比手机端显示的 4 位连接码"
            >
              连接码 {active.sas_code}
            </span>
            {requests.length > 1 ? (
              <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                +{requests.length - 1}
              </span>
            ) : null}
            <div className="ml-1 flex items-center gap-1.5">
              <button
                type="button"
                disabled={busyId === active.request_id}
                onClick={() => void handleRespond(active, true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                连接
              </button>
              <button
                type="button"
                disabled={busyId === active.request_id}
                onClick={() => void handleRespond(active, false)}
                aria-label="忽略连接请求"
                className="inline-flex h-8 items-center rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                <span className="ml-1">忽略</span>
              </button>
            </div>
          </>
        ) : idleDevice ? (
          <>
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Smartphone className="h-4 w-4" />
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              已配对手机「{idleDevice.device_name}」尚未连接
            </span>
            <div className="ml-1 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  dismissIdleReminder();
                  void settingsWindowApi.open('/settings/web-service');
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
              >
                查看连接
              </button>
              <button
                type="button"
                onClick={dismissIdleReminder}
                aria-label="忽略未连接提醒"
                className="inline-flex h-8 items-center rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
                <span className="ml-1">忽略</span>
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
