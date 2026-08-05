import { describe, expect, it, vi } from 'vitest';
import { SoundFile } from 'shared/types';

import { deliverSessionCompletionNotification } from './sessionCompletionNotification';

describe('deliverSessionCompletionNotification', () => {
  it('suppresses both completion channels while the main window is focused', async () => {
    const playSound = vi.fn().mockResolvedValue(undefined);
    const showPush = vi.fn().mockResolvedValue(undefined);

    await deliverSessionCompletionNotification({
      kind: 'success',
      windowFocused: true,
      soundEnabled: true,
      soundFile: SoundFile.PHONE_VIBRATION,
      pushEnabled: true,
      playSound,
      showPush,
    });

    expect(playSound).not.toHaveBeenCalled();
    expect(showPush).not.toHaveBeenCalled();
  });

  it('delivers each enabled channel independently while the app is unfocused', async () => {
    const playSound = vi.fn().mockResolvedValue(undefined);
    const showPush = vi.fn().mockResolvedValue(undefined);

    await deliverSessionCompletionNotification({
      kind: 'success',
      windowFocused: false,
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
