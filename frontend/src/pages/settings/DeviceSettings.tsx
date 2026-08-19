import { useTranslation } from 'react-i18next';

import { useBackendTransport } from '@/lib/transport';
import { DevicePairingPanel } from './DevicePairingPanel';
import { SettingsPageHeader } from './SettingsUi';

export function DeviceSettings() {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title={t('devices.title')}
        description={t('devices.description')}
      />
      <div className="settings-sections">
        <DevicePairingPanel
          transport={transport}
          hostUrls={
            typeof window === 'undefined' ? [] : [window.location.origin]
          }
        />
      </div>
    </div>
  );
}
