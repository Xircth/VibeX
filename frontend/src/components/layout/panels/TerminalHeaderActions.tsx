import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { Plus } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';

import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  useTerminalStore,
  generateTerminalTabId,
} from '@/stores/useTerminalStore';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useUserSystem } from '@/components/ConfigProvider';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
  isExternalTerminalShell,
  type TerminalShellValue,
} from '@/lib/terminalPreferences';
import { tauriInvoke } from '@/lib/tauriApi';

/**
 * Renders shell selector + "new terminal" button in the dockview group
 * header actions area.  Only visible for the group that contains the
 * Terminal panel.
 */
export function TerminalHeaderActions(props: IDockviewHeaderActionsProps) {
  const isTerminalGroup = props.panels.some((p) => p.id === PANEL_IDS.TERMINAL);

  if (!isTerminalGroup) return null;

  return <TerminalHeaderActionsInner />;
}

function TerminalHeaderActionsInner() {
  const { t } = useTranslation(['panels', 'common']);
  const { activeWorktreeId } = useWorktree();
  const { config } = useUserSystem();
  const workspaceKey = getTerminalWorkspaceKey(activeWorktreeId);
  const defaultShell = getDefaultTerminalShell(config);
  const terminalShellOptions = getTerminalShellOptions();

  const addSession = useTerminalStore((s) => s.addSession);
  const [selectedShell, setSelectedShell] =
    useState<TerminalShellValue>(defaultShell);

  useEffect(() => {
    setSelectedShell(defaultShell);
  }, [defaultShell, workspaceKey]);

  const stopPropagation = useCallback((event: SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  const handleCreateTab = useCallback(async () => {
    if (!workspaceKey) return;
    if (isExternalTerminalShell(selectedShell)) {
      try {
        await tauriInvoke<void>('open_external_terminal', {
          workspaceId: workspaceKey,
          terminal: selectedShell,
        });
      } catch (error) {
        toast.error(t('terminalHeader.openExternalFailed'), {
          description:
            error instanceof Error
              ? error.message
              : t('terminalHeader.confirmWarpInstalled'),
        });
      }
      return;
    }

    const tabId = generateTerminalTabId();
    addSession(workspaceKey, tabId, selectedShell);
  }, [workspaceKey, addSession, selectedShell, t]);

  return (
    <div className="flex items-center gap-0.5 h-full px-1">
      <select
        value={selectedShell}
        onChange={(e) => setSelectedShell(e.target.value as TerminalShellValue)}
        onMouseDown={stopPropagation}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
        className="h-6 text-[11px] bg-transparent border border-border rounded px-1 text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer"
        title="Shell type"
      >
        {terminalShellOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        onMouseDown={stopPropagation}
        onPointerDown={stopPropagation}
        onClick={(event) => {
          stopPropagation(event);
          void handleCreateTab();
        }}
        disabled={!workspaceKey}
        className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        title="New terminal"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
