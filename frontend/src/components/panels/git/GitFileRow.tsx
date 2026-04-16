import { memo, useCallback } from 'react';
import { Plus, Minus, Undo2 } from 'lucide-react';
import type { GitFileStatusEntry } from 'shared/types';
import FileIcon from '@/components/FileIcon';
import { GitStatusBadge } from './GitStatusBadge';
import { GitChangeStats } from './GitChangeStats';

export type FileSection = 'staged' | 'unstaged';

interface GitFileRowProps {
  file: GitFileStatusEntry;
  section: FileSection;
  isActive: boolean;
  isSelected?: boolean;
  onSelect: (path: string, e?: React.MouseEvent) => void;
  onDoubleClick?: (path: string) => void;
  onContextMenu?: (path: string, e: React.MouseEvent) => void;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
}

function splitPath(filePath: string): { name: string } {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const name = parts.pop() ?? filePath;
  return { name };
}

export const GitFileRow = memo(function GitFileRow({
  file,
  section,
  isActive,
  isSelected = false,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onStageFile,
  onUnstageFile,
  onRevertFile,
}: GitFileRowProps) {
  const { name } = splitPath(file.path);

  const handleClick = useCallback(
    (e: React.MouseEvent) => onSelect(file.path, e),
    [file.path, onSelect]
  );
  const handleDoubleClick = useCallback(
    () => onDoubleClick?.(file.path),
    [file.path, onDoubleClick]
  );
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu?.(file.path, e),
    [file.path, onContextMenu]
  );

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const highlight = isSelected || isActive;

  return (
    <div
      className={`group cursor-pointer border-b border-border/20 px-2 py-1.5 text-xs hover:bg-accent/50 ${
        highlight ? 'bg-accent/60' : ''
      }${isSelected ? ' ring-1 ring-inset ring-ring/30' : ''}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(file.path);
      }}
      title={file.path}
      data-section={section}
      data-status={file.status}
    >
      <div className="flex items-start gap-2">
        <GitStatusBadge status={file.status} />
        <FileIcon filePath={name} className="mt-[1px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-xs leading-tight text-foreground">
              {name}
            </span>
            <div className="ml-auto flex items-center justify-end gap-1">
              <GitChangeStats
                additions={file.additions}
                deletions={file.deletions}
              />

              {/* Hover action buttons */}
              <div className="w-[44px] shrink-0">
                <div className="flex items-center justify-end gap-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
                  {section === 'unstaged' && (
                    <>
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                        onClick={(e) => {
                          stop(e);
                          onStageFile?.(file.path);
                        }}
                        title="Stage"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-red-400"
                        onClick={(e) => {
                          stop(e);
                          onRevertFile?.(file.path);
                        }}
                        title="Discard changes"
                      >
                        <Undo2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                  {section === 'staged' && (
                    <button
                      className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                      onClick={(e) => {
                        stop(e);
                        onUnstageFile?.(file.path);
                      }}
                      title="Unstage"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="truncate text-[10px] leading-tight text-muted-foreground/90">
            {file.path.replace(/\\/g, '/')}
          </div>
        </div>
      </div>
    </div>
  );
});
