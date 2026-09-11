import { useTauriClient } from '@/lib/desktopShell';
import { isWindows } from '@/utils/platform';
import { WindowControls } from './WindowControls';

export function DesktopWindowControls() {
  const isTauri = useTauriClient();
  if (!isTauri || !isWindows()) {
    return null;
  }

  return (
    <div className="desktop-window-controls pointer-events-none fixed right-0 top-0 z-[20000] h-9 w-max">
      <div className="pointer-events-auto">
        <WindowControls />
      </div>
    </div>
  );
}
