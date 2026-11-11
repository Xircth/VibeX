import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useProject } from '@/contexts/ProjectContext';
import { WorktreeProvider } from '@/contexts/WorktreeContext';
import {
  KanbanSessionProvider,
  useKanbanSessionContext,
} from '@/contexts/KanbanSessionContext';
import { PanelActionsProvider } from '@/contexts/PanelActionsContext';
import { TerminalProvider } from '@/contexts/TerminalContext';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import { IDELayout } from '@/components/layout/IDELayout';
import { pickDefaultProjectTarget } from '@/components/layout/projectRailProjects';
import { KanbanSessionConversationPlacementProvider } from '@/components/kanban/KanbanSessionConversationView';
import { useOptionalBasicGuide } from '@/features/basic-guide/BasicGuideContext';
import { useProjects } from '@/hooks/useProjects';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { attemptsApi } from '@/lib/api';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { normalizeProjectRoute, paths } from '@/lib/paths';
import {
  resolveFocusDispatch,
  type FocusSurface,
} from '@/lib/projectFocusRouting';
import { requestCanvasReveal } from '@/lib/canvasSessionReveal';

interface WorkspaceLayoutProps {
  /** Content for the right fixed panel (AI Chat area) */
  rightPanelContent?: ReactNode;
  /** Content for the toolbar area */
  toolbarContent?: ReactNode;
}

function WorkspaceProjectEntryGuard() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  const { projectId: contextProjectId, isError: isProjectError } = useProject();
  const {
    projects,
    isLoading: isProjectsLoading,
    error: projectsError,
  } = useProjects();
  const basicGuide = useOptionalBasicGuide();

  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const lastRouteByProject = useWindowProjectsStore(
    (state) => state.lastRouteByProject
  );
  const removedProjectIds = useWindowProjectsStore(
    (state) => state.removedProjectIds
  );

  const [hasStoreHydrated, setHasStoreHydrated] = useState(() =>
    useWindowProjectsStore.persist.hasHydrated()
  );

  useEffect(() => {
    if (hasStoreHydrated) {
      return;
    }
    return useWindowProjectsStore.persist.onFinishHydration(() => {
      setHasStoreHydrated(true);
    });
  }, [hasStoreHydrated]);

  const visibleProjects = useMemo(
    () => projects.filter((project) => !removedProjectIds[project.id]),
    [projects, removedProjectIds]
  );
  const visibleProjectsById = useMemo(
    () =>
      Object.fromEntries(
        visibleProjects.map((project) => [project.id, project])
      ),
    [visibleProjects]
  );

  const resolveSafeProjectRoute = useCallback(
    (targetProjectId: string) => {
      const remembered = lastRouteByProject[targetProjectId]
        ? normalizeProjectRoute(lastRouteByProject[targetProjectId])
        : null;
      const barePath = `${paths.projects()}/${targetProjectId}`;
      return remembered && remembered !== barePath
        ? remembered
        : paths.projectSessions(targetProjectId);
    },
    [lastRouteByProject]
  );

  const activeProjectId = contextProjectId ?? routeProjectId;
  const isBasicGuideStep0 =
    basicGuide?.state.phase === 'active' && basicGuide.state.reachedStep === 0;
  const normalizedPathname =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;

  useEffect(() => {
    if (!hasStoreHydrated) {
      return;
    }

    if (!activeProjectId) {
      if (isBasicGuideStep0) {
        if (normalizedPathname === '/') {
          navigate(paths.projects(), { replace: true });
        }
        return;
      }

      if (isProjectsLoading || projectsError) {
        return;
      }

      const defaultProjectId = pickDefaultProjectTarget({
        projects: visibleProjects,
        projectsById: visibleProjectsById,
        openProjectIds,
      });

      if (defaultProjectId) {
        navigate(resolveSafeProjectRoute(defaultProjectId), { replace: true });
      }
      return;
    }

    const isRemovedOrMissing =
      Boolean(removedProjectIds[activeProjectId]) ||
      (!isProjectsLoading &&
        !projectsError &&
        isProjectError &&
        !visibleProjectsById[activeProjectId]);

    if (isRemovedOrMissing) {
      const fallbackProjectId = pickDefaultProjectTarget({
        projects: visibleProjects,
        projectsById: visibleProjectsById,
        openProjectIds,
        excludeProjectId: activeProjectId,
      });
      if (fallbackProjectId) {
        navigate(resolveSafeProjectRoute(fallbackProjectId), { replace: true });
      } else {
        navigate(paths.projects(), { replace: true });
      }
      return;
    }

    const bareProjectPath = `${paths.projects()}/${activeProjectId}`;
    if (normalizedPathname === bareProjectPath) {
      navigate(resolveSafeProjectRoute(activeProjectId), { replace: true });
    }
  }, [
    activeProjectId,
    hasStoreHydrated,
    isBasicGuideStep0,
    isProjectError,
    isProjectsLoading,
    navigate,
    normalizedPathname,
    openProjectIds,
    projectsError,
    removedProjectIds,
    resolveSafeProjectRoute,
    visibleProjects,
    visibleProjectsById,
  ]);

  return null;
}

