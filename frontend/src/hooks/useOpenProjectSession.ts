import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { paths } from '@/lib/paths';
import { isIdeRouteForProjectPathname } from '@/lib/projectFocusRouting';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

export interface ProjectSessionTarget {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

/**
 * Open a project session from an out-of-window entry point (desktop
 * notification card, attention inbox). The session is revealed on whatever
 * surface is currently in view rather than force-switching the app into the
 * workspace tab:
 *
 * - When the IDE layout for the target project is already mounted (the app is
 *   on an IDE route for that project), this only records the focus request.
 *   The mounted `PendingProjectFocusBridge` consumes it and reveals the session
 *   in place: workspace execution area, kanban execution area, or kanban
 *   infinite-canvas card (and does nothing extra when it is already shown).
 * - Otherwise it navigates to the project's neutral home route so the bridge
 *   mounts; the tab shown there is the project's own persisted snapshot.
 *
 * The main window is always brought to the foreground by the caller (Rust
 * `activate_desktop_toast`).
 */
export function useOpenProjectSession() {
  const navigate = useNavigate();
  const location = useLocation();
  // Read the current pathname from a ref so the returned callback stays stable
  // while still observing the latest route when it fires.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const requestProjectFocus = useWindowProjectsStore(
    (state) => state.requestProjectFocus
  );
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );

  return useCallback(
    ({ projectId, workspaceId, sessionId }: ProjectSessionTarget) => {
      setRailVisible(true);
      ensureProjectOpen(projectId);
      requestProjectFocus(projectId, {
        workspaceId,
        sessionId,
        requestedAt: Date.now(),
      });

      // Reveal in place when the IDE layout for this project is already
      // mounted (it owns the bridge that performs the reveal). Otherwise land
      // on the project's neutral home route so the bridge mounts.
      if (!isIdeRouteForProjectPathname(pathnameRef.current, projectId)) {
        navigate(paths.projectSessions(projectId));
      }
    },
    [ensureProjectOpen, navigate, requestProjectFocus, setRailVisible]
  );
}
