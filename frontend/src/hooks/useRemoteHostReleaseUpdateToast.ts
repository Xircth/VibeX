import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { hostClientApi, settingsWindowApi } from '@/lib/api';
import { useTauriClient } from '@/lib/desktopShell';
import { isHostAppWindowLabel } from '@/lib/hostBoundWindow';

const HOST_CLIENT_CHANGED = 'host-client-changed';
const HOST_UPDATE_SETTINGS_PATH = '/settings/web-service';

function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

export function useRemoteHostReleaseUpdateToast() {
  const isTauri = useTauriClient();
  const { t } = useTranslation(['settings', 'app']);
  const shownKey = useRef('');

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const check = async () => {
      if (!isHostAppWindowLabel(currentWindowLabel())) return;
      try {
        const status = await hostClientApi.status();
        if (cancelled) return;
        if (!status.connected || !status.profile) {
          shownKey.current = '';
          return;
        }
        const updates = await hostClientApi.hostUpdates();
        if (cancelled) return;
        const update = updates.find(
          (item) =>
            item.profile_id === status.profile?.id && item.update_available
        );
        if (!update?.latest_version) return;
        const key = `${update.profile_id}:${update.latest_version}`;
        if (shownKey.current === key) return;
        shownKey.current = key;
        toast.warning(
          t('webService.hostUpdateToast', {
            from: update.current_version ?? '—',
            to: update.latest_version,
          }),
          {
            duration: 12_000,
            action: {
              label: t('app:shell.viewUpdate'),
              onClick: () => {
                void settingsWindowApi.open(HOST_UPDATE_SETTINGS_PATH);
              },
            },
          }
        );
      } catch {
        // Version check is advisory; a failed probe must not block the Host window.
      }
    };

    void check();
    void import('@/lib/tauriApi')
      .then(({ tauriListen }) =>
        tauriListen(HOST_CLIENT_CHANGED, () => void check())
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isTauri, t]);
}
