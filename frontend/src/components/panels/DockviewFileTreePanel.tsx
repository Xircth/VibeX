import { useCallback, useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { FolderTree, RefreshCw, FolderOpen } from 'lucide-react';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useFileTree } from '@/hooks/useFileTree';
import { FileTreeNode } from '@/components/file-tree/FileTreeNode';
import { usePanelActions } from '@/hooks/usePanelActions';
import { open } from '@tauri-apps/plugin-dialog';
import { useProject } from '@/contexts/ProjectContext';
import { useProjectRepos } from '@/hooks/useProjectRepos';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttempt } from '@/hooks/useAttempt';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';

/**
 * DockviewFileTreePanel - File tree sidebar panel for browsing project files.
 *
 * Shows a tree of files with git status indicators.
 * Clicking a file opens it in the Preview (Monaco Editor) panel.
 * Double-clicking a modified file opens it in the Diff panel.
 * Right-clicking shows a context menu with delete option.
 */
function DockviewFileTreePanel(_props: IDockviewPanelProps) {
  const {
    rootPath,
    setRootPath,
    setSelectedFilePath,
    setDiffFilePath,
  } = useFileTreeStore();
  const { data: tree, isLoading, refetch } = useFileTree(rootPath);
  const { openFilePreview, openDiffPreview } = usePanelActions();
  const { projectId } = useProject();
  const { data: repos } = useProjectRepos(projectId);

  // Active workspace context
  const { activeWorktreeId } = useWorktree();
  const { data: workspace } = useAttempt(activeWorktreeId ?? undefined);
  const { repos: workspaceRepos } = useAttemptRepo(activeWorktreeId ?? undefined);

  // Track previous workspace ID to detect workspace switches
  const prevWorktreeIdRef = useRef<string | null>(null);

  // Switch rootPath to workspace worktree path when workspace changes
  useEffect(() => {
    if (activeWorktreeId && activeWorktreeId !== prevWorktreeIdRef.current) {
      if (workspace?.container_ref && workspaceRepos.length > 0) {
        const containerRef = workspace.container_ref;
        const repoName = workspaceRepos[0].name;
        // Worktree path = container_ref + "/" + repo.name
        const worktreePath = containerRef.replace(/[\\/]+$/, '') + '/' + repoName;
        setRootPath(worktreePath);
        prevWorktreeIdRef.current = activeWorktreeId;
      }
      // If data not ready yet, don't update ref — let effect re-run when data arrives
    } else if (!activeWorktreeId && prevWorktreeIdRef.current !== null) {
      // Workspace deselected — fall back to project repo path
      prevWorktreeIdRef.current = null;
      if (repos && repos.length > 0) {
        setRootPath(repos[0].path);
      }
    }
  }, [activeWorktreeId, workspace, workspaceRepos, repos, setRootPath]);

  // Auto-set rootPath from project repos when no workspace is active and no rootPath set
  useEffect(() => {
    if (!rootPath && !activeWorktreeId && repos && repos.length > 0) {
      setRootPath(repos[0].path);
    }
  }, [rootPath, activeWorktreeId, repos, setRootPath]);

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFilePath(path);
      openFilePreview(path);
    },
    [setSelectedFilePath, openFilePreview]
  );

  const handleFileDiff = useCallback(
    (path: string) => {
      setDiffFilePath(path);
      openDiffPreview();
    },
    [setDiffFilePath, openDiffPreview]
  );

  const handlePickFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select project folder',
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
            <p className="font-medium">File Tree</p>
            <p className="text-xs">No folder selected</p>
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-accent/80 rounded transition-colors mx-auto"
              onClick={handlePickFolder}
            >
              <FolderOpen className="w-3 h-3" />
              Open Folder
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-background" data-panel="file-tree">
      {/* Header with root path and refresh */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border text-xs text-muted-foreground shrink-0">
        <button
          className="hover:text-foreground transition-colors truncate flex-1 text-left"
          onClick={handlePickFolder}
          title={rootPath}
        >
          {rootPath.split(/[/\\]/).pop() || rootPath}
        </button>
        <button
          className="p-0.5 hover:text-foreground transition-colors shrink-0"
          onClick={() => refetch()}
          title="Refresh file tree"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-auto py-1">
        {isLoading && !tree && (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            Loading...
          </div>
        )}
        {tree && tree.length === 0 && (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            Empty directory
          </div>
        )}
        {tree?.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            onFileSelect={handleFileSelect}
            onFileDiff={handleFileDiff}
          />
        ))}
      </div>
    </div>
  );
}

export default DockviewFileTreePanel;
