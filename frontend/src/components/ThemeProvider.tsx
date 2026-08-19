import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { ThemeMode } from 'shared/types';
import { backendListen } from '@/lib/backendTransport';
import {
  applyNativeAppIcon,
  getAppIconStyle,
  resolveAppLogo,
  subscribeAppIconStyle,
} from '@/lib/appIcon';
import {
  applyResolvedThemeClass,
  persistResolvedTheme,
  readCachedResolvedTheme,
} from '@/lib/resolvedTheme';

type ResolvedTheme = 'light' | 'dark';

type ThemeProviderProps = {
  children: React.ReactNode;
  initialTheme?: ThemeMode;
};

type ThemeProviderState = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
};

const getSystemTheme = (): ResolvedTheme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const initialState: ThemeProviderState = {
  theme: ThemeMode.SYSTEM,
  resolvedTheme: 'light',
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  initialTheme = ThemeMode.SYSTEM,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (initialTheme !== ThemeMode.SYSTEM) {
      return initialTheme === ThemeMode.DARK ? 'dark' : 'light';
    }
    return readCachedResolvedTheme() ?? getSystemTheme();
  });
  const appIconStyle = useSyncExternalStore(
    subscribeAppIconStyle,
    getAppIconStyle,
    getAppIconStyle
  );

  // Update theme when initialTheme changes
  useEffect(() => {
    setThemeState(initialTheme);
  }, [initialTheme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event?: MediaQueryListEvent) => {
      setSystemTheme(event?.matches ? 'dark' : getSystemTheme());
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const resolvedTheme =
    theme === ThemeMode.SYSTEM
      ? systemTheme
      : theme === ThemeMode.DARK
        ? 'dark'
        : 'light';

  useEffect(() => {
    applyResolvedThemeClass(resolvedTheme);
    persistResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>(
      'link[data-app-icon]'
    );
    if (favicon) favicon.href = resolveAppLogo(appIconStyle, resolvedTheme);
    void applyNativeAppIcon(appIconStyle, resolvedTheme).catch((error) =>
      console.error('Failed to apply application icon', error)
    );
  }, [appIconStyle, resolvedTheme]);

  // Listen for cross-window theme changes (e.g. settings window → main window)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    backendListen<{ theme: ThemeMode }>('theme-changed', (payload) => {
      setThemeState(payload.theme);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme);
  };

  const value = {
    theme,
    resolvedTheme,
    setTheme,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};
