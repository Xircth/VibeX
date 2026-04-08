import type {
  ApprovalStatus,
  ApprovalResponse,
  DirectoryListResponse,
  DirectoryEntry,
  ExecutionProcess,
  ExecutionProcessRepoState,
  ImageResponse,
  SearchMode,
  SearchResult,
  Scratch,
  ScratchType,
  CreateScratch,
  UpdateScratch,
  CreateTag,
  Tag,
  TagSearchParams,
  UpdateTag,
} from 'shared/types';

import { tauriInvoke } from './base';

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

// Execution Process APIs
export const executionProcessesApi = {
  getDetails: async (processId: string): Promise<ExecutionProcess> => {
    return tauriInvoke<ExecutionProcess>('get_execution_process', {
      id: processId,
    });
  },

  getRepoStates: async (
    processId: string
  ): Promise<ExecutionProcessRepoState[]> => {
    return tauriInvoke<ExecutionProcessRepoState[]>(
      'get_execution_process_repo_states',
      { id: processId }
    );
  },

  stopExecutionProcess: async (processId: string): Promise<void> => {
    return tauriInvoke<void>('stop_execution_process', { id: processId });
  },
};

// File Tree APIs
export interface FileTreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileTreeEntry[] | null;
  git_status: string | null;
}

export interface DirectoryChildrenResponse {
  files: string[];
  directories: string[];
  gitignored_files: string[];
  gitignored_directories: string[];
}

export interface ReadFileResponse {
  content: string;
  truncated: boolean;
}

export interface TextSearchMatch {
  line: number;
  column: number;
  end_column: number;
  preview: string;
}

export interface TextSearchFileResult {
  path: string;
  match_count: number;
  matches: TextSearchMatch[];
}

export interface TextSearchResponse {
  files: TextSearchFileResult[];
  file_count: number;
  total_matches: number;
  truncated: boolean;
}

export interface TextSearchOptions {
  query: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  include_pattern?: string;
  exclude_pattern?: string;
}

export const fileTreeApi = {
  getTree: async (rootPath: string, depth?: number): Promise<FileTreeEntry[]> => {
    return tauriInvoke<FileTreeEntry[]>('get_file_tree', {
      rootPath,
      depth: depth ?? null,
    });
  },

  readFile: async (path: string): Promise<string> => {
    return tauriInvoke<string>('read_file_content', { path });
  },

  saveFile: async (path: string, content: string): Promise<void> => {
    return tauriInvoke<void>('save_file_content', { path, content });
  },

  deleteFile: async (path: string): Promise<void> => {
    return tauriInvoke<void>('delete_file', { path });
  },

  getFileAtHead: async (filePath: string): Promise<string> => {
    return tauriInvoke<string>('get_file_at_head', { filePath });
  },

  getClaudeSettingsPath: async (): Promise<string> => {
    return tauriInvoke<string>('get_claude_settings_path');
  },

  listDirectoryChildren: async (
    rootPath: string,
    relativePath: string,
  ): Promise<DirectoryChildrenResponse> => {
    return tauriInvoke<DirectoryChildrenResponse>('list_directory_children', {
      rootPath,
      relativePath,
    });
  },

  readFileWithTruncation: async (
    path: string,
    maxBytes?: number,
  ): Promise<ReadFileResponse> => {
    return tauriInvoke<ReadFileResponse>('read_file_with_truncation', {
      path,
      maxBytes: maxBytes ?? null,
    });
  },

  trashItem: async (path: string): Promise<void> => {
    return tauriInvoke<void>('trash_item', { path });
  },

  copyItem: async (path: string): Promise<string> => {
    return tauriInvoke<string>('copy_item', { path });
  },

  createDirectory: async (path: string): Promise<void> => {
    return tauriInvoke<void>('create_directory', { path });
  },

  searchText: async (
    rootPath: string,
    options: TextSearchOptions,
  ): Promise<TextSearchResponse> => {
    return tauriInvoke<TextSearchResponse>('search_workspace_text', {
      rootPath,
      options,
    });
  },
};

export const desktopApi = {
  toggleMainWindowDevtools: async (): Promise<boolean> => {
    return tauriInvoke<boolean>('toggle_main_window_devtools');
  },
  getPreviewProxyUrl: async (url: string): Promise<string> => {
    return tauriInvoke<string>('get_preview_proxy_url', { url });
  },
  revealInFileManager: async (path: string): Promise<void> => {
    return tauriInvoke<void>('reveal_in_file_manager', { path });
  },
};

// File System APIs
export const fileSystemApi = {
  list: async (path?: string): Promise<DirectoryListResponse> => {
    return tauriInvoke<DirectoryListResponse>('list_directory', {
      path: path ?? null,
    });
  },

  listGitRepos: async (path?: string): Promise<DirectoryEntry[]> => {
    return tauriInvoke<DirectoryEntry[]>('list_git_repos', {
      path: path ?? null,
    });
  },
};

