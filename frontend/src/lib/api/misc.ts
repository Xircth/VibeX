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

async function imageUploadPayload(file: File) {
  return {
    file_name: file.name,
    data_base64: await fileToBase64(file),
  };
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
  truncated: boolean;
}

export interface ReadFileResponse {
  content: string;
  truncated: boolean;
}

export interface DocumentPreviewResponse {
  content: string;
  format: 'text' | 'html';
  extractor: string;
}

export interface BinaryAssetResponse {
  data_base64: string;
  mime_type: string;
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
  getTree: async (
    rootPath: string,
    depth?: number
  ): Promise<FileTreeEntry[]> => {
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
    relativePath: string
  ): Promise<DirectoryChildrenResponse> => {
    return tauriInvoke<DirectoryChildrenResponse>('list_directory_children', {
      rootPath,
      relativePath,
    });
  },

  readFileWithTruncation: async (
    path: string,
    maxBytes?: number
  ): Promise<ReadFileResponse> => {
    return tauriInvoke<ReadFileResponse>('read_file_with_truncation', {
      path,
      maxBytes: maxBytes ?? null,
    });
  },

  readDocumentPreview: async (
    path: string
  ): Promise<DocumentPreviewResponse> => {
    return tauriInvoke<DocumentPreviewResponse>('read_document_preview', {
      path,
    });
  },

  readBinaryAsset: async (path: string): Promise<BinaryAssetResponse> => {
    return tauriInvoke<BinaryAssetResponse>('read_binary_asset', {
      path,
    });
  },

  trashItem: async (path: string): Promise<void> => {
    return tauriInvoke<void>('trash_item', { path });
  },

  copyItem: async (path: string): Promise<string> => {
    return tauriInvoke<string>('copy_item', { path });
  },

  moveItem: async (path: string, newPath: string): Promise<string> => {
    return tauriInvoke<string>('move_item', { path, newPath });
  },

  createDirectory: async (path: string): Promise<void> => {
    return tauriInvoke<void>('create_directory', { path });
  },

  searchText: async (
    rootPath: string,
    options: TextSearchOptions
  ): Promise<TextSearchResponse> => {
    return tauriInvoke<TextSearchResponse>('search_workspace_text', {
      rootPath,
      options,
    });
  },
};

export const desktopApi = {
  getPreviewProxyUrl: async (
    url: string,
    bridgeToken?: string | null
  ): Promise<string> => {
    return tauriInvoke<string>('get_preview_proxy_url', {
      url,
      bridgeToken: bridgeToken ?? null,
    });
  },
  revealInFileManager: async (path: string): Promise<void> => {
    return tauriInvoke<void>('reveal_in_file_manager', { path });
  },
  setProjectRailWindowVisible: async (
    visible: boolean,
    itemCount?: number
  ): Promise<void> => {
    return tauriInvoke<void>('set_project_rail_window_visible', {
      visible,
      itemCount: itemCount ?? null,
    });
  },
  syncProjectRailWindowBounds: async (itemCount?: number): Promise<void> => {
    return tauriInvoke<void>('sync_project_rail_window_bounds', {
      itemCount: itemCount ?? null,
    });
  },
  activateProjectRailTarget: async (payload: {
    projectId: string;
    route: string;
  }): Promise<void> => {
    return tauriInvoke<void>('activate_project_rail_target', { payload });
  },
  requestProjectRailProjectDialog: async (payload: {
    mode: 'create' | 'open';
  }): Promise<void> => {
    return tauriInvoke<void>('request_project_rail_project_dialog', {
      payload,
    });
  },
  isMainWindowFocused: async (): Promise<boolean> => {
    return tauriInvoke<boolean>('is_main_window_focused');
  },
  exitApp: async (): Promise<void> => {
    return tauriInvoke<void>('exit_app');
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
      payload: await imageUploadPayload(file),
    });
  },

  uploadForTask: async (taskId: string, file: File): Promise<ImageResponse> => {
    return tauriInvoke<ImageResponse>('upload_image_for_task', {
      taskId,
      payload: await imageUploadPayload(file),
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
      payload: await imageUploadPayload(file),
    });
  },

  delete: async (imageId: string): Promise<void> => {
    return tauriInvoke<void>('delete_image', { imageId });
  },

  getTaskImages: async (taskId: string): Promise<ImageResponse[]> => {
    return tauriInvoke<ImageResponse[]>('get_task_images', { taskId });
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

// --- Skills ---

export interface AgentLocalSkill {
  name: string;
  description: string | null;
  path: string;
  invocation: string;
}

export type AgentSkillScope = 'global' | 'project';

export interface AgentSkillItem {
  id: string;
  scope: AgentSkillScope;
  path: string;
  description: string | null;
  read_only: boolean;
}

export interface AgentSkillLocation {
  scope: AgentSkillScope;
  path: string;
  exists: boolean;
  read_only: boolean;
}

export interface AgentSkillsListResult {
  supported: boolean;
  locations: AgentSkillLocation[];
  skills: AgentSkillItem[];
}

export interface AgentSkillContent {
  skill: AgentSkillItem;
  content: string;
}

export const skillsApi = {
  listLocal: (agentType: string): Promise<AgentLocalSkill[]> =>
    tauriInvoke<AgentLocalSkill[]>('list_local_agent_skills', { agentType }),
  // Per-agent skills CRUD (global / project scope), backed by each agent's
  // own skill directories; writes are scoped to a writable directory.
  list: (
    agentType: string,
    workspacePath?: string | null
  ): Promise<AgentSkillsListResult> =>
    tauriInvoke<AgentSkillsListResult>('list_agent_skills', {
      agentType,
      workspacePath: workspacePath ?? null,
    }),
  read: (params: {
    agentType: string;
    scope: AgentSkillScope;
    skillId: string;
    workspacePath?: string | null;
  }): Promise<AgentSkillContent> =>
    tauriInvoke<AgentSkillContent>('read_agent_skill', {
      agentType: params.agentType,
      scope: params.scope,
      skillId: params.skillId,
      workspacePath: params.workspacePath ?? null,
    }),
  save: (params: {
    agentType: string;
    scope: AgentSkillScope;
    skillId: string;
    content: string;
    workspacePath?: string | null;
  }): Promise<AgentSkillItem> =>
    tauriInvoke<AgentSkillItem>('save_agent_skill', {
      agentType: params.agentType,
      scope: params.scope,
      skillId: params.skillId,
      content: params.content,
      workspacePath: params.workspacePath ?? null,
    }),
  delete: (params: {
    agentType: string;
    scope: AgentSkillScope;
    skillId: string;
    workspacePath?: string | null;
  }): Promise<void> =>
    tauriInvoke<void>('delete_agent_skill', {
      agentType: params.agentType,
      scope: params.scope,
      skillId: params.skillId,
      workspacePath: params.workspacePath ?? null,
    }),
};
