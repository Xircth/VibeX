import { memo, useCallback, useMemo, useState } from 'react';
import { Plus, Minus, Undo2, CheckCircle2, SquarePen } from 'lucide-react';
import type { GitFileStatusEntry } from 'shared/types';
import type { DiffListView } from '@/hooks/git/useGitPanelController';
import { GitFileRow } from './GitFileRow';
import { GitFileTree } from './GitFileTree';
import { GitDiscardDialog } from './GitDiscardDialog';
import {
  GitContextMenu,
  buildFileContextActions,
  type ContextMenuAction,
} from './GitContextMenu';

interface GitStagingAreaProps {
  stagedFiles: GitFileStatusEntry[];
  unstagedFiles: GitFileStatusEntry[];
  selectedPath: string | null;
  viewMode?: DiffListView;
  onSelectFile: (path: string) => void;
  onDoubleClickFile?: (path: string) => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onRevertFile: (path: string) => void;
  onStageAll: () => void;
  onRevertAll: () => void;
}

interface SectionHeaderProps {
  label: string;
  count: number;
  icon: React.ReactNode;
  actions: React.ReactNode;
}

const SectionHeader = memo(function SectionHeader({
  label,
  count,
  icon,
  actions,
}: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <div className="flex items-center gap-1.5">
        {icon}
        <span>{label}</span>
        <span className="text-muted-foreground/60">({count})</span>
      </div>
      <div className="flex items-center gap-0.5">{actions}</div>
    </div>
  );
});

type DiscardTarget = { type: 'all' } | { type: 'files'; paths: string[] };

interface ContextMenuState {
  x: number;
  y: number;
  section: 'staged' | 'unstaged';
  path: string;
}

