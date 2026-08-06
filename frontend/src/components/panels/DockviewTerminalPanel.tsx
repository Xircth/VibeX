import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ScrollText, Terminal as TerminalIcon, X } from 'lucide-react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useParams } from 'react-router-dom';
import { toast } from '@/components/ui/toast';
import { useTauriTerminal } from '@/hooks/useTauriTerminal';
import { usePreviewSettings } from '@/hooks/usePreviewSettings';
import { detectDevserverUrl } from '@/hooks/useDevserverUrl';
import {
  useTerminalStore,
  generateTerminalTabId,
  type TerminalSession,
} from '@/stores/useTerminalStore';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useLogStream } from '@/hooks/useLogStream';
import { useUserSystem } from '@/components/ConfigProvider';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { backendCall } from '@/lib/backendTransport';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
  isExternalTerminalShell,
  type TerminalShellValue,
} from '@/lib/terminalPreferences';
import { isTerminalTabCloseKey } from './terminalTabClosePolicy';

type TerminalCloseEvent = Pick<React.SyntheticEvent, 'stopPropagation'>;

function DockviewTerminalPanel(props: IDockviewPanelProps) {
  const { t } = useTranslation(['panels', 'common']);
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const { config } = useUserSystem();
  const { openOrFocusPanel } = usePanelActionsContext();
  const workspaceId =
    getTerminalWorkspaceKey(activeWorktreeId ?? routeWorkspaceId ?? null) ||
    undefined;
  const defaultShell = getDefaultTerminalShell(config);
  const terminalShellOptions = getTerminalShellOptions();
  const { setOverrideUrl } = usePreviewSettings(workspaceId);

  const sessionsByWorkspace = useTerminalStore(
    (state) => state.sessionsByWorkspace
  );
  const activeTabByWorkspace = useTerminalStore(
    (state) => state.activeTabByWorkspace
  );
  const addSession = useTerminalStore((state) => state.addSession);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setSessionId = useTerminalStore((state) => state.setSessionId);

  const sessions = useMemo(
    () => (workspaceId ? sessionsByWorkspace[workspaceId] || [] : []),
    [sessionsByWorkspace, workspaceId]
  );

  const activeTabId = workspaceId
    ? (activeTabByWorkspace[workspaceId] ?? null)
    : null;

  const openPreviewUrl = useCallback(
    (url: string) => {
      const normalizedUrl = detectDevserverUrl(url)?.url ?? url;
      setOverrideUrl(normalizedUrl);
      openOrFocusPanel(PANEL_IDS.WEB_PREVIEW, 'Web Preview');
    },
    [openOrFocusPanel, setOverrideUrl]
  );

  const lastEnsuredWorkspaceRef = useRef<string | null>(null);
  const [selectedShell, setSelectedShell] =
    useState<TerminalShellValue>(defaultShell);
  const [panelRefitVersion, setPanelRefitVersion] = useState(0);
  const isPanelVisible = props.api.isVisible;

  useEffect(() => {
    setSelectedShell(defaultShell);
  }, [defaultShell, workspaceId]);

  useEffect(() => {
    const disposeVisibility = props.api.onDidVisibilityChange(() => {
      setPanelRefitVersion((value) => value + 1);
    });
    const disposeDimensions = props.api.onDidDimensionsChange(() => {
      setPanelRefitVersion((value) => value + 1);
    });
    const disposeActive = props.api.onDidActiveChange(() => {
      setPanelRefitVersion((value) => value + 1);
    });

    return () => {
      disposeVisibility.dispose();
      disposeDimensions.dispose();
      disposeActive.dispose();
    };
  }, [props.api]);

  useEffect(() => {
    if (!workspaceId) {
      lastEnsuredWorkspaceRef.current = null;
      return;
    }

    if (lastEnsuredWorkspaceRef.current === workspaceId) {
      return;
    }

    lastEnsuredWorkspaceRef.current = workspaceId;
    const currentSessions =
      useTerminalStore.getState().sessionsByWorkspace[workspaceId] || [];
    if (currentSessions.length > 0) {
      return;
    }
    if (isExternalTerminalShell(defaultShell)) {
      return;
    }

    const tabId = generateTerminalTabId();
    addSession(workspaceId, tabId, defaultShell);
  }, [workspaceId, addSession, defaultShell]);

  useEffect(() => {
    if (!workspaceId || !isPanelVisible || sessions.length > 0) {
      return;
    }
    if (isExternalTerminalShell(defaultShell)) {
      return;
    }

    const tabId = generateTerminalTabId();
    addSession(workspaceId, tabId, defaultShell);
  }, [addSession, defaultShell, isPanelVisible, sessions.length, workspaceId]);

  useEffect(() => {
    if (!workspaceId || sessions.length === 0) {
      return;
    }

    if (
      activeTabId &&
      sessions.some((session) => session.tabId === activeTabId)
    ) {
      return;
    }

    setActiveTab(workspaceId, sessions[0].tabId);
  }, [activeTabId, sessions, setActiveTab, workspaceId]);

  const handleCloseTab = useCallback(
    async (event: TerminalCloseEvent, tabId: string) => {
      event.stopPropagation();
      if (!workspaceId) return;

      const session = sessions.find((item) => item.tabId === tabId);
      if (session?.type === 'pty' && session.sessionId && !session.readOnly) {
        try {
          await backendCall('close_terminal', { sessionId: session.sessionId });
        } catch (error) {
          console.error('Failed to close terminal session:', error);
        }
      }

      removeSession(workspaceId, tabId);
    },
    [workspaceId, sessions, removeSession]
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!workspaceId) return;
      setActiveTab(workspaceId, tabId);
    },
    [workspaceId, setActiveTab]
  );

  const handleCreateTab = useCallback(async () => {
    if (!workspaceId) return;
    if (isExternalTerminalShell(selectedShell)) {
      try {
        await backendCall<void>('open_external_terminal', {
          workspaceId,
          terminal: selectedShell,
        });
      } catch (error) {
        toast.error(t('terminalPanel.openExternalTerminalFailed'), {
          description:
            error instanceof Error
              ? error.message
              : t('terminalPanel.confirmWarpInstalled'),
        });
      }
      return;
    }

    const tabId = generateTerminalTabId();
    addSession(workspaceId, tabId, selectedShell);
  }, [addSession, selectedShell, workspaceId, t]);

  if (!workspaceId) {
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center bg-background text-sm gap-3 text-muted-foreground"
        data-panel="terminal"
      >
        <TerminalIcon className="h-8 w-8 opacity-40" />
        <div className="text-center space-y-1">
          <p className="font-medium">Terminal</p>
          <p className="text-xs">Select a workspace to open the terminal.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full w-full min-h-0 overflow-hidden flex bg-console"
      data-panel="terminal"
    >
      <div className="flex-1 min-w-0 min-h-0 relative overflow-hidden">
        {sessions.map((session) =>
          session.type === 'log-viewer' ? (
            <LogViewerTab
              key={session.tabId}
              session={session}
              isActive={activeTabId === session.tabId}
              onOpenUrl={openPreviewUrl}
            />
          ) : (
            <TerminalTabContent
              key={session.tabId}
              workspaceId={workspaceId}
              tabId={session.tabId}
              sessionId={session.sessionId}
              isActive={activeTabId === session.tabId}
              shell={session.shell}
              readOnly={session.readOnly}
              isPanelVisible={isPanelVisible}
              refitSignal={panelRefitVersion}
              onSessionId={setSessionId}
              onOpenUrl={openPreviewUrl}
            />
          )
        )}
      </div>

      <div className="shrink-0 w-24 min-h-0 border-l border-border bg-secondary overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-border p-1.5">
            <div className="flex items-center gap-1">
              <select
                value={selectedShell}
                onChange={(event) =>
                  setSelectedShell(event.target.value as TerminalShellValue)
                }
                className="raised-control h-6 min-w-0 flex-1 px-1 text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title="Shell type"
              >
                {terminalShellOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleCreateTab()}
                disabled={!workspaceId}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                title="New terminal"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {sessions.map((session) => (
              <button
                key={session.tabId}
                onClick={() => handleSelectTab(session.tabId)}
                className={`flex w-full shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs transition-colors ${
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
                <span className="truncate flex-1 text-left">
                  {session.title}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => void handleCloseTab(event, session.tabId)}
                  onKeyDown={(event) => {
                    if (isTerminalTabCloseKey(event.key)) {
                      void handleCloseTab(event, session.tabId);
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
    </div>
  );
}

function TerminalTabContent({
  workspaceId,
  tabId,
  sessionId,
  isActive,
  shell,
  readOnly,
  isPanelVisible,
  refitSignal,
  onSessionId,
  onOpenUrl,
}: {
  workspaceId: string;
  tabId: string;
  sessionId: string | null;
  isActive: boolean;
  shell?: string;
  readOnly?: boolean;
  isPanelVisible: boolean;
  refitSignal: number;
  onSessionId: (tabId: string, sessionId: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  // Latch the connection: once a tab has been shown, keep its terminal
  // mounted through visibility flaps (panel toggles, layout transforms).
  // Repeated dispose/re-attach cycles drop keystrokes typed mid-transition.
  const [hasConnected, setHasConnected] = useState(false);
  useEffect(() => {
    if (isActive && isPanelVisible && !hasConnected) {
      setHasConnected(true);
    }
  }, [hasConnected, isActive, isPanelVisible]);
  const shouldConnectTerminal = hasConnected || (isActive && isPanelVisible);
  const { containerRef, error, refit } = useTauriTerminal({
    workspaceId,
    tabId,
    sessionId,
    enabled: shouldConnectTerminal,
    shell,
    readOnly,
    onSessionId: (resolvedSessionId) => onSessionId(tabId, resolvedSessionId),
    onLinkActivated: onOpenUrl,
  });

  useEffect(() => {
    if (isActive && isPanelVisible) {
      const timer = window.setTimeout(() => refit(), 50);
      return () => window.clearTimeout(timer);
    }
  }, [isActive, isPanelVisible, refit, refitSignal]);

  return (
    <div
      className={`absolute inset-0 px-2 pt-1 ${
        isActive ? 'visible' : 'invisible'
      }`}
      aria-hidden={!isActive}
      data-terminal-tab={tabId}
    >
      {shouldConnectTerminal ? (
        <>
          <div ref={containerRef} className="h-full w-full" />
          {error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              Terminal failed: {error}
            </div>
          )}
        </>
      ) : (
        <div className="h-full w-full" />
      )}
    </div>
  );
}

function LogViewerTab({
  session,
  isActive,
  onOpenUrl,
}: {
  session: TerminalSession;
  isActive: boolean;
  onOpenUrl: (url: string) => void;
}) {
  const { logs, error } = useLogStream(session.processId ?? '');
  const containerRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [logs]);

  const renderLogLine = useCallback(
    (content: string) => {
      const parts: Array<JSX.Element | string> = [];
      const urlRegex = /(https?:\/\/[^\s]+)/gi;
      let lastIndex = 0;

      for (const match of content.matchAll(urlRegex)) {
        const matchedUrl = match[0];
        const matchIndex = match.index ?? 0;

        if (matchIndex > lastIndex) {
          parts.push(content.slice(lastIndex, matchIndex));
        }

        parts.push(
          <button
            key={`${matchedUrl}-${matchIndex}`}
            type="button"
            onClick={() => onOpenUrl(matchedUrl)}
            className="text-primary underline hover:text-primary/80"
          >
            {matchedUrl}
          </button>
        );

        lastIndex = matchIndex + matchedUrl.length;
      }

      if (lastIndex < content.length) {
        parts.push(content.slice(lastIndex));
      }

      return parts.length > 0 ? parts : content;
    },
    [onOpenUrl]
  );

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
            <span className="text-muted-foreground">
              Waiting for dev server output...
            </span>
          )}
          {logs.map((entry, index) => (
            <span
              key={index}
              className={entry.type === 'STDERR' ? 'text-destructive' : ''}
            >
              {renderLogLine(entry.content)}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default DockviewTerminalPanel;
