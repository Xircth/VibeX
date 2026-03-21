import { useCallback, useEffect, useRef, useState } from 'react';
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
import { FileTreePanel } from '@/components/file-tree/FileTreePanel';

/**
 * DockviewFileTreePanel - File tree sidebar panel for browsing project files.
 *
 * Uses the mossx-style FileTreePanel with lazy-loaded directories,
 * rich file icons, git status, and file preview.
 */
function DockviewFileTreePanel(_props: IDockviewPanelProps) {
  const {
    rootPath,
    setRootPath,
    setSelectedFilePath,
  } = useFileTreeStore();
  const { openFilePreview } = usePanelActions();
  const { projectId } = useProject();
  const { data: repos } = useProjectRepos(projectId);

  // Active workspace context
  const { activeWorktreeId } = useWorktree();
  const { data: workspace } = useAttempt(activeWorktreeId ?? undefined);
  const { repos: workspaceRepos } = useAttemptRepo(activeWorktreeId ?? undefined);

  // Track previous workspace ID to detect workspace switches
  const prevWorktreeIdRef = useRef<string | null>(null);
  const prevProjectIdRef = useRef<string | undefined>(projectId);

  // Directory listing state
  const [files, setFiles] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [gitignoredFiles, setGitignoredFiles] = useState<Set<string>>(new Set());
  const [gitignoredDirectories, setGitignoredDirectories] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);

  // Switch rootPath to workspace worktree path when workspace changes
  useEffect(() => {
    if (activeWorktreeId && activeWorktreeId !== prevWorktreeIdRef.current) {
      if (workspace?.container_ref && workspaceRepos.length > 0) {
        const containerRef = workspace.container_ref;
        const repoName = workspaceRepos[0].name;
        // Use the same separator as the containerRef path
        const sep = containerRef.includes("\\") ? "\\" : "/";
        const worktreePath = containerRef.replace(/[\\/]+$/, '') + sep + repoName;
        setRootPath(worktreePath);
        prevWorktreeIdRef.current = activeWorktreeId;
      }
    } else if (!activeWorktreeId && prevWorktreeIdRef.current !== null) {
      prevWorktreeIdRef.current = null;
      if (repos && repos.length > 0) {
        setRootPath(repos[0].path);
      }
    }
  }, [activeWorktreeId, workspace, workspaceRepos, repos, setRootPath]);

  useEffect(() => {
    const projectChanged = prevProjectIdRef.current !== projectId;
    prevProjectIdRef.current = projectId;

    if (!projectChanged || activeWorktreeId || !repos || repos.length === 0) {
      return;
    }

    setRootPath(repos[0].path);
  }, [activeWorktreeId, projectId, repos, setRootPath]);

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
    try {
      const response: DirectoryChildrenResponse = await fileTreeApi.listDirectoryChildren(
        rootPath,
        '',
      );
      setFiles(response.files);
      setDirectories(response.directories);
      setGitignoredFiles(new Set(response.gitignored_files));
      setGitignoredDirectories(new Set(response.gitignored_directories));
    } catch {
      setFiles([]);
      setDirectories([]);
    } finally {
      setIsLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void loadRootChildren();
  }, [loadRootChildren]);

  const handleOpenFile = useCallback(
    (relativePath: string) => {
      if (!rootPath) return;
      const usesWindowsSeparator = rootPath.includes("\\");
      const separator = usesWindowsSeparator ? "\\" : "/";
      const base = rootPath.replace(/[\\/]+$/, "");
      const normalizedRelative = usesWindowsSeparator
        ? relativePath.replaceAll("/", "\\")
        : relativePath;
      const absolutePath = `${base}${separator}${normalizedRelative}`;
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
      <div className="h-full w-full overflow-auto bg-background p-2" data-panel="file-tree">
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
        onRefreshFiles={loadRootChildren}
      />
    </div>
  );
}

export default DockviewFileTreePanel;
