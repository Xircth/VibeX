import { useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsApi, type HostCreateProject } from '@/lib/api';
import type { UpdateProject, Project } from 'shared/types';

interface UseProjectMutationsOptions {
  onCreateSuccess?: (project: Project) => void;
  onCreateError?: (err: unknown) => void;
  onUpdateSuccess?: (project: Project) => void;
  onUpdateError?: (err: unknown) => void;
}

export function useProjectMutations(options?: UseProjectMutationsOptions) {
  const queryClient = useQueryClient();

  const createProject = useMutation({
    mutationKey: ['createProject'],
    mutationFn: (data: HostCreateProject) => projectsApi.create(data),
    onSuccess: (project: Project) => {
      queryClient.setQueryData(['project', project.id], project);
      queryClient.setQueriesData<Project[]>(
        { queryKey: ['projects'] },
        (old) => {
          if (!Array.isArray(old)) return old;
          if (old.some((p) => p.id === project.id)) {
            return old.map((p) => (p.id === project.id ? project : p));
          }
          return [project, ...old];
        }
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      options?.onCreateSuccess?.(project);
    },
    onError: (err) => {
      console.error('Failed to create project:', err);
      options?.onCreateError?.(err);
    },
  });

  const updateProject = useMutation({
    mutationKey: ['updateProject'],
    mutationFn: ({
      projectId,
      data,
    }: {
      projectId: string;
      data: UpdateProject;
    }) => projectsApi.update(projectId, data),
    onSuccess: (project: Project) => {
      // Update single project cache
      queryClient.setQueryData(['project', project.id], project);

      // Update the project across all environment-scoped projects list caches
      queryClient.setQueriesData<Project[]>(
        { queryKey: ['projects'] },
        (old) => {
          if (!Array.isArray(old)) return old;
          return old.map((p) => (p.id === project.id ? project : p));
        }
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });

      options?.onUpdateSuccess?.(project);
    },
    onError: (err) => {
      console.error('Failed to update project:', err);
      options?.onUpdateError?.(err);
    },
  });

  return {
    createProject,
    updateProject,
  };
}
