export type DevicePresetId = 'desktop' | 'tablet' | 'mobile';

interface DevToolsExecutor {
  execute(method: string, params?: unknown): Promise<unknown>;
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
const TABLET_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export async function applyDevicePreset(
  session: DevToolsExecutor,
  preset: DevicePresetId
): Promise<void> {
  if (preset === 'desktop') {
    await session.execute('Emulation.clearDeviceMetricsOverride');
    await session.execute('Emulation.setTouchEmulationEnabled', {
      enabled: false,
    });
    await session.execute('Network.setUserAgentOverride', { userAgent: '' });
    await session.execute('Emulation.setEmulatedMedia', { media: '' });
    return;
  }

  const mobile = preset === 'mobile';
  await session.execute('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 390 : 768,
    height: mobile ? 844 : 1024,
    deviceScaleFactor: mobile ? 3 : 2,
    mobile: true,
    screenWidth: mobile ? 390 : 768,
    screenHeight: mobile ? 844 : 1024,
  });
  await session.execute('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  await session.execute('Network.setUserAgentOverride', {
    userAgent: mobile ? MOBILE_USER_AGENT : TABLET_USER_AGENT,
    platform: 'Android',
  });
  await session.execute('Emulation.setEmulatedMedia', { media: 'screen' });
}
