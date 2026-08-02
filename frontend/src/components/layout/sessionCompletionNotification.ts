import type { SoundFile } from 'shared/types';

export interface SessionCompletionNotificationRequest {
  kind: 'success' | 'error';
  windowFocused: boolean;
  soundEnabled: boolean;
  soundFile: SoundFile;
  pushEnabled: boolean;
  playSound: (soundFile: SoundFile) => Promise<void>;
  showPush: () => Promise<void>;
}

/**
 * Delivers the two user-controlled completion channels independently. Sound is
 * an acknowledgement of completion and therefore also plays in the focused
 * window; the detached push window remains reserved for errors/background use.
 */
export async function deliverSessionCompletionNotification({
  kind,
  windowFocused,
  soundEnabled,
  soundFile,
  pushEnabled,
  playSound,
  showPush,
}: SessionCompletionNotificationRequest): Promise<void> {
  const deliveries: Promise<void>[] = [];
  if (soundEnabled) deliveries.push(playSound(soundFile));
  if (pushEnabled && (kind === 'error' || !windowFocused)) {
    deliveries.push(showPush());
  }
  await Promise.all(deliveries);
}
