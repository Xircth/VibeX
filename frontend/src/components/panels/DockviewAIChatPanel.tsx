import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { MessageSquare } from 'lucide-react';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { sessionListAgentKey } from '@/components/kanban/session-hub/utils';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { sessionListTitle } from '@/components/workspace-session-list/workspaceSessionListModel';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useOptionalProject } from '@/contexts/ProjectContext';
import { useRightPanelSlot } from '@/contexts/RightPanelSlotContext';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import { useKanbanProjectSessions } from '@/hooks/useKanbanProjectSessions';
import { PANEL_IDS } from '@/stores/useLayoutStore';

export interface SessionTabPanelParams {
  sessionId?: string;
  workspaceId?: string;
  title?: string | null;
  agentId?: string | null;
}

function WorkspaceSessionTabContent({
  sessionId,
  workspaceId,
  panelApi,
}: {
  sessionId: string;
  workspaceId: string;
  panelApi: IDockviewPanelProps['api'];
}) {
  const projectContext = useOptionalProject();
  const projectId = projectContext?.projectId;
  const isGitProject = Boolean(projectContext?.project?.is_git);
  const kanbanSession = useOptionalKanbanSessionContext();
  const worktree = useOptionalWorktree();
  const { openSessionTab, openOrFocusPanel } = usePanelActionsContext();
  const { sessions } = useKanbanProjectSessions(projectId);
  const matchingSession = useMemo(
    () => sessions.find((item) => item.id === sessionId) ?? null,
    [sessionId, sessions]
  );

  useEffect(() => {
    if (!matchingSession) return;
    const nextTitle = sessionListTitle(matchingSession);
    if (nextTitle && panelApi.title !== nextTitle) {
      panelApi.setTitle(nextTitle);
    }
    const nextAgentId = sessionListAgentKey(matchingSession);
    const currentParams =
      (panelApi.getParameters?.() as SessionTabPanelParams | undefined) ?? {};
    if (nextAgentId && currentParams.agentId !== nextAgentId) {
      panelApi.updateParameters({
        ...currentParams,
        sessionId,
        workspaceId,
        agentId: nextAgentId,
      });
    }
  }, [matchingSession, panelApi, sessionId, workspaceId]);

  useEffect(() => {
    const syncActiveSession = () => {
      kanbanSession?.activateExecutionSession({ sessionId, workspaceId });
      if (worktree && worktree.activeWorktreeId !== workspaceId) {
        worktree.setActiveWorktree(
          workspaceId,
          matchingSession?.taskId ?? null
        );
      }
    };

    if (panelApi.isActive) {
      syncActiveSession();
    }

    const disposable = panelApi.onDidActiveChange((event) => {
      if (event.isActive) {
        syncActiveSession();
      }
    });
    return () => disposable.dispose();
  }, [
    kanbanSession,
    matchingSession?.taskId,
    panelApi,
    sessionId,
    workspaceId,
    worktree,
  ]);

  const handleSessionCreated = useCallback(
    (next: { sessionId: string; workspaceId: string }) => {
      openSessionTab({
        sessionId: next.sessionId,
        workspaceId: next.workspaceId,
        targetGroupId: panelApi.group?.id ?? null,
      });
    },
    [openSessionTab, panelApi.group?.id]
  );

  const handleSessionSelected = useCallback(
    (next: { sessionId: string; workspaceId: string }) => {
      openSessionTab({
        sessionId: next.sessionId,
        workspaceId: next.workspaceId,
        targetGroupId: panelApi.group?.id ?? null,
      });
    },
    [openSessionTab, panelApi.group?.id]
  );

  const handleCreateSessionRequested = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.AI_CHAT, 'AI Chat');
  }, [openOrFocusPanel]);

  return (
    <div
      className="workspace-right-panel h-full w-full min-w-0 flex flex-col overflow-hidden"
      data-panel="ai-chat"
      data-session-id={sessionId}
    >
      {isGitProject ? <BranchInfoHeader workspaceId={workspaceId} /> : null}
      <div className="right-panel-conversation-region relative flex-1 min-h-0 overflow-hidden">
        <KanbanSessionConversationView
          workspaceId={workspaceId}
          sessionId={sessionId}
          embedded
          interactive
          markViewed
          showSessionSelector={false}
          onSessionCreated={handleSessionCreated}
          onSessionSelected={handleSessionSelected}
          onCreateSessionRequested={handleCreateSessionRequested}
          className="h-full"
          imagePreviewPresentation="workspace-tab"
          conversationWidthMode="workspace"
        />
      </div>
    </div>
  );
}

/**
 * DockviewAIChatPanel - dockview host for the session (C zone) on the
 * workspace page.
 *
 * When bound to a specific `sessionId` and `workspaceId` via panel parameters,
 * renders that session's conversation tab directly so multiple session tabs can
 * live in Zone C (or be split/dragged across A/B/C). Otherwise, hosts the
 * shared `RightPanelSlotContext` element for new-session creation and fallback
 * state.
 */
function DockviewAIChatPanel(
  props: IDockviewPanelProps<SessionTabPanelParams>
) {
  const { host, placement } = useRightPanelSlot();
  const containerRef = useRef<HTMLDivElement>(null);
  const boundSessionId = props.params?.sessionId;
  const boundWorkspaceId = props.params?.workspaceId;

  useLayoutEffect(() => {
    if (boundSessionId && boundWorkspaceId) return;
    if (!host || placement !== 'workspace') return;

    const container = containerRef.current;
    if (!container) return;

    container.appendChild(host);
    return () => {
      if (host.parentElement === container) {
        container.removeChild(host);
      }
    };
  }, [boundSessionId, boundWorkspaceId, host, placement]);

  if (boundSessionId && boundWorkspaceId) {
    return (
      <WorkspaceSessionTabContent
        sessionId={boundSessionId}
        workspaceId={boundWorkspaceId}
        panelApi={props.api}
      />
    );
  }

  if (!host) {
    return (
      <div className="h-full w-full overflow-auto p-4" data-panel="ai-chat">
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
          <MessageSquare className="h-8 w-8 opacity-40" />
          <div className="text-center space-y-1">
            <p className="font-medium">AI Chat</p>
            <p className="text-xs">
              AI Chat is available in the fixed right panel
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="workspace-right-panel h-full w-full min-w-0 overflow-hidden"
      data-panel="ai-chat"
    />
  );
}

export default DockviewAIChatPanel;
