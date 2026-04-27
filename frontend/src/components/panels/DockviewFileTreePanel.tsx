import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { FolderTree, FolderOpen } from 'lucide-react';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { usePanelActions } from '@/hooks/usePanelActions';
import { open } from '@tauri-apps/plugin-dialog';
import { useProject } from '@/contexts/ProjectContext';
import { useProjectRepos } from '@/hooks/useProjectRepos';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttempt } from '@/hooks/useAttempt';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { fileTreeApi } from '@/lib/api';
import type { DirectoryChildrenResponse } from '@/lib/api';
import { tauriInvoke, tauriListen } from '@/lib/tauriApi';
import { FileTreePanel } from '@/components/file-tree/FileTreePanel';
import {
  deriveWorkspaceRootPath,
  deriveWorkspaceRootPathCandidates,
} from './workspaceRootPath';

function isAbsolutePath(path: string): boolean {
  const normalizedPath = stripWindowsExtendedPathPrefix(path);
  return (
    /^[a-zA-Z]:[\\/]/.test(normalizedPath) ||
    /^[\\/]\?[\\/][a-zA-Z]:[\\/]/.test(normalizedPath) ||
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('\\\\')
  );
}

function stripWindowsExtendedPathPrefix(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/i, '')
    .replace(/^\/\?\//i, '')
    .replace(/^\\\?\\/i, '');
}

/**
 * DockviewFileTreePanel - File tree sidebar panel for browsing project files.
 *
 * Uses the mossx-style FileTreePanel with lazy-loaded directories,
 * rich file icons, git status, and file preview.
 */
