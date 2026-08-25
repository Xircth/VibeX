import i18n from '@/i18n';

import { backendCall } from './base';

export const settingsWindowApi = {
  open: async (): Promise<void> => {
    return backendCall<void>('open_settings_window', {
      title: i18n.t('windowTitle', { ns: 'settings' }),
    });
  },
};
