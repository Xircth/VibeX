import { useEffect } from 'react';

import { backendCall } from '@/lib/backendTransport';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

/**
 * Mirrors the aggregated unread-activity count onto the OS tray/dock badge (P2-5).
 * Renders nothing; mounted once at the app shell. Best-effort — swallows errors so
 * a non-desktop/unsupported platform stays silent.
 */
export function TrayBadgeSync() {
  const unread = useWindowProjectsStore(
    (state) =>
      Object.values(state.projectAlerts).filter((alert) => alert?.unread).length
  );

  useEffect(() => {
    void backendCall('update_tray_badge', { count: unread }).catch(() => {});
  }, [unread]);

  return null;
}