function DockviewFileTreePanel(_props: IDockviewPanelProps) {
  const { rootPath, setRootPath, setSelectedFilePath, setDiffFilePath } =
    useFileTreeStore();
  const { openFilePreview } = usePanelActions();
  const { projectId } = useProject();
  const { data: repos } = useProjectRepos(projectId);

  // Active workspace context
  const { activeWorktreeId } = useWorktree();
  const { data: workspace } = useAttempt(activeWorktreeId ?? undefined);
  const { repos: workspaceRepos } = useAttemptRepo(
    activeWorktreeId ?? undefined
  );

  // Track previous workspace ID to detect workspace switches
  const prevWorktreeIdRef = useRef<string | null>(null);
  const prevProjectIdRef = useRef<string | undefined>(projectId);
  const pendingProjectRootSyncRef = useRef<string | undefined>(projectId);

  // Directory listing state
  const [files, setFiles] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [gitignoredFiles, setGitignoredFiles] = useState<Set<string>>(
    new Set()
  );
  const [gitignoredDirectories, setGitignoredDirectories] = useState<
    Set<string>
  >(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshTimerRef = useRef<number | null>(null);

  const normalizeWatchedPath = useCallback((path: string) => {
    return path.replaceAll('\\', '/').replace(/\/+$/, '');
  }, []);

  const workspaceRootCandidates = useMemo(
    () =>
      activeWorktreeId
        ? deriveWorkspaceRootPathCandidates(workspace, workspaceRepos)
        : [],
    [activeWorktreeId, workspace, workspaceRepos]
  );
  const resolvedWorkspaceRootPath = useMemo(
    () =>
      activeWorktreeId
        ? deriveWorkspaceRootPath(workspace, workspaceRepos)
        : null,
    [activeWorktreeId, workspace, workspaceRepos]
  );

  // Switch rootPath to workspace worktree path when workspace changes
  useEffect(() => {
    const workspaceBelongsToCurrentProject =
      !projectId || workspace?.project_id === projectId;

    if (activeWorktreeId) {
      if (!workspaceBelongsToCurrentProject) {
        return;
      }

      if (
        resolvedWorkspaceRootPath &&
        (activeWorktreeId !== prevWorktreeIdRef.current ||
          resolvedWorkspaceRootPath !== rootPath)
      ) {
        setRootPath(resolvedWorkspaceRootPath);
        setSelectedFilePath(null);
        setDiffFilePath(null);
        prevWorktreeIdRef.current = activeWorktreeId;
      }
    } else if (!activeWorktreeId && prevWorktreeIdRef.current !== null) {
      prevWorktreeIdRef.current = null;
      if (repos && repos.length > 0) {
        setRootPath(repos[0].path);
      }
    }
  }, [
    activeWorktreeId,
    projectId,
    resolvedWorkspaceRootPath,
    repos,
    rootPath,
    setDiffFilePath,
    setRootPath,
    setSelectedFilePath,
    workspace?.project_id,
  ]);

  useEffect(() => {
    const projectChanged = prevProjectIdRef.current !== projectId;
    if (!projectChanged) {
      return;
    }

    prevProjectIdRef.current = projectId;
    pendingProjectRootSyncRef.current = projectId;
    prevWorktreeIdRef.current = null;

    setRootPath(null);
    setSelectedFilePath(null);
    setDiffFilePath(null);
    setFiles([]);
    setDirectories([]);
    setGitignoredFiles(new Set());
    setGitignoredDirectories(new Set());
  }, [projectId, setDiffFilePath, setRootPath, setSelectedFilePath]);

  useEffect(() => {
    if (activeWorktreeId || !projectId || !repos || repos.length === 0) {
      return;
    }

    if (pendingProjectRootSyncRef.current !== projectId) {
      return;
    }

    const nextRootPath = repos[0].path;
    setRootPath(nextRootPath);
    setSelectedFilePath(null);
    setDiffFilePath(null);
    pendingProjectRootSyncRef.current = undefined;
  }, [
    activeWorktreeId,
    projectId,
    repos,
    setDiffFilePath,
    setRootPath,
    setSelectedFilePath,
  ]);

  // Auto-set rootPath from project repos when no workspace is active and no rootPath set
  useEffect(() => {
    if (!rootPath && !activeWorktreeId && repos && repos.length > 0) {
      setRootPath(repos[0].path);
    }
  }, [rootPath, activeWorktreeId, repos, setRootPath]);

  // Load root directory children
  const loadRootChildren = useCallback(async () => {
    if (!rootPath) return;
    setIsLoading(true);

    const candidatePaths = Array.from(
      new Set(
        [rootPath, ...workspaceRootCandidates].filter(
          (candidate): candidate is string => Boolean(candidate)
        )
      )
    );

    try {
      let resolvedResponse: DirectoryChildrenResponse | null = null;
      let resolvedRootPath = rootPath;

      for (const candidatePath of candidatePaths) {
        try {
          const response: DirectoryChildrenResponse =
            await fileTreeApi.listDirectoryChildren(candidatePath, '');
          const hasEntries =
            response.files.length > 0 ||
            response.directories.length > 0 ||
            response.gitignored_files.length > 0 ||
            response.gitignored_directories.length > 0;

          resolvedResponse = response;
          resolvedRootPath = candidatePath;

          if (hasEntries || candidatePath === candidatePaths.at(-1)) {
            break;
          }
        } catch {
          // Try the next candidate root before giving up.
        }
      }

      if (!resolvedResponse) {
        throw new Error('Failed to load workspace files');
      }

      if (resolvedRootPath !== rootPath) {
        setRootPath(resolvedRootPath);
      }

      setFiles(resolvedResponse.files);
      setDirectories(resolvedResponse.directories);
      setGitignoredFiles(new Set(resolvedResponse.gitignored_files));
      setGitignoredDirectories(
        new Set(resolvedResponse.gitignored_directories)
      );
    } catch {
      setFiles([]);
      setDirectories([]);
      setGitignoredFiles(new Set());
      setGitignoredDirectories(new Set());
    } finally {
      setIsLoading(false);
    }
  }, [rootPath, setRootPath, workspaceRootCandidates]);

  const refreshFileTree = useCallback(async () => {
    await loadRootChildren();
    setRefreshToken((value) => value + 1);
  }, [loadRootChildren]);

  useEffect(() => {
    void loadRootChildren();
  }, [loadRootChildren]);

  useEffect(() => {
    if (!rootPath) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const normalizedRootPath = normalizeWatchedPath(rootPath);

    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) {
        return;
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshFileTree();
      }, 120);
    };

    const handleWindowFocus = () => {
      scheduleRefresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleRefresh();
      }
    };

    void tauriInvoke('subscribe_file_tree_stream', { rootPath }).catch(
      (error) => {
        console.error('Failed to subscribe file tree stream:', error);
      }
    );

    void tauriListen<{ root_path: string }>('file-tree-stream', (payload) => {
      if (cancelled) {
        return;
      }

      if (normalizeWatchedPath(payload.root_path) !== normalizedRootPath) {
        return;
      }

      scheduleRefresh();
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        console.error('Failed to listen for file tree updates:', error);
      });

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [normalizeWatchedPath, refreshFileTree, rootPath]);

  const handleOpenFile = useCallback(
    (relativePath: string) => {
      if (!rootPath) return;
      const normalizedPath = stripWindowsExtendedPathPrefix(relativePath);
      const absolutePath = isAbsolutePath(normalizedPath)
        ? normalizedPath
        : (() => {
            const usesWindowsSeparator = rootPath.includes('\\');
            const separator = usesWindowsSeparator ? '\\' : '/';
            const base = rootPath.replace(/[\\/]+$/, '');
            const normalizedRelative = usesWindowsSeparator
              ? normalizedPath.replaceAll('/', '\\')
              : normalizedPath;
            return `${base}${separator}${normalizedRelative}`;
          })();
      setSelectedFilePath(absolutePath);
      openFilePreview(absolutePath);
    },
    [rootPath, setSelectedFilePath, openFilePreview]
  );

  const handlePickFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择项目文件夹',
      });
      if (selected && typeof selected === 'string') {
        setRootPath(selected);
      }
    } catch {
      // User cancelled
    }
  }, [setRootPath]);

  // No root path selected - show folder picker
  if (!rootPath) {
    return (
      <div
        className="h-full w-full overflow-auto bg-background p-2"
        data-panel="file-tree"
      >
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
          <FolderTree className="h-8 w-8 opacity-40" />
          <div className="text-center space-y-2">
            <p className="font-medium">文件管理器</p>
            <p className="text-xs">未选择文件夹</p>
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-accent/80 rounded transition-colors mx-auto"
              onClick={handlePickFolder}
            >
              <FolderOpen className="w-3 h-3" />
              打开文件夹
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden" data-panel="file-tree">
      <FileTreePanel
        workspacePath={rootPath}
        files={files}
        directories={directories}
        isLoading={isLoading}
        onOpenFile={handleOpenFile}
        gitignoredFiles={gitignoredFiles}
        gitignoredDirectories={gitignoredDirectories}
        onRefreshFiles={refreshFileTree}
        refreshToken={refreshToken}
      />
    </div>
  );
}

export default DockviewFileTreePanel;
