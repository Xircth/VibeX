import { memo, useRef, useMemo, useCallback, useState, useEffect } from 'react';
import { Columns2, Rows3, ChevronUp, ChevronDown } from 'lucide-react';
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
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/20 text-xs"
        data-diff-header
      >
        <span className={`font-bold text-[10px] ${statusColor}`}>
          {entry.status}
        </span>
        <span className="font-mono text-foreground truncate">{entry.path}</span>
        {entry.is_binary && (
          <span className="text-muted-foreground text-[10px] ml-auto">
            Binary file
          </span>
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
        <div className="px-3 py-2 text-xs text-muted-foreground italic">
          Empty diff
        </div>
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
  const [stickyFile, setStickyFile] = useState<{
    path: string;
    status: string;
  } | null>(null);

  const effectiveDiffs = useMemo(() => {
    if (!selectedPath) return diffs;
    return diffs.filter((d) => d.path === selectedPath);
  }, [diffs, selectedPath]);

  // Sticky file header tracking via IntersectionObserver
  // Tracks the last diff card that scrolled past the top of the viewport
  const lastStickyPathRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || effectiveDiffs.length <= 1) return;

    const aboveThreshold = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const ioEntry of entries) {
          const path = (ioEntry.target as HTMLElement).dataset.diffPath;
          if (!path) continue;

          if (!ioEntry.isIntersecting) {
            // Element is outside the root margin; check if it's above (scrolled past)
            if (ioEntry.boundingClientRect.top < 0) {
              aboveThreshold.add(path);
            } else {
              aboveThreshold.delete(path);
            }
          } else {
            aboveThreshold.delete(path);
          }
        }

        // Find the last element (by document order) that is above threshold
        let foundFile: { path: string; status: string } | null = null;
        for (const entry of effectiveDiffs) {
          if (aboveThreshold.has(entry.path)) {
            foundFile = { path: entry.path, status: entry.status };
          }
        }

        if (foundFile?.path !== lastStickyPathRef.current) {
          lastStickyPathRef.current = foundFile?.path ?? null;
          setStickyFile(foundFile);
        }
      },
      {
        root: container,
        rootMargin: '-40px 0px 0px 0px',
        threshold: [0, 1],
      }
    );

    const cards = container.querySelectorAll('[data-diff-path]');
    for (const card of cards) {
      observer.observe(card);
    }

    return () => observer.disconnect();
  }, [effectiveDiffs]);

  // Navigate to next/prev file
  const navigateChange = useCallback((direction: 'prev' | 'next') => {
    const container = containerRef.current;
    if (!container) return;

    const headers = container.querySelectorAll('[data-diff-header]');
    if (headers.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    let targetIdx = direction === 'next' ? 0 : headers.length - 1;

    if (direction === 'next') {
      for (let i = 0; i < headers.length; i++) {
        const rect = headers[i].getBoundingClientRect();
        if (rect.top > containerRect.top + 50) {
          targetIdx = i;
          break;
        }
      }
    } else {
      for (let i = headers.length - 1; i >= 0; i--) {
        const rect = headers[i].getBoundingClientRect();
        if (rect.top < containerRect.top - 10) {
          targetIdx = i;
          break;
        }
      }
    }

    headers[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handlePrevChange = useCallback(
    () => navigateChange('prev'),
    [navigateChange]
  );
  const handleNextChange = useCallback(
    () => navigateChange('next'),
    [navigateChange]
  );

  if (diffs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        No file changes to display
      </div>
    );
  }

  const stickyStatusColor = stickyFile
    ? (STATUS_COLORS[stickyFile.status] ?? 'text-muted-foreground')
    : '';

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50 shrink-0">
        <span className="text-[10px] text-muted-foreground">
          {effectiveDiffs.length} file{effectiveDiffs.length !== 1 ? 's' : ''}
        </span>

        <div className="flex items-center gap-1">
          {/* Change anchor navigation */}
          {effectiveDiffs.length > 1 && (
            <div className="flex items-center gap-0.5 mr-1">
              <button
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                onClick={handlePrevChange}
                title="Previous file"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                onClick={handleNextChange}
                title="Next file"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          )}

          <button
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            onClick={onToggleDiffStyle}
            title={
              diffStyle === 'unified'
                ? 'Switch to split view'
                : 'Switch to unified view'
            }
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
      </div>

      {/* Sticky file header */}
      {stickyFile && effectiveDiffs.length > 1 && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-accent/30 border-b border-border/30 text-xs shrink-0">
          <span className={`font-bold text-[10px] ${stickyStatusColor}`}>
            {stickyFile.status}
          </span>
          <span className="font-mono text-foreground truncate">
            {stickyFile.path}
          </span>
        </div>
      )}

      {/* Scrollable diff list */}
      <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="space-y-1 p-1">
          {effectiveDiffs.map((entry) => (
            <DiffCard
              key={entry.path}
              entry={entry}
              isSelected={selectedPath === entry.path}
              diffStyle={diffStyle}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
