import { lazy, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { MainLegacyScope } from '@/app/MainLegacyScope';
import { IDEWorkspaceRoute } from '@/components/layout/IDEWorkspaceRoute';
import { NormalLayout } from '@/components/layout/NormalLayout';
import {
  normalizeMainWindowRoute,
  paths,
  projectRoutePatterns,
} from '@/lib/paths';

function lazyNamed<
  T extends Record<Name, ComponentType>,
  Name extends keyof T & string,
>(load: () => Promise<T>, name: Name) {
  return lazy(() => load().then((mod) => ({ default: mod[name] })));
}

const ProjectTasks = lazyNamed(
  () => import('@/pages/ProjectTasks'),
  'ProjectTasks'
);
const FullAttemptLogsPage = lazyNamed(
  () => import('@/pages/FullAttemptLogs'),
  'FullAttemptLogsPage'
);
const WorkflowInspector = lazyNamed(
  () => import('@/pages/workflows/WorkflowInspector'),
  'WorkflowInspector'
);

function UnknownMainRoute() {
  const { pathname, search, hash } = useLocation();
  const target = normalizeMainWindowRoute(`${pathname}${search}${hash}`);
  return <Navigate to={target ?? paths.projects()} replace />;
}

export function MainAppRoutes() {
  return (
    <Routes>
      <Route
        path={projectRoutePatterns.full}
        element={
          <MainLegacyScope>
            <FullAttemptLogsPage />
          </MainLegacyScope>
        }
      />

      <Route
        element={
          <MainLegacyScope pageSuspense={false}>
            <IDEWorkspaceRoute />
          </MainLegacyScope>
        }
      >
        <Route path="/" element={null} />
        <Route path="/local-projects" element={null} />
        <Route path={projectRoutePatterns.project} element={null} />
        <Route
          path={projectRoutePatterns.sessions}
          element={<ProjectTasks />}
        />
        <Route
          path={projectRoutePatterns.workspace}
          element={<ProjectTasks />}
        />
        <Route path={projectRoutePatterns.session} element={<ProjectTasks />} />
      </Route>

      <Route
        element={
          <MainLegacyScope>
            <NormalLayout />
          </MainLegacyScope>
        }
      >
        <Route path="/workflows/:runId" element={<WorkflowInspector />} />
      </Route>

      <Route
        path="/mcp-servers"
        element={<Navigate to="/settings/mcp" replace />}
      />
      <Route
        path="/workspaces/*"
        element={<Navigate to="/local-projects" replace />}
      />
      <Route
        path="/projects/*"
        element={<Navigate to="/local-projects" replace />}
      />
      <Route path="*" element={<UnknownMainRoute />} />
    </Routes>
  );
}
