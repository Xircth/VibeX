import { memo, useCallback } from 'react';
import { Eye, Plus, Minus, Undo2 } from 'lucide-react';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { IconButton } from '@astryxdesign/core/IconButton';
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
  indentPx?: number;
  onSelect: (path: string, e?: React.MouseEvent) => void;
  onReviewFile?: (path: string) => void;
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
  indentPx = 0,
  onSelect,
  onReviewFile,
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
      className={`group flex min-h-[38px] cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent/50 ${
        highlight ? 'bg-accent/60' : ''
      }${isSelected ? ' ring-1 ring-inset ring-ring/30' : ''}`}
      style={indentPx > 0 ? { paddingLeft: `${8 + indentPx}px` } : undefined}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(file.path);
      }}
      data-section={section}
      data-status={file.status}
    >
      <FileIcon filePath={name} className="shrink-0 self-center" />
      <div className="flex min-w-0 flex-1 flex-col justify-center self-center">
        <div className="truncate text-xs font-bold leading-tight text-foreground">
          {name}
        </div>
        <div className="truncate text-[10px] leading-tight text-muted-foreground/90">
          {file.path.replace(/\\/g, '/')}
        </div>
      </div>
      <div className="ml-auto flex h-5 shrink-0 items-center justify-end gap-1.5 self-center">
        <GitStatusBadge status={file.status} />
        <GitChangeStats
          additions={file.additions}
          deletions={file.deletions}
          className="group-hover:hidden"
        />

        {/* Hover action button group */}
        <div
          className="hidden h-5 shrink-0 items-center group-hover:inline-flex"
          onClick={stop}
          onDoubleClick={stop}
        >
          <ButtonGroup label="File actions" size="sm">
            <IconButton
              label="Review"
              variant="secondary"
              size="sm"
              className="!h-5 !w-5 [&_svg]:!h-3 [&_svg]:!w-3"
              icon={<Eye className="h-3 w-3" />}
              onClick={(e) => {
                stop(e);
                (onReviewFile ?? onSelect)(file.path);
              }}
            />
            {section === 'unstaged' && (
              <>
                <IconButton
                  label="Stage"
                  variant="secondary"
                  size="sm"
                  className="!h-5 !w-5 [&_svg]:!h-3 [&_svg]:!w-3"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={(e) => {
                    stop(e);
                    onStageFile?.(file.path);
                  }}
                />
                <IconButton
                  label="Discard Changes"
                  variant="secondary"
                  size="sm"
                  className="!h-5 !w-5 hover:!text-destructive [&_svg]:!h-3 [&_svg]:!w-3"
                  icon={<Undo2 className="h-3 w-3" />}
                  onClick={(e) => {
                    stop(e);
                    onRevertFile?.(file.path);
                  }}
                />
              </>
            )}
            {section === 'staged' && (
              <IconButton
                label="Unstage"
                variant="secondary"
                size="sm"
                className="!h-5 !w-5 [&_svg]:!h-3 [&_svg]:!w-3"
                icon={<Minus className="h-3 w-3" />}
                onClick={(e) => {
                  stop(e);
                  onUnstageFile?.(file.path);
                }}
              />
            )}
          </ButtonGroup>
        </div>
      </div>
    </div>
  );
});
