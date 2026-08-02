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

import { backendCall } from './base';

// Project Management APIs
export const projectsApi = {
  getAll: async (): Promise<Project[]> => {
    return backendCall<Project[]>('get_projects');
  },

  create: async (data: CreateProject): Promise<Project> => {
    return backendCall<Project>('create_project', { payload: data });
  },

  update: async (id: string, data: UpdateProject): Promise<Project> => {
    return backendCall<Project>('update_project', { id, payload: data });
  },

  delete: async (id: string): Promise<void> => {
    return backendCall<void>('delete_project', { id });
  },

  openEditor: async (
    id: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return backendCall<OpenEditorResponse>('open_project_in_editor', {
      id,
      payload: data,
    });
  },

  searchFiles: async (
    id: string,
    query: string,
    mode?: SearchMode
  ): Promise<SearchResult[]> => {
    return backendCall<SearchResult[]>('search_project_files', {
      id,
      q: query,
      mode: mode ?? null,
    });
  },

  getRepositories: async (projectId: string): Promise<Repo[]> => {
    return backendCall<Repo[]>('get_project_repositories', { id: projectId });
  },

  addRepository: async (
    projectId: string,
    data: CreateProjectRepo
  ): Promise<Repo> => {
    return backendCall<Repo>('add_project_repository', {
      id: projectId,
      payload: data,
    });
  },

  deleteRepository: async (
    projectId: string,
    repoId: string
  ): Promise<void> => {
    return backendCall<void>('delete_project_repository', {
      projectId,
      repoId,
    });
  },
};