export const GitStagingArea = memo(function GitStagingArea({
  stagedFiles,
  unstagedFiles,
  selectedPath,
  viewMode = 'flat',
  onSelectFile,
  onDoubleClickFile,
  onStageFile,
  onUnstageFile,
  onRevertFile,
  onStageAll,
  onRevertAll,
}: GitStagingAreaProps) {
  const [discardTarget, setDiscardTarget] = useState<DiscardTarget | null>(
    null
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Multi-select click handler
  const handleFileClick = useCallback(
    (path: string, e?: React.MouseEvent) => {
      const isCtrl = e?.ctrlKey || e?.metaKey;
      const isShift = e?.shiftKey;

      if (isCtrl) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        });
        setLastClickedPath(path);
      } else if (isShift && lastClickedPath) {
        // Range select within the same file list
        const allFiles = [...stagedFiles, ...unstagedFiles];
        const paths = allFiles.map((f) => f.path);
        const startIdx = paths.indexOf(lastClickedPath);
        const endIdx = paths.indexOf(path);
        if (startIdx !== -1 && endIdx !== -1) {
          const [from, to] =
            startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          const range = paths.slice(from, to + 1);
          setSelectedPaths(new Set(range));
        }
      } else {
        setSelectedPaths(new Set([path]));
        setLastClickedPath(path);
        onSelectFile(path);
      }
    },
    [lastClickedPath, stagedFiles, unstagedFiles, onSelectFile]
  );

  // Context menu handler
  const handleContextMenu = useCallback(
    (path: string, section: 'staged' | 'unstaged', e: React.MouseEvent) => {
      e.preventDefault();
      // If right-clicked file is not in selection, select it
      if (!selectedPaths.has(path)) {
        setSelectedPaths(new Set([path]));
      }
      setContextMenu({ x: e.clientX, y: e.clientY, section, path });
    },
    [selectedPaths]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Resolve context menu actions
  const contextMenuActions = useMemo((): ContextMenuAction[] => {
    if (!contextMenu) return [];
    const activePaths =
      selectedPaths.size > 0 ? [...selectedPaths] : [contextMenu.path];
    return buildFileContextActions({
      section: contextMenu.section,
      filePaths: activePaths,
      onStageFile,
      onUnstageFile,
      onRevertFile: (path: string) =>
        setDiscardTarget({ type: 'files', paths: [path] }),
      onCopyPath: (path: string) => navigator.clipboard.writeText(path),
    });
  }, [contextMenu, selectedPaths, onStageFile, onUnstageFile]);

  // Discard handlers
  const handleRevertAll = useCallback(() => {
    setDiscardTarget({ type: 'all' });
  }, []);

  const handleRevertFile = useCallback((path: string) => {
    setDiscardTarget({ type: 'files', paths: [path] });
  }, []);

  const handleDiscardConfirm = useCallback(() => {
    if (!discardTarget) return;
    if (discardTarget.type === 'all') {
      onRevertAll();
    } else {
      discardTarget.paths.forEach((p) => onRevertFile(p));
    }
    setDiscardTarget(null);
  }, [discardTarget, onRevertAll, onRevertFile]);

  const handleDiscardCancel = useCallback(() => {
    setDiscardTarget(null);
  }, []);

  const discardFiles =
    discardTarget?.type === 'all'
      ? unstagedFiles.map((f) => f.path)
      : discardTarget?.type === 'files'
        ? discardTarget.paths
        : [];

  // Batch actions for selected files
  const hasMultiSelection = selectedPaths.size > 1;

  return (
    <div className="flex flex-col min-h-0">
      {/* Batch action bar */}
      {hasMultiSelection && (
        <div className="flex items-center gap-1 px-2 py-1 bg-accent/20 border-b border-border/30 text-[10px] text-muted-foreground">
          <span>{selectedPaths.size} files selected</span>
          <div className="flex-1" />
          <button
            className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            onClick={() => selectedPaths.forEach((p) => onStageFile(p))}
            title="Stage selected"
          >
            <Plus className="h-3 w-3 inline mr-0.5" />
            Stage
          </button>
          <button
            className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            onClick={() => selectedPaths.forEach((p) => onUnstageFile(p))}
            title="Unstage selected"
          >
            <Minus className="h-3 w-3 inline mr-0.5" />
            Unstage
          </button>
          <button
            className="px-1.5 py-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            onClick={() =>
              setDiscardTarget({ type: 'files', paths: [...selectedPaths] })
            }
            title="Discard selected"
          >
            <Undo2 className="h-3 w-3 inline mr-0.5" />
            Discard
          </button>
          <button
            className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedPaths(new Set())}
            title="Clear selection"
          >
            Clear
          </button>
        </div>
      )}

      {/* Staged section */}
      {stagedFiles.length > 0 && (
        <div className="flex flex-col">
          <SectionHeader
            label="Staged"
            count={stagedFiles.length}
            icon={<CheckCircle2 className="h-3 w-3 text-green-500" />}
            actions={
              <button
                className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground"
                onClick={onStageAll}
                title="Unstage all"
              >
                <Minus className="h-3 w-3" />
              </button>
            }
          />
          {viewMode === 'tree' ? (
            <GitFileTree
              files={stagedFiles}
              section="staged"
              selectedPath={selectedPath}
              selectedPaths={selectedPaths}
              onSelectFile={handleFileClick}
              onDoubleClick={onDoubleClickFile}
              onContextMenu={(path, e) => handleContextMenu(path, 'staged', e)}
              onUnstageFile={onUnstageFile}
            />
          ) : (
            <div className="flex flex-col">
              {stagedFiles.map((file) => (
                <GitFileRow
                  key={`staged-${file.path}`}
                  file={file}
                  section="staged"
                  isActive={selectedPath === file.path}
                  isSelected={selectedPaths.has(file.path)}
                  onSelect={handleFileClick}
                  onDoubleClick={onDoubleClickFile}
                  onContextMenu={(path, e) =>
                    handleContextMenu(path, 'staged', e)
                  }
                  onUnstageFile={onUnstageFile}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Unstaged section */}
      {unstagedFiles.length > 0 && (
        <div className="flex flex-col">
          <SectionHeader
            label="Changes"
            count={unstagedFiles.length}
            icon={<SquarePen className="h-3 w-3 text-yellow-500" />}
            actions={
              <>
                <button
                  className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground"
                  onClick={onStageAll}
                  title="Stage all"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-red-400"
                  onClick={handleRevertAll}
                  title="Discard all"
                >
                  <Undo2 className="h-3 w-3" />
                </button>
              </>
            }
          />
          {viewMode === 'tree' ? (
            <GitFileTree
              files={unstagedFiles}
              section="unstaged"
              selectedPath={selectedPath}
              selectedPaths={selectedPaths}
              onSelectFile={handleFileClick}
              onDoubleClick={onDoubleClickFile}
              onContextMenu={(path, e) =>
                handleContextMenu(path, 'unstaged', e)
              }
              onStageFile={onStageFile}
              onRevertFile={handleRevertFile}
            />
          ) : (
            <div className="flex flex-col">
              {unstagedFiles.map((file) => (
                <GitFileRow
                  key={`unstaged-${file.path}`}
                  file={file}
                  section="unstaged"
                  isActive={selectedPath === file.path}
                  isSelected={selectedPaths.has(file.path)}
                  onSelect={handleFileClick}
                  onDoubleClick={onDoubleClickFile}
                  onContextMenu={(path, e) =>
                    handleContextMenu(path, 'unstaged', e)
                  }
                  onStageFile={onStageFile}
                  onRevertFile={handleRevertFile}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {stagedFiles.length === 0 && unstagedFiles.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
          No changes detected
        </div>
      )}

      {/* Discard confirmation dialog */}
      <GitDiscardDialog
        open={discardTarget !== null}
        files={discardFiles}
        onConfirm={handleDiscardConfirm}
        onCancel={handleDiscardCancel}
      />

      {/* Context menu */}
      {contextMenu && (
        <GitContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextMenuActions}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
});
