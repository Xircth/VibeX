import { memo, useCallback } from 'react';
import { Plus, Minus, Undo2 } from 'lucide-react';
import type { GitFileStatusEntry } from 'shared/types';

export type FileSection = 'staged' | 'unstaged';

interface GitFileRowProps {
  file: GitFileStatusEntry;
  section: FileSection;
  isActive: boolean;
  onSelect: (path: string) => void;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
}

const STATUS_STYLES: Record<string, { symbol: string; color: string }> = {
  A: { symbol: 'A', color: 'text-green-500' },
  M: { symbol: 'M', color: 'text-yellow-500' },
  D: { symbol: 'D', color: 'text-red-500' },
  R: { symbol: 'R', color: 'text-blue-500' },
  '?': { symbol: 'U', color: 'text-gray-400' },
};

function splitPath(filePath: string): { name: string; dir: string } {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const name = parts.pop() ?? filePath;
  const dir = parts.join('/');
  return { name, dir };
}

export const GitFileRow = memo(function GitFileRow({
  file,
  section,
  isActive,
  onSelect,
  onStageFile,
  onUnstageFile,
  onRevertFile,
}: GitFileRowProps) {
  const { name, dir } = splitPath(file.path);
  const st = STATUS_STYLES[file.status] ?? { symbol: file.status, color: 'text-muted-foreground' };

  const handleClick = useCallback(() => onSelect(file.path), [file.path, onSelect]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className={`group flex items-center gap-1.5 px-2 py-[3px] cursor-pointer text-xs hover:bg-accent/50 ${
        isActive ? 'bg-accent/60' : ''
      }`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      title={file.path}
      data-section={section}
      data-status={file.status}
    >
      {/* Status badge */}
      <span className={`shrink-0 w-4 text-center font-mono font-bold text-[10px] leading-none ${st.color}`}>
        {st.symbol}
      </span>

      {/* File name + directory */}
      <div className="flex-1 min-w-0 flex items-baseline gap-1">
        <span className="text-foreground truncate font-mono text-xs leading-tight">{name}</span>
        {dir && <span className="text-muted-foreground truncate text-[10px] leading-tight">{dir}</span>}
      </div>

      {/* Change stats */}
      <span className="shrink-0 font-mono text-[10px] leading-none flex items-center gap-0.5">
        {file.additions > 0 && <span className="text-green-500">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && <span className="text-muted-foreground">/</span>}
        {file.deletions > 0 && <span className="text-red-500">-{file.deletions}</span>}
      </span>

      {/* Hover action buttons */}
      <div className="shrink-0 hidden group-hover:flex items-center gap-0.5">
        {section === 'unstaged' && (
          <>
            <button
              className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground"
              onClick={(e) => { stop(e); onStageFile?.(file.path); }}
              title="Stage"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-red-400"
              onClick={(e) => { stop(e); onRevertFile?.(file.path); }}
              title="Discard changes"
            >
              <Undo2 className="h-3 w-3" />
            </button>
          </>
        )}
        {section === 'staged' && (
          <button
            className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground"
            onClick={(e) => { stop(e); onUnstageFile?.(file.path); }}
            title="Unstage"
          >
            <Minus className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
});
