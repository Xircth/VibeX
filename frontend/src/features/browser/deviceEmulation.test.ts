import { describe, expect, it, vi } from 'vitest';
import { applyDevicePreset } from './deviceEmulation';

describe('applyDevicePreset', () => {
  it('applies viewport, DPR, touch, UA, and media through CDP', async () => {
    const execute = vi.fn().mockResolvedValue({});

    await applyDevicePreset({ execute }, 'mobile');

    expect(execute).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      })
    );
    expect(execute).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    expect(execute).toHaveBeenCalledWith(
      'Network.setUserAgentOverride',
      expect.objectContaining({ userAgent: expect.stringContaining('Mobile') })
    );
    expect(execute).toHaveBeenCalledWith('Emulation.setEmulatedMedia', {
      media: 'screen',
    });
  });

  it('clears all overrides when returning to desktop', async () => {
    const execute = vi.fn().mockResolvedValue({});

    await applyDevicePreset({ execute }, 'desktop');

    expect(execute).toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride'
    );
    expect(execute).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: false,
    });
    expect(execute).toHaveBeenCalledWith('Network.setUserAgentOverride', {
      userAgent: '',
    });
    expect(execute).toHaveBeenCalledWith('Emulation.setEmulatedMedia', {
      media: '',
    });
  });
});
