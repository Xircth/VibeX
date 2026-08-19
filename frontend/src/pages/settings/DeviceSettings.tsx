import { useBackendTransport } from '@/lib/transport';
import { DevicePairingPanel } from './DevicePairingPanel';

export function DeviceSettings() {
  const transport = useBackendTransport();

  return (
    <div className="settings-content">
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
