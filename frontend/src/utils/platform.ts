export type HostPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export function getHostPlatform(): HostPlatform {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    nav.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    '';
  const normalized = platform.toLowerCase();

  if (normalized.includes('win')) return 'windows';
  if (
    normalized.includes('mac') ||
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('ipod')
  ) {
    return 'macos';
  }
  if (normalized.includes('linux') || normalized.includes('x11')) {
    return 'linux';
  }

  return 'unknown';
}

export function isMac(): boolean {
  return getHostPlatform() === 'macos';
}

export function isWindows(): boolean {
  return getHostPlatform() === 'windows';
}

export function usesSolidHostChrome(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.documentElement.classList.contains('host-windows');
}

export function applyHostPlatformToDocument(): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.dataset.hostPlatform = getHostPlatform();
  document.documentElement.classList.toggle('host-windows', isWindows());
}

export function getModifierKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
