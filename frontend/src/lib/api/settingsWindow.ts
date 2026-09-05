import i18n from '@/i18n';
import { desktopShellCall } from '@/lib/desktopShell';

export const settingsWindowApi = {
  open: async (): Promise<void> => {
    return desktopShellCall<void>('open_settings_window', {
      title: i18n.t('windowTitle', { ns: 'settings' }),
    });
  },
};
