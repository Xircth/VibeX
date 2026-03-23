import {
  createContext,
  useContext,
  ReactNode,
  useMemo,
  useEffect,
} from 'react';
import { useLocation } from 'react-router-dom';
import type { Project } from 'shared/types';
import { useProjects } from '@/hooks/useProjects';
import { APP_NAME } from '@/lib/branding';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { getProjectScopeKey } from '@/lib/projectScope';

interface ProjectContextValue {
  projectId: string | undefined;
  project: Project | undefined;
  isLoading: boolean;
  error: Error | null;
  isError: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

interface ProjectProviderProps {
  children: ReactNode;
}

export function ProjectProvider({ children }: ProjectProviderProps) {
  const location = useLocation();
  const setCurrentLayoutProject = useLayoutStore(
    (state) => state.setCurrentProject
  );

  // Extract projectId from current route path
  const projectId = useMemo(() => {
    const match = location.pathname.match(/^\/local-projects\/([^/]+)/);
    return match ? match[1] : undefined;
  }, [location.pathname]);

  const { projectsById, isLoading, error } = useProjects();
  const project = projectId ? projectsById[projectId] : undefined;

  const value = useMemo(
    () => ({
      projectId,
      project,
      isLoading,
      error,
      isError: !!error,
    }),
    [projectId, project, isLoading, error]
  );

  // Centralized page title management
  useEffect(() => {
    if (project) {
      document.title = `${project.name} | ${APP_NAME}`;
    } else {
      document.title = APP_NAME;
    }
  }, [project]);

  useEffect(() => {
    setCurrentLayoutProject(getProjectScopeKey(projectId));
  }, [projectId, setCurrentLayoutProject]);

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
}
