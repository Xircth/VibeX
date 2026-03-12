import { memo, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Columns2, Rows3 } from 'lucide-react';
import type { GitFileDiffEntry } from 'shared/types';
import { DiffBlock, type DiffStyle } from './DiffBlock';
import { ImageDiffCard } from './ImageDiffCard';

interface GitDiffViewerProps {
  diffs: GitFileDiffEntry[];
  diffStyle: DiffStyle;
  selectedPath: string | null;
  onToggleDiffStyle: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  A: 'text-green-500',
  M: 'text-yellow-500',
  D: 'text-red-500',
  R: 'text-blue-500',
};

const DiffCard = memo(function DiffCard({
  entry,
  isSelected,
  diffStyle,
}: {
  entry: GitFileDiffEntry;
  isSelected: boolean;
  diffStyle: DiffStyle;
}) {
  const statusColor = STATUS_COLORS[entry.status] ?? 'text-muted-foreground';

  return (
    <div
      className={`rounded border overflow-hidden ${
        isSelected ? 'border-ring' : 'border-border/30'
      }`}
      data-diff-path={entry.path}
    >
      {/* File header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/20 text-xs">
        <span className={`font-bold text-[10px] ${statusColor}`}>{entry.status}</span>
        <span className="font-mono text-foreground truncate">{entry.path}</span>
        {entry.is_binary && (
          <span className="text-muted-foreground text-[10px] ml-auto">Binary file</span>
        )}
      </div>

      {/* Content */}
      {entry.is_image ? (
        <ImageDiffCard path={entry.path} status={entry.status} />
      ) : entry.is_binary ? (
        <div className="px-3 py-4 text-xs text-muted-foreground italic text-center">
          Binary file not shown
        </div>
      ) : entry.diff ? (
        <DiffBlock diff={entry.diff} diffStyle={diffStyle} />
      ) : (
        <div className="px-3 py-2 text-xs text-muted-foreground italic">Empty diff</div>
      )}
    </div>
  );
});

export const GitDiffViewer = memo(function GitDiffViewer({
  diffs,
  diffStyle,
  selectedPath,
  onToggleDiffStyle,
}: GitDiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const effectiveDiffs = useMemo(() => {
    if (!selectedPath) return diffs;
    return diffs.filter((d) => d.path === selectedPath);
  }, [diffs, selectedPath]);

  const virtualizer = useVirtualizer({
    count: effectiveDiffs.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 300,
    overscan: 4,
  });

  if (diffs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        No file changes to display
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50">
        <span className="text-[10px] text-muted-foreground">
          {effectiveDiffs.length} file{effectiveDiffs.length !== 1 ? 's' : ''}
        </span>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onClick={onToggleDiffStyle}
          title={diffStyle === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
        >
          {diffStyle === 'unified' ? (
            <>
              <Columns2 className="h-3 w-3" />
              <span>Split</span>
            </>
          ) : (
            <>
              <Rows3 className="h-3 w-3" />
              <span>Unified</span>
            </>
          )}
        </button>
      </div>

      {/* Virtual scrolling diff list */}
      <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const entry = effectiveDiffs[vItem.index];
            return (
              <div
                key={entry.path}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vItem.start}px)`,
                }}
                className="px-1 py-0.5"
              >
                <DiffCard
                  entry={entry}
                  isSelected={selectedPath === entry.path}
                  diffStyle={diffStyle}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