function PendingProjectFocusBridge() {
  const { projectId } = useProject();
  const navigate = useNavigate();
  const { workspaceId: routeWorkspaceId, sessionId: routeSessionId } =
    useParams();
  const { activateExecutionSession, panelView, isLayoutHydrated } =
    useKanbanSessionContext();
  const consumeProjectFocus = useWindowProjectsStore(
    (state) => state.consumeProjectFocus
  );
  const pendingProjectFocus = useWindowProjectsStore((state) =>
    projectId ? state.focusRequests[projectId] : undefined
  );
  const activeTab = useLayoutStore((state) => state.activeTab);
  const setRightPanelVisible = useLayoutStore(
    (state) => state.setRightPanelVisible
  );
  const setKanbanSessionVisible = useLayoutStore(
    (state) => state.setKanbanSessionVisible
  );
  const boardStyle = useKanbanBoardStyle();

  useEffect(() => {
    if (!projectId || !pendingProjectFocus || !isLayoutHydrated) {
      return;
    }

    const focusRequest = consumeProjectFocus(projectId);
    if (!focusRequest) {
      return;
    }

    // A deep workspace/session route forces the workspace surface (mirroring
    // IDELayout's `effectiveActiveTab`); otherwise the kanban/workspace surface
    // is whatever tab the user is on. Never switch the tab itself — the session
    // is revealed where the user already is.
    const surface: FocusSurface =
      routeWorkspaceId || routeSessionId
        ? 'workspace'
        : activeTab === 'kanban'
          ? 'kanban'
          : 'workspace';
    const isCanvasHub =
      surface === 'kanban' &&
      boardStyle === 'canvas' &&
      panelView === 'sessionHub';
    const dispatch = resolveFocusDispatch(
      { surface, isCanvasHub, routeWorkspaceId, routeSessionId },
      {
        projectId,
        workspaceId: focusRequest.workspaceId,
        sessionId: focusRequest.sessionId,
      }
    );

    switch (dispatch.kind) {
      case 'open-in-workspace':
        setRightPanelVisible(true);
        navigate(dispatch.navigateTo);
        break;
      case 'open-in-kanban-slot':
        setKanbanSessionVisible(true);
        activateExecutionSession(dispatch.placement);
        break;
      case 'reveal-on-canvas':
        requestCanvasReveal({
          projectId: dispatch.projectId,
          workspaceId: dispatch.workspaceId,
          sessionId: dispatch.sessionId,
        });
        break;
      case 'noop':
        // Already shown on the current surface — window focus alone is enough.
        break;
    }

    void attemptsApi.markSeen(focusRequest.workspaceId).catch(() => {
      // Ignore mark-seen failures for toast navigation.
    });
  }, [
    activateExecutionSession,
    activeTab,
    boardStyle,
    consumeProjectFocus,
    isLayoutHydrated,
    navigate,
    panelView,
    pendingProjectFocus,
    projectId,
    routeSessionId,
    routeWorkspaceId,
    setKanbanSessionVisible,
    setRightPanelVisible,
  ]);

  return null;
}

/**
 * WorkspaceLayout wraps IDELayout with all necessary context providers.
 * This is the top-level layout component for the IDE workspace.
 */
export function WorkspaceLayout({
  rightPanelContent,
  toolbarContent,
}: WorkspaceLayoutProps) {
  return (
    <WorktreeProvider>
      <KanbanSessionProvider>
        <WorkspaceProjectEntryGuard />
        <PendingProjectFocusBridge />
        <ReviewProvider>
          <TerminalProvider>
            <PanelActionsProvider>
              <KanbanSessionConversationPlacementProvider>
                <IDELayout
                  rightPanelContent={rightPanelContent}
                  toolbarContent={toolbarContent}
                />
              </KanbanSessionConversationPlacementProvider>
            </PanelActionsProvider>
          </TerminalProvider>
        </ReviewProvider>
      </KanbanSessionProvider>
    </WorktreeProvider>
  );
}
