import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import i18n from '@/i18n';
import { desktopShellCall, isTauriClient } from '@/lib/desktopShell';

export const settingsWindowApi = {
  open: async (path?: string): Promise<void> => {
    return desktopShellCall<void>('open_settings_window', {
      title: i18n.t('windowTitle', { ns: 'settings' }),
      ...(path ? { path } : {}),
    });
  },
};

export function openSettingsSurface(
  navigate: (path: string) => void,
  path?: string
): void {
  if (isTauriClient()) {
    void settingsWindowApi.open(path);
    return;
  }
  navigate(path ?? '/settings');
}

export function useOpenSettings(): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    openSettingsSurface(navigate);
  }, [navigate]);
}
