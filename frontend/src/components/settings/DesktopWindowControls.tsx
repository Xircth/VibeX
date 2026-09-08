import { useTauriClient } from '@/lib/desktopShell';
import { isWindows } from '@/utils/platform';
import { WindowControls } from './WindowControls';

export function DesktopWindowControls() {
  const isTauri = useTauriClient();
  if (!isTauri || !isWindows()) {
    return null;
  }

  return (
    <div className="fixed right-0 top-0 z-[20000]">
      <WindowControls />
    </div>
  );
}
