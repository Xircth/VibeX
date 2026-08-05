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
 * Delivers the two user-controlled completion channels independently, but only
 * while the main application window is unfocused. The in-app completion message
 * remains visible in the main window regardless of this detached delivery.
 */
export async function deliverSessionCompletionNotification({
  windowFocused,
  soundEnabled,
  soundFile,
  pushEnabled,
  playSound,
  showPush,
}: SessionCompletionNotificationRequest): Promise<void> {
  if (windowFocused) return;

  const deliveries: Promise<void>[] = [];
  if (soundEnabled) deliveries.push(playSound(soundFile));
  if (pushEnabled) deliveries.push(showPush());
  await Promise.all(deliveries);
}
