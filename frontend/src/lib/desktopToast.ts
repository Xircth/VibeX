import { backendCall } from '@/lib/backendTransport';

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
  await backendCall('show_desktop_toast', { payload });
}
