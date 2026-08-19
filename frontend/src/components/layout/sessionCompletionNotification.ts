import type { NotificationWhen, SoundFile } from 'shared/types';

export interface DesktopNotificationRequest {
  windowFocused: boolean;
  notifyWhen: NotificationWhen;
  soundEnabled: boolean;
  soundFile: SoundFile;
  pushEnabled: boolean;
  playSound: (soundFile: SoundFile) => Promise<void>;
  showPush: () => Promise<void>;
}

export function shouldDeliverDetachedNotification(
  windowFocused: boolean,
  notifyWhen: NotificationWhen
): boolean {
  return notifyWhen === 'always' || !windowFocused;
}

/**
 * Delivers the two user-controlled channels independently. Default is only
 * while the app is unfocused; Settings can switch that to anytime.
 */
export async function deliverDesktopNotification({
  windowFocused,
  notifyWhen,
  soundEnabled,
  soundFile,
  pushEnabled,
  playSound,
  showPush,
}: DesktopNotificationRequest): Promise<void> {
  if (!shouldDeliverDetachedNotification(windowFocused, notifyWhen)) return;

  const deliveries: Promise<void>[] = [];
  if (soundEnabled) deliveries.push(playSound(soundFile));
  if (pushEnabled) deliveries.push(showPush());
  await Promise.all(deliveries);
}

/** @deprecated use deliverDesktopNotification */
export const deliverSessionCompletionNotification = deliverDesktopNotification;
