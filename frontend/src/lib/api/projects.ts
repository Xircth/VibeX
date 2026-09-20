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

import { desktopShellCall } from '@/lib/desktopShell';

import { backendCall } from './base';

export type HostCreateProject = {
  name: string;
  repositories?: CreateProjectRepo[];
  rootPath?: string;
  parentProjectId?: string | null;
  init?: {
    parentPath: string;
    folderName: string;
    templates?: {
      readme?: string;
      gitignore?: string;
      license?: string;
    };
  };
};

export type ProjectImportPreview = {
  path: string;
  is_git: boolean;
  children: Array<{
    name: string;
    path: string;
    existing_project_id: string | null;
  }>;
};

// Project Management APIs
export const projectsApi = {
  getAll: async (): Promise<Project[]> => {
    return backendCall<Project[]>('get_projects');
  },

  create: async (data: HostCreateProject | CreateProject): Promise<Project> => {
    return backendCall<Project>('create_project', { payload: data });
  },

  update: async (id: string, data: UpdateProject): Promise<Project> => {
    return backendCall<Project>('update_project', { id, payload: data });
  },

  delete: async (id: string): Promise<void> => {
    return backendCall<void>('hide_project', { id });
  },

  hide: async (id: string): Promise<Project> => {
    return backendCall<Project>('hide_project', { id });
  },

  previewImport: async (path: string): Promise<ProjectImportPreview> => {
    return backendCall<ProjectImportPreview>('preview_project_import', { path });
  },

  setParent: async (
    id: string,
    parentProjectId: string | null
  ): Promise<Project> => {
    return backendCall<Project>('set_project_parent', {
      id,
      parentProjectId,
    });
  },

  initGit: async (id: string): Promise<Project> => {
    return backendCall<Project>('init_project_git', { id });
  },

  gitChildren: async (projectId: string): Promise<Project[]> => {
    return backendCall<Project[]>('get_project_git_children', { id: projectId });
  },

  openEditor: async (
    id: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return desktopShellCall<OpenEditorResponse>('open_project_in_editor', {
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
