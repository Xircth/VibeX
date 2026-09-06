import { desktopShellCall, isTauriClient } from '@/lib/desktopShell';

export const appWindowApi = {
  open: async (): Promise<string> => {
    return desktopShellCall<string>('open_app_window');
  },
};

export function openLocalAppWindow(): void {
  if (!isTauriClient()) {
    return;
  }
  void appWindowApi.open();
}
