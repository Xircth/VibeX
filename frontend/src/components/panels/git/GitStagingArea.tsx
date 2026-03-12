import { memo, useCallback } from 'react';
import { Plus, Minus, Undo2, CheckCircle2, SquarePen } from 'lucide-react';
import type { GitFileStatusEntry } from 'shared/types';
import { GitFileRow } from './GitFileRow';

interface GitStagingAreaProps {
  stagedFiles: GitFileStatusEntry[];
  unstagedFiles: GitFileStatusEntry[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
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

const SectionHeader = memo(function SectionHeader({ label, count, icon, actions }: SectionHeaderProps) {
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

export const GitStagingArea = memo(function GitStagingArea({
  stagedFiles,
  unstagedFiles,
  selectedPath,
  onSelectFile,
  onStageFile,
  onUnstageFile,
  onRevertFile,
  onStageAll,
  onRevertAll,
}: GitStagingAreaProps) {
  const handleRevertAll = useCallback(() => {
    if (window.confirm('Discard all unstaged changes? This cannot be undone.')) {
      onRevertAll();
    }
  }, [onRevertAll]);

  return (
    <div className="flex flex-col min-h-0">
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
          <div className="flex flex-col">
            {stagedFiles.map((file) => (
              <GitFileRow
                key={`staged-${file.path}`}
                file={file}
                section="staged"
                isActive={selectedPath === file.path}
                onSelect={onSelectFile}
                onUnstageFile={onUnstageFile}
              />
            ))}
          </div>
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
          <div className="flex flex-col">
            {unstagedFiles.map((file) => (
              <GitFileRow
                key={`unstaged-${file.path}`}
                file={file}
                section="unstaged"
                isActive={selectedPath === file.path}
                onSelect={onSelectFile}
                onStageFile={onStageFile}
                onRevertFile={onRevertFile}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {stagedFiles.length === 0 && unstagedFiles.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
          No changes detected
        </div>
      )}
    </div>
  );
});
