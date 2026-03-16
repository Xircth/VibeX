import type {
  CreateProject,
  OpenEditorRequest,
  OpenEditorResponse,
  Project,
  Repo,
  CreateProjectRepo,
  SearchMode,
  SearchResult,
  UpdateProject,
} from 'shared/types';

import { tauriInvoke } from './base';

// Project Management APIs
export const projectsApi = {
  getAll: async (): Promise<Project[]> => {
    return tauriInvoke<Project[]>('get_projects');
  },

  create: async (data: CreateProject): Promise<Project> => {
    return tauriInvoke<Project>('create_project', { payload: data });
  },

  update: async (id: string, data: UpdateProject): Promise<Project> => {
    return tauriInvoke<Project>('update_project', { id, payload: data });
  },

  delete: async (id: string): Promise<void> => {
    return tauriInvoke<void>('delete_project', { id });
  },

  openEditor: async (
    id: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return tauriInvoke<OpenEditorResponse>('open_project_in_editor', {
      id,
      payload: data,
    });
  },

  searchFiles: async (
    id: string,
    query: string,
    mode?: SearchMode
  ): Promise<SearchResult[]> => {
    return tauriInvoke<SearchResult[]>('search_project_files', {
      id,
      q: query,
      mode: mode ?? null,
    });
  },

  getRepositories: async (projectId: string): Promise<Repo[]> => {
    return tauriInvoke<Repo[]>('get_project_repositories', { id: projectId });
  },

  addRepository: async (
    projectId: string,
    data: CreateProjectRepo
  ): Promise<Repo> => {
    return tauriInvoke<Repo>('add_project_repository', {
      id: projectId,
      payload: data,
    });
  },

  deleteRepository: async (
    projectId: string,
    repoId: string
  ): Promise<void> => {
    return tauriInvoke<void>('delete_project_repository', {
      projectId,
      repoId,
    });
  },
};
