import { describe, expect, it, vi } from 'vitest';
import { SoundFile } from 'shared/types';

import { deliverDesktopNotification } from './sessionCompletionNotification';

describe('deliverDesktopNotification', () => {
  it('suppresses both channels while focused and set to unfocused-only', async () => {
    const playSound = vi.fn().mockResolvedValue(undefined);
    const showPush = vi.fn().mockResolvedValue(undefined);

    await deliverDesktopNotification({
      windowFocused: true,
      notifyWhen: 'unfocused',
      soundEnabled: true,
      soundFile: SoundFile.PHONE_VIBRATION,
      pushEnabled: true,
      playSound,
      showPush,
    });

    expect(playSound).not.toHaveBeenCalled();
    expect(showPush).not.toHaveBeenCalled();
  });

  it('delivers while focused when set to always', async () => {
    const playSound = vi.fn().mockResolvedValue(undefined);
    const showPush = vi.fn().mockResolvedValue(undefined);

    await deliverDesktopNotification({
      windowFocused: true,
      notifyWhen: 'always',
      soundEnabled: true,
      soundFile: SoundFile.PHONE_VIBRATION,
      pushEnabled: true,
      playSound,
      showPush,
    });

    expect(playSound).toHaveBeenCalledWith(SoundFile.PHONE_VIBRATION);
    expect(showPush).toHaveBeenCalledOnce();
  });

  it('delivers each enabled channel independently while unfocused', async () => {
    const playSound = vi.fn().mockResolvedValue(undefined);
    const showPush = vi.fn().mockResolvedValue(undefined);

    await deliverDesktopNotification({
      windowFocused: false,
      notifyWhen: 'unfocused',
      soundEnabled: true,
      soundFile: SoundFile.PHONE_VIBRATION,
      pushEnabled: true,
      playSound,
      showPush,
    });

    expect(playSound).toHaveBeenCalledWith(SoundFile.PHONE_VIBRATION);
    expect(showPush).toHaveBeenCalledOnce();
  });
});