// Task Tags APIs (all tags are global)
export const tagsApi = {
  list: async (params?: TagSearchParams): Promise<Tag[]> => {
    return tauriInvoke<Tag[]>('get_tags', {
      search: params?.search ?? null,
    });
  },

  create: async (data: CreateTag): Promise<Tag> => {
    return tauriInvoke<Tag>('create_tag', { payload: data });
  },

  update: async (tagId: string, data: UpdateTag): Promise<Tag> => {
    return tauriInvoke<Tag>('update_tag', { tagId, payload: data });
  },

  delete: async (tagId: string): Promise<void> => {
    return tauriInvoke<void>('delete_tag', { tagId });
  },
};

// Images API
export const imagesApi = {
  upload: async (file: File): Promise<ImageResponse> => {
    return tauriInvoke<ImageResponse>('upload_image', {
      payload: {
        fileName: file.name,
        dataBase64: await fileToBase64(file),
      },
    });
  },

  uploadForTask: async (
    taskId: string,
    file: File
  ): Promise<ImageResponse> => {
    return tauriInvoke<ImageResponse>('upload_image_for_task', {
      taskId,
      payload: {
        fileName: file.name,
        dataBase64: await fileToBase64(file),
      },
    });
  },

  /**
   * Upload an image for a task attempt and immediately copy it to the container.
   * Returns the image with a file_path that can be used in markdown.
   */
  uploadForAttempt: async (
    attemptId: string,
    file: File
  ): Promise<ImageResponse> => {
    return tauriInvoke<ImageResponse>('upload_image_for_workspace', {
      workspaceId: attemptId,
      payload: {
        fileName: file.name,
        dataBase64: await fileToBase64(file),
      },
    });
  },

  delete: async (imageId: string): Promise<void> => {
    return tauriInvoke<void>('delete_image', { imageId });
  },

  getTaskImages: async (taskId: string): Promise<ImageResponse[]> => {
    return tauriInvoke<ImageResponse[]>('get_task_images', { taskId });
  },

  getImageUrl: (_imageId: string): string => {
    // TODO: In Tauri, images need to be served differently (e.g., asset protocol)
    return '';
  },
};

// Approval API
export const approvalsApi = {
  respond: async (
    approvalId: string,
    payload: ApprovalResponse
  ): Promise<ApprovalStatus> => {
    return tauriInvoke<ApprovalStatus>('respond_to_approval', {
      approvalId,
      response: payload,
    });
  },
};

// Scratch API
export const scratchApi = {
  create: async (
    scratchType: ScratchType,
    id: string,
    data: CreateScratch
  ): Promise<Scratch> => {
    return tauriInvoke<Scratch>('create_scratch', {
      scratchType,
      id,
      payload: data,
    });
  },

  get: async (scratchType: ScratchType, id: string): Promise<Scratch> => {
    return tauriInvoke<Scratch>('get_scratch', {
      scratchType,
      id,
    });
  },

  update: async (
    scratchType: ScratchType,
    id: string,
    data: UpdateScratch
  ): Promise<void> => {
    await tauriInvoke<void>('update_scratch', {
      scratchType,
      id,
      payload: data,
    });
  },

  delete: async (scratchType: ScratchType, id: string): Promise<void> => {
    await tauriInvoke<void>('delete_scratch', {
      scratchType,
      id,
    });
  },
};

// Search API (multi-repo file search)
// Note: In Tauri, search_project_files handles project-level search.
// For multi-repo search, we invoke search per repo and merge results.
export const searchApi = {
  searchFiles: async (
    repoIds: string[],
    query: string,
    mode?: SearchMode
  ): Promise<SearchResult[]> => {
    // Search each repo in parallel and merge results
    const results = await Promise.all(
      repoIds.map((repoId) =>
        tauriInvoke<SearchResult[]>('search_repo', {
          repoId,
          q: query,
          mode: mode ?? null,
        })
      )
    );
    return results.flat();
  },
};

// --- Popular Skills ---

export interface PopularSkill {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  tags: string[];
  installed: boolean;
}

export const skillsApi = {
  getPopular: (): Promise<PopularSkill[]> =>
    tauriInvoke<PopularSkill[]>('get_popular_skills'),
  install: (key: string): Promise<void> =>
    tauriInvoke<void>('install_skill', { key }),
  uninstall: (key: string): Promise<void> =>
    tauriInvoke<void>('uninstall_skill', { key }),
  ensureAimaxInstalled: (): Promise<boolean> =>
    tauriInvoke<boolean>('ensure_aimax_installed'),
};
