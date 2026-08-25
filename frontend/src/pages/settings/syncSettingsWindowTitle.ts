export async function syncSettingsWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const current = getCurrentWindow();
    if (current.label !== 'settings') return;
    await current.setTitle(title);
  } catch {
    // Browser, tests, and windows without a native title stay unchanged.
  }
}
