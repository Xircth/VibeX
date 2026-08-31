import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
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
import { useAgentCommandOutputStore } from '@/stores/useAgentCommandOutputStore';
import { useUserSystem } from '@/components/ConfigProvider';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { backendCall } from '@/lib/backendTransport';
import {
  getDefaultTerminalShell,
  getPlatformDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
  isExternalTerminalShell,
  type TerminalShellValue,
} from '@/lib/terminalPreferences';
import { isTerminalTabCloseKey } from './terminalTabClosePolicy';
import {
  clampTerminalListPaneWidth,
  isEditorTerminalPanelId,
  TERMINAL_LIST_PANE_MAX_WIDTH,
  TERMINAL_LIST_PANE_MIN_WIDTH,
  isWorkspacePanelTerminal,
  lastTerminalCloseHidesPanel,
  persistTerminalListPaneWidth,
  readStoredTerminalListPaneWidth,
  reduceTerminalBusy,
  shouldCreateInitialTerminal,
  tabIdFromEditorTerminalPanelId,
} from '@/lib/workspaceTerminalTabs';
import type { TerminalPanelParams } from '@/types/panels';

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
  const editorShell = isExternalTerminalShell(defaultShell)
    ? getPlatformDefaultTerminalShell()
    : defaultShell;
  const terminalShellOptions = getTerminalShellOptions();
  const { setOverrideUrl } = usePreviewSettings(workspaceId);
  const panelParams = (props.params ?? {}) as Partial<TerminalPanelParams>;
  const editorTabId =
    panelParams.tabId ?? tabIdFromEditorTerminalPanelId(props.api.id);
  const isEditorSurface =
    panelParams.surface === 'editor' || isEditorTerminalPanelId(props.api.id);

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
  const setBusy = useTerminalStore((state) => state.setBusy);

  const sessions = useMemo(() => {
    const allSessions = workspaceId
      ? sessionsByWorkspace[workspaceId] || []
      : [];
    if (isEditorSurface) {
      return allSessions.filter((session) => session.tabId === editorTabId);
    }
    return allSessions.filter(isWorkspacePanelTerminal);
  }, [editorTabId, isEditorSurface, sessionsByWorkspace, workspaceId]);

  const activeTabId = isEditorSurface
    ? (editorTabId ?? null)
    : workspaceId
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

  const [selectedShell, setSelectedShell] =
    useState<TerminalShellValue>(defaultShell);
  const [panelRefitVersion, setPanelRefitVersion] = useState(0);
  const [listPaneWidth, setListPaneWidth] = useState(
    readStoredTerminalListPaneWidth
  );
  const [isResizingList, setIsResizingList] = useState(false);
  const panelRootRef = useRef<HTMLDivElement>(null);
  const resizingListRef = useRef(false);
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
    persistTerminalListPaneWidth(listPaneWidth);
  }, [listPaneWidth]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    if (isEditorSurface) {
      if (!editorTabId) {
        return;
      }
      const currentSessions =
        useTerminalStore.getState().sessionsByWorkspace[workspaceId] || [];
      if (currentSessions.some((session) => session.tabId === editorTabId)) {
        return;
      }
      addSession(workspaceId, editorTabId, editorShell, {
        surface: 'editor',
      });
      return;
    }

    const currentSessions = (
      useTerminalStore.getState().sessionsByWorkspace[workspaceId] || []
    ).filter(isWorkspacePanelTerminal);
    if (
      !shouldCreateInitialTerminal({
        panelVisible: isPanelVisible,
        sessionCount: currentSessions.length,
        isExternalShell: isExternalTerminalShell(defaultShell),
      })
    ) {
      return;
    }

    addSession(workspaceId, generateTerminalTabId(), defaultShell, {
      surface: 'panel',
    });
  }, [
    addSession,
    defaultShell,
    editorShell,
    editorTabId,
    isEditorSurface,
    isPanelVisible,
    workspaceId,
  ]);

  useEffect(() => {
    if (isEditorSurface || !workspaceId || sessions.length === 0) {
      return;
    }

    if (
      activeTabId &&
      sessions.some((session) => session.tabId === activeTabId)
    ) {
      return;
    }

    setActiveTab(workspaceId, sessions[0].tabId);
  }, [activeTabId, isEditorSurface, sessions, setActiveTab, workspaceId]);

  useEffect(() => {
    if (!isEditorSurface) {
      return;
    }
    const title = sessions[0]?.title;
    if (title && props.api.title !== title) {
      props.api.setTitle(title);
    }
  }, [isEditorSurface, props.api, sessions]);

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
      const remaining = (
        useTerminalStore.getState().sessionsByWorkspace[workspaceId] || []
      ).filter(isWorkspacePanelTerminal);
      if (lastTerminalCloseHidesPanel(remaining.length)) {
        try {
          props.api.group.api.setVisible(false);
        } catch {
          // The group may already be tearing down with the last tab.
        }
      }
    },
    [workspaceId, sessions, removeSession, props.api]
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
    addSession(workspaceId, tabId, selectedShell, { surface: 'panel' });
  }, [addSession, selectedShell, workspaceId, t]);

  const resizeListFromClientX = useCallback((clientX: number) => {
    const bounds = panelRootRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) {
      return;
    }
    setListPaneWidth(
      clampTerminalListPaneWidth(bounds.right - clientX, bounds.width)
    );
  }, []);

  const beginListResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizingListRef.current = true;
      setIsResizingList(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      resizeListFromClientX(event.clientX);
    },
    [resizeListFromClientX]
  );

  const continueListResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizingListRef.current) {
        return;
      }
      resizeListFromClientX(event.clientX);
    },
    [resizeListFromClientX]
  );

  const finishListResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizingListRef.current = false;
      setIsResizingList(false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setPanelRefitVersion((value) => value + 1);
    },
    []
  );

  const resizeListFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let next = listPaneWidth;
      if (event.key === 'ArrowLeft') next += 8;
      else if (event.key === 'ArrowRight') next -= 8;
      else if (event.key === 'Home') next = TERMINAL_LIST_PANE_MIN_WIDTH;
      else if (event.key === 'End') next = TERMINAL_LIST_PANE_MAX_WIDTH;
      else return;
      event.preventDefault();
      const bounds = panelRootRef.current?.getBoundingClientRect();
      setListPaneWidth(
        clampTerminalListPaneWidth(
          next,
          bounds?.width ?? Number.POSITIVE_INFINITY
        )
      );
      setPanelRefitVersion((value) => value + 1);
    },
    [listPaneWidth]
  );

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
      ref={panelRootRef}
      className={`h-full w-full min-h-0 overflow-hidden flex bg-console${
        isResizingList ? ' is-resizing-terminal-list' : ''
      }`}
      data-panel="terminal"
      data-terminal-surface={isEditorSurface ? 'editor' : 'panel'}
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
          ) : session.type === 'agent-command' ? (
            <AgentCommandTab
              key={session.tabId}
              session={session}
              isActive={activeTabId === session.tabId}
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
              refitSignal={panelRefitVersion + listPaneWidth}
              onSessionId={setSessionId}
              onOpenUrl={openPreviewUrl}
              onBusyChange={(busy) => setBusy(session.tabId, busy)}
            />
          )
        )}
      </div>

      {isEditorSurface ? null : (
        <>
          <div
            className="terminal-list-resizer"
            role="separator"
            tabIndex={0}
            aria-label={t('terminalPanel.resizeListAria')}
            aria-orientation="vertical"
            aria-valuemin={TERMINAL_LIST_PANE_MIN_WIDTH}
            aria-valuemax={TERMINAL_LIST_PANE_MAX_WIDTH}
            aria-valuenow={listPaneWidth}
            aria-valuetext={t('terminalPanel.resizeListValue', {
              width: listPaneWidth,
            })}
            onPointerDown={beginListResize}
            onPointerMove={continueListResize}
            onPointerUp={finishListResize}
            onPointerCancel={finishListResize}
            onLostPointerCapture={() => {
              resizingListRef.current = false;
              setIsResizingList(false);
            }}
            onKeyDown={resizeListFromKeyboard}
          />
          <div
            className="shrink-0 min-h-0 bg-secondary overflow-hidden"
            style={{ width: listPaneWidth }}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-border p-1.5">
                <div className="flex items-center gap-1">
                  <select
                    value={selectedShell}
                    onChange={(event) =>
                      setSelectedShell(event.target.value as TerminalShellValue)
                    }
                    className="raised-control h-6 min-w-0 flex-1 px-1 text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
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
                    className="raised-control flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-50"
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
                    {session.busy ? (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        data-terminal-busy=""
                      />
                    ) : null}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(event) =>
                        void handleCloseTab(event, session.tabId)
                      }
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
        </>
      )}
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
  onBusyChange,
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
  onBusyChange: (busy: boolean) => void;
}) {
  // Latch the connection: once a tab has been shown, keep its terminal
  // mounted through visibility flaps (panel toggles, layout transforms).
  // Repeated dispose/re-attach cycles drop keystrokes typed mid-transition.
  const busyRef = useRef(false);
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
    onIo: (event) => {
      busyRef.current = reduceTerminalBusy(busyRef.current, event);
      onBusyChange(busyRef.current);
    },
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

function AgentCommandTab({
  session,
  isActive,
}: {
  session: TerminalSession;
  isActive: boolean;
}) {
  const output = useAgentCommandOutputStore((state) =>
    session.sessionId ? (state.outputByTool[session.sessionId] ?? '') : ''
  );
  const containerRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [output]);

  return (
    <div
      className={`absolute inset-0 ${isActive ? 'visible' : 'invisible'}`}
      data-terminal-tab={session.tabId}
    >
      <pre
        ref={containerRef}
        className="h-full w-full overflow-auto bg-console p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words"
      >
        {output || session.title}
      </pre>
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
