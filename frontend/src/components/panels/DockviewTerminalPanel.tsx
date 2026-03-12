import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as TerminalIcon, ScrollText, X } from 'lucide-react';
import { useTauriTerminal } from '@/hooks/useTauriTerminal';
import {
  useTerminalStore,
  generateTerminalTabId,
  type TerminalSession,
} from '@/stores/useTerminalStore';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useLogStream } from '@/hooks/useLogStream';
import { useUserSystem } from '@/components/ConfigProvider';
import {
  getDefaultTerminalShell,
  getTerminalWorkspaceKey,
} from '@/lib/terminalPreferences';

/**
 * DockviewTerminalPanel - Dockview wrapper integrating xterm.js with Tauri PTY.
 *
 * This panel:
 * - Reads the active worktree from WorktreeContext
 * - Manages multiple terminal tabs per workspace
 * - Each tab connects to a dedicated Tauri PTY session
 * - Uses xterm.js for terminal rendering with FitAddon for auto-sizing
 */
function DockviewTerminalPanel() {
  const { activeWorktreeId } = useWorktree();
  const { config } = useUserSystem();
  // Only use actual workspace IDs for terminal PTY – projectId is not a valid workspace
  const workspaceId = getTerminalWorkspaceKey(activeWorktreeId) || undefined;
  const defaultShell = getDefaultTerminalShell(config);

  const sessionsByWorkspace = useTerminalStore((s) => s.sessionsByWorkspace);
  const activeTabByWorkspace = useTerminalStore((s) => s.activeTabByWorkspace);
  const addSession = useTerminalStore((s) => s.addSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);

  const sessions = useMemo(
    () => (workspaceId ? sessionsByWorkspace[workspaceId] || [] : []),
    [sessionsByWorkspace, workspaceId]
  );

  const activeTabId = workspaceId
    ? activeTabByWorkspace[workspaceId] ?? null
    : null;

  // Auto-create a terminal tab if workspace exists but no tabs yet
  const [autoCreated, setAutoCreated] = useState<string | null>(null);
  useEffect(() => {
    setAutoCreated(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || sessions.length !== 0 || autoCreated === workspaceId) {
      return;
    }

    const tabId = generateTerminalTabId();
    addSession(workspaceId, tabId, defaultShell || undefined);
    setAutoCreated(workspaceId);
  }, [
    workspaceId,
    sessions.length,
    autoCreated,
    addSession,
    defaultShell,
  ]);

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      if (!workspaceId) return;
      removeSession(workspaceId, tabId);
    },
    [workspaceId, removeSession]
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!workspaceId) return;
      setActiveTab(workspaceId, tabId);
    },
    [workspaceId, setActiveTab]
  );

  // Show placeholder when no workspace is selected
  if (!workspaceId) {
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center bg-background text-sm gap-3 text-muted-foreground"
        data-panel="terminal"
      >
        <TerminalIcon className="h-8 w-8 opacity-40" />
        <div className="text-center space-y-1">
          <p className="font-medium">终端</p>
          <p className="text-xs">选择一个工作区以打开终端</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full w-full min-h-0 overflow-hidden flex bg-console"
      data-panel="terminal"
    >
      {/* Terminal content area — takes remaining space */}
      <div className="flex-1 min-w-0 min-h-0 relative overflow-hidden">
        {sessions.map((session) =>
          session.type === 'log-viewer' ? (
            <LogViewerTab
              key={session.tabId}
              session={session}
              isActive={activeTabId === session.tabId}
            />
          ) : (
            <TerminalTabContent
              key={session.tabId}
              workspaceId={workspaceId}
              tabId={session.tabId}
              isActive={activeTabId === session.tabId}
              shell={session.shell}
            />
          )
        )}
      </div>

      {/* Vertical tab bar on the right */}
      <div className="shrink-0 w-24 min-h-0 bg-secondary border-l border-border overflow-hidden">
        <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-0">
          {sessions.map((session) => (
            <button
              key={session.tabId}
              onClick={() => handleSelectTab(session.tabId)}
              className={`flex items-center gap-1.5 px-2 py-1.5 text-xs border-b border-border shrink-0 transition-colors ${
                activeTabId === session.tabId
                  ? 'bg-console text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              {session.type === 'log-viewer' ? (
                <ScrollText className="h-3 w-3 shrink-0" />
              ) : (
                <TerminalIcon className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate flex-1 text-left">{session.title}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => handleCloseTab(e, session.tabId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    handleCloseTab(
                      e as unknown as React.MouseEvent,
                      session.tabId
                    );
                  }
                }}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Individual terminal tab content.
 * Each tab has its own xterm.js instance connected to a Tauri PTY.
 */
function TerminalTabContent({
  workspaceId,
  tabId,
  isActive,
  shell,
}: {
  workspaceId: string;
  tabId: string;
  isActive: boolean;
  shell?: string;
}) {
  const { containerRef, refit } = useTauriTerminal({
    workspaceId,
    enabled: true,
    shell,
  });

  // Re-fit terminal when tab becomes visible
  useEffect(() => {
    if (isActive && refit) {
      const timer = setTimeout(() => refit(), 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, refit]);

  return (
    <div
      className={`absolute inset-0 px-2 pt-1 ${isActive ? 'visible' : 'invisible'}`}
      data-terminal-tab={tabId}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

/**
 * Log viewer tab content for dev server process logs.
 * Subscribes to Tauri log-stream events and renders output in a scrollable container.
 */
function LogViewerTab({
  session,
  isActive,
}: {
  session: TerminalSession;
  isActive: boolean;
}) {
  const { logs, error } = useLogStream(session.processId ?? '');
  const containerRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  return (
    <div
      className={`absolute inset-0 ${isActive ? 'visible' : 'invisible'}`}
      data-terminal-tab={session.tabId}
    >
      <div className="h-full w-full flex flex-col bg-console text-foreground">
        {error && (
          <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10 border-b border-border">
            Log stream error: {error}
          </div>
        )}
        <pre
          ref={containerRef}
          className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed"
        >
          {logs.length === 0 && !error && (
            <span className="text-muted-foreground">Waiting for dev server output...</span>
          )}
          {logs.map((entry, i) => (
            <span
              key={i}
              className={entry.type === 'STDERR' ? 'text-destructive' : ''}
            >
              {entry.content}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default DockviewTerminalPanel;
