import { Check, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { settingsWindowApi } from '@/lib/api/settingsWindow';
import {
  type HostPairedDevice,
  type PendingDeviceConnectRequest,
  webServiceApi,
} from '@/lib/api/config';
import { isLocalDesktopHost } from '@/lib/desktopShell';

const POLL_INTERVAL_MS = 2500;
export const CONNECT_REQUESTS_CHANGED_EVENT = 'vibex:connect-requests-changed';
export const REMOTE_AUTO_CONNECT_KEY = 'vibex:remote-auto-connect';

export function getRemoteAutoConnect(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(REMOTE_AUTO_CONNECT_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setRemoteAutoConnect(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      REMOTE_AUTO_CONNECT_KEY,
      enabled ? 'true' : 'false'
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

export function MobileDeviceConnectBanner() {
  const [requests, setRequests] = useState<PendingDeviceConnectRequest[]>([]);
  const [pairedMobileDevices, setPairedMobileDevices] = useState<
    HostPairedDevice[]
  >([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connectedDeviceName, setConnectedDeviceName] = useState<string | null>(
    null
  );
  const [idleReminderDismissed, setIdleReminderDismissed] = useState(false);
  const sessionStartMsRef = useRef<number>(Date.now());
  const clearFeedbackTimerRef = useRef<number | null>(null);
  const respondedIdsRef = useRef<Set<string>>(new Set());

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
          setIdleReminderDismissed(true);
          setConnectedDeviceName(item.device_name);
          if (clearFeedbackTimerRef.current !== null) {
            window.clearTimeout(clearFeedbackTimerRef.current);
          }
          clearFeedbackTimerRef.current = window.setTimeout(() => {
            setConnectedDeviceName(null);
            clearFeedbackTimerRef.current = null;
          }, 2400);
        }
      } catch (err) {
        console.warn('Failed to respond to mobile connect request:', err);
      } finally {
        setBusyId(null);
      }
    },
    []
  );

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
      setPairedMobileDevices(mobileDevices);

      const filtered = Array.isArray(nextRequests)
        ? nextRequests.filter(
            (entry) => !respondedIdsRef.current.has(entry.request_id)
          )
        : [];

      // If auto-connect is enabled and an already-paired mobile device is requesting connection, auto-approve
      if (
        mobileDevices.length > 0 &&
        getRemoteAutoConnect() &&
        filtered.length > 0
      ) {
        const matched = filtered.find((req) =>
          mobileDevices.some(
            (dev) =>
              dev.device_name.trim().toLowerCase() ===
              req.device_name.trim().toLowerCase()
          )
        );
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
  }, [handleRespond]);

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

  // First-time connection reminders belong ONLY inside the Remote Connection settings page.
  // Only show workspace banner after at least one mobile device has been paired, or when an
  // active 1-click connection approval request arrives.
  const active = requests[0] ?? null;
  const hasPairedMobile = pairedMobileDevices.length > 0;
  if (!active && !hasPairedMobile && !connectedDeviceName) {
    return null;
  }

  const primaryPairedMobile = pairedMobileDevices[0] ?? null;
  const isPairedMobileIdle =
    primaryPairedMobile !== null &&
    !isActivelyConnectedRecently(
      primaryPairedMobile,
      sessionStartMsRef.current
    ) &&
    !idleReminderDismissed;

  if (!active && !connectedDeviceName && !isPairedMobileIdle) {
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
        {connectedDeviceName && !active ? (
          <>
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-success/15 text-success">
              <Check className="h-4 w-4" />
            </span>
            <span className="truncate font-semibold">
              已连接移动设备「{connectedDeviceName}」
            </span>
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
            <span
              className="shrink-0 rounded-md border border-border/70 bg-card px-2.5 py-1 font-mono text-xs font-semibold tabular-nums text-foreground"
              title="请核对手机端显示的 4 位安全码"
            >
              核对码 {active.sas_code}
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
        ) : primaryPairedMobile ? (
          <>
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Smartphone className="h-4 w-4" />
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              已配对手机「{primaryPairedMobile.device_name}」尚未连接
            </span>
            <div className="ml-1 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setIdleReminderDismissed(true);
                  void settingsWindowApi.open('/settings/web-service');
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
              >
                查看连接
              </button>
              <button
                type="button"
                onClick={() => setIdleReminderDismissed(true)}
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
