import { ThemeProvider } from '@/components/ThemeProvider';
import { DesktopToastWindow } from '@/components/desktop-toast/DesktopToastWindow';
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { useUserSystem } from '@/components/ConfigProvider';
import { ThemeMode } from 'shared/types';

export function DesktopToastApp() {
  const { config } = useUserSystem();

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <LegacyDesignScope>
        <DesktopToastWindow />
      </LegacyDesignScope>
    </ThemeProvider>
  );
}
