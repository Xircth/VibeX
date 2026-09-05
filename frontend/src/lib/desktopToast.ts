import { desktopShellCall } from '@/lib/desktopShell';

export type DesktopToastPayload = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  description: string;
  kind: 'success' | 'error';
  durationMs?: number;
};

export async function showDesktopToast(
  payload: DesktopToastPayload
): Promise<void> {
  await desktopShellCall('show_desktop_toast', { payload });
}
