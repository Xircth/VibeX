import darkDefaultLogo from '@/assets/app-logo-dark.png';
import darkLiteLogo from '@/assets/app-logo-dark-lite.png';
import lightDefaultLogo from '@/assets/app-logo-light-default.png';
import lightLiteLogo from '@/assets/app-logo-light-lite.png';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import {
  backendCall,
  configuredBackendTransport,
} from '@/lib/backendTransport';

export const APP_ICON_STYLES = ['default', 'lite'] as const;
export type AppIconStyle = (typeof APP_ICON_STYLES)[number];
export type AppIconTheme = 'light' | 'dark';

export const APP_ICON_STYLE_KEY = 'vibex:app-icon-style';
export const APP_ICON_CHANGED_EVENT = 'vibex:app-icon-changed';

const LOGOS: Record<AppIconStyle, Record<AppIconTheme, string>> = {
  default: { light: lightDefaultLogo, dark: darkDefaultLogo },
  lite: { light: lightLiteLogo, dark: darkLiteLogo },
};

function isAppIconStyle(value: string | null): value is AppIconStyle {
  return APP_ICON_STYLES.includes(value as AppIconStyle);
}

export function getAppIconStyle(): AppIconStyle {
  const stored = localStorage.getItem(APP_ICON_STYLE_KEY);
  return isAppIconStyle(stored) ? stored : 'default';
}

export function setAppIconStyle(style: AppIconStyle): void {
  localStorage.setItem(APP_ICON_STYLE_KEY, style);
  persistFrontendPreference(APP_ICON_STYLE_KEY, style);
  window.dispatchEvent(new CustomEvent(APP_ICON_CHANGED_EVENT));
}

export function subscribeAppIconStyle(onChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === APP_ICON_STYLE_KEY) onChange();
  };
  window.addEventListener(APP_ICON_CHANGED_EVENT, onChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(APP_ICON_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function resolveAppLogo(
  style: AppIconStyle,
  theme: AppIconTheme
): string {
  return LOGOS[style][theme];
}

export async function applyNativeAppIcon(
  style: AppIconStyle,
  theme: AppIconTheme
): Promise<void> {
  if (configuredBackendTransport.environment === 'web') return;
  await backendCall('set_app_icon', { style, theme });
}
