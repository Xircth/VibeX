import { useCallback, useState, useRef, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import type { FileTreeEntry } from '@/lib/api';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useDeleteFile } from '@/hooks/useFileContent';
import { cn } from '@/lib/utils';

interface FileTreeNodeProps {
  entry: FileTreeEntry;
  depth: number;
  onFileSelect: (path: string) => void;
  onFileDiff: (path: string) => void;
}

const GIT_STATUS_COLORS: Record<string, string> = {
  modified: 'text-primary',
  added: 'text-[#86B300]',
  deleted: 'text-[#F51818]',
  untracked: 'text-[#86B300]',
  renamed: 'text-[#55B4D4]',
  conflicted: 'text-[#F51818]',
};

function getLanguageIcon(_name: string): null {
  // Could be extended with file-type-specific icons
  return null;
}

export function FileTreeNode({
  entry,
  depth,
  onFileSelect,
  onFileDiff,
}: FileTreeNodeProps) {
  const { expandedDirs, toggleDir, selectedFilePath } = useFileTreeStore();
  const deleteFileMutation = useDeleteFile();
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const isExpanded = expandedDirs.has(entry.path);
  const isSelected = selectedFilePath === entry.path;
  const statusColor = entry.git_status
    ? GIT_STATUS_COLORS[entry.git_status] || ''
    : '';

  const handleClick = useCallback(() => {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else {
      onFileSelect(entry.path);
    }
  }, [entry.is_dir, entry.path, toggleDir, onFileSelect]);

  const handleDoubleClick = useCallback(() => {
    if (!entry.is_dir && entry.git_status === 'modified') {
      onFileDiff(entry.path);
    }
  }, [entry.is_dir, entry.git_status, entry.path, onFileDiff]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenuPos({ x: e.clientX, y: e.clientY });
      setShowContextMenu(true);
    },
    []
  );

  const handleDelete = useCallback(() => {
    setShowContextMenu(false);
    if (
      window.confirm(
        `Are you sure you want to delete "${entry.name}"?`
      )
    ) {
      deleteFileMutation.mutate(entry.path);
    }
  }, [entry.name, entry.path, deleteFileMutation]);

  const handleDiffFromMenu = useCallback(() => {
    setShowContextMenu(false);
    onFileDiff(entry.path);
  }, [entry.path, onFileDiff]);

  // Close context menu on outside click
  useEffect(() => {
    if (!showContextMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setShowContextMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showContextMenu]);

  // Suppress the unused variable lint
  void getLanguageIcon;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 px-1 py-0.5 cursor-pointer text-xs hover:bg-accent/50 rounded select-none',
          isSelected && 'bg-accent',
          statusColor
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        title={entry.path}
      >
        {/* Expand/collapse icon for directories */}
        {entry.is_dir ? (
          <span className="w-4 h-4 flex items-center justify-center shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}

        {/* File/folder icon */}
        <span className="w-4 h-4 flex items-center justify-center shrink-0">
          {entry.is_dir ? (
            isExpanded ? (
              <FolderOpen className="w-3.5 h-3.5 text-blue-400" />
            ) : (
              <Folder className="w-3.5 h-3.5 text-blue-400" />
            )
          ) : (
            <File className="w-3.5 h-3.5 opacity-60" />
          )}
        </span>

        {/* File name */}
        <span className="truncate">{entry.name}</span>

        {/* Git status indicator */}
        {entry.git_status && !entry.is_dir && (
          <span className="ml-auto text-[10px] opacity-70 uppercase shrink-0">
            {entry.git_status.charAt(0)}
          </span>
        )}
      </div>

      {/* Children */}
      {entry.is_dir && isExpanded && entry.children && (
        <div>
          {entry.children.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              onFileDiff={onFileDiff}
            />
          ))}
        </div>
      )}

      {/* Context menu */}
      {showContextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover border border-border shadow-md rounded py-1 text-xs min-w-[140px]"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
        >
          {!entry.is_dir && entry.git_status === 'modified' && (
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"
              onClick={handleDiffFromMenu}
            >
              View Diff
            </button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-accent text-red-400 flex items-center gap-2"
            onClick={handleDelete}
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
