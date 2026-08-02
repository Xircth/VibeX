import { useTranslation } from 'react-i18next';

import { useBackendTransport } from '@/lib/transport';
import { DevicePairingPanel } from './DevicePairingPanel';
import { SettingsPageHeader } from './SettingsUi';

export function DeviceSettings() {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();

  return (
    <div className="settings-content mx-auto w-full max-w-3xl">
      <SettingsPageHeader
        title={t('devices.title')}
        description={t('devices.description')}
      />
      <DevicePairingPanel transport={transport} />
    </div>
  );
}
