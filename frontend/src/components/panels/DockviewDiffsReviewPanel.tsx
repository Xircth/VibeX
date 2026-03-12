import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  GitCompare,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  ChevronsDown,
  Loader2,
} from 'lucide-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttempt } from '@/hooks/useAttempt';
import { useDiffStream } from '@/hooks/useDiffStream';
import { useDiffSummary } from '@/hooks/useDiffSummary';
import DiffCard from '@/components/DiffCard';
import DiffViewSwitch from '@/components/DiffViewSwitch';
import { DiffFileTree } from '@/components/diff/DiffFileTree';
import type { Diff, DiffChangeKind } from 'shared/types';

type DiffCollapseDefaults = Record<DiffChangeKind, boolean>;

const DEFAULT_COLLAPSE: DiffCollapseDefaults = {
  added: false,
  deleted: true,
  modified: false,
  renamed: true,
  copied: true,
  permissionChange: true,
};
const COLLAPSE_MAX_LINES = 200;

const exceedsMax = (d: Diff, max: number) =>
  d.additions != null || d.deletions != null
    ? (d.additions ?? 0) + (d.deletions ?? 0) > max
    : true;

const getDiffId = (diff: Diff, index: number) =>
  diff.newPath || diff.oldPath || String(index);

const changeBadge: Record<DiffChangeKind, { label: string; color: string }> = {
  added: { label: 'A', color: 'text-green-600 bg-green-100 dark:bg-green-900/40' },
  deleted: { label: 'D', color: 'text-red-600 bg-red-100 dark:bg-red-900/40' },
  modified: { label: 'M', color: 'text-blue-600 bg-blue-100 dark:bg-blue-900/40' },
  renamed: { label: 'R', color: 'text-yellow-600 bg-yellow-100 dark:bg-yellow-900/40' },
  copied: { label: 'C', color: 'text-purple-600 bg-purple-100 dark:bg-purple-900/40' },
  permissionChange: { label: 'P', color: 'text-gray-600 bg-gray-100 dark:bg-gray-900/40' },
};

function DockviewDiffsReviewPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { data: workspace } = useAttempt(activeWorktreeId ?? undefined);
  const attemptId = workspace?.id ?? null;

  const { diffs, error, isInitialized } = useDiffStream(attemptId, true);
  const { fileCount, added, deleted } = useDiffSummary(attemptId);

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [stickyFileId, setStickyFileId] = useState<string | null>(null);

  // Safety timeout: if not initialized within 5s, stop showing spinner
  useEffect(() => {
    if (isInitialized || diffs.length > 0) {
      setLoadingTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setLoadingTimedOut(true), 5000);
    return () => clearTimeout(timer);
  }, [isInitialized, diffs.length]);

  const showLoading = !isInitialized && !loadingTimedOut && diffs.length === 0;

  const diffRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-collapse large/deleted diffs
  useEffect(() => {
    if (diffs.length === 0) return;
    const newDiffs = diffs
      .map((d, i) => ({ diff: d, index: i, id: getDiffId(d, i) }))
      .filter(({ id }) => !processedIds.has(id));

    if (newDiffs.length === 0) return;

    const newIds = newDiffs.map(({ id }) => id);
    const toCollapse = newDiffs
      .filter(
        ({ diff }) =>
          DEFAULT_COLLAPSE[diff.change] ||
          exceedsMax(diff, COLLAPSE_MAX_LINES)
      )
      .map(({ id }) => id);

    setProcessedIds((prev) => new Set([...prev, ...newIds]));
    if (toCollapse.length > 0) {
      setCollapsedIds((prev) => new Set([...prev, ...toCollapse]));
    }
  }, [diffs, processedIds]);

  const ids = useMemo(
    () => diffs.map((d, i) => getDiffId(d, i)),
    [diffs]
  );

  const toggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const allCollapsed =
    collapsedIds.size === diffs.length && diffs.length > 0;

  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(allCollapsed ? new Set() : new Set(ids));
  }, [allCollapsed, ids]);

  const scrollToFile = useCallback((id: string) => {
    const el = diffRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setCollapsedIds((prev) => {
        if (prev.has(id)) {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }
        return prev;
      });
    }
  }, []);

  // Sticky file header tracking
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || diffs.length === 0) return;

    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      let currentId: string | null = null;

      for (const [id, el] of diffRefs.current) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= containerRect.top + 40) {
          currentId = id;
        }
      }

      setStickyFileId(currentId);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [diffs]);

  const stickyDiff = useMemo(() => {
    if (!stickyFileId) return null;
    const idx = ids.indexOf(stickyFileId);
    if (idx === -1) return null;
    return diffs[idx];
  }, [stickyFileId, ids, diffs]);

  if (!activeWorktreeId) {
    return (
      <div
        className="h-full w-full flex items-center justify-center text-muted-foreground text-sm"
        data-panel="diffs"
      >
        <div className="text-center space-y-2">
          <GitCompare className="h-8 w-8 opacity-40 mx-auto" />
          <p className="font-medium">Diff Review</p>
          <p className="text-xs">选择一个工作区以查看变更</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 m-4">
        <div className="text-red-800 dark:text-red-300 text-sm">{`加载差异失败：${error}`}</div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex" data-panel="diffs">
      {/* Left: Diff content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header toolbar */}
        {diffs.length > 0 && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/30">
            <span className="text-xs text-muted-foreground">
              {fileCount} 个文件已更改{' '}
              <span className="text-green-600 dark:text-green-500">
                +{added}
              </span>{' '}
              <span className="text-red-600 dark:text-red-500">
                -{deleted}
              </span>
            </span>
            <div className="ml-auto flex items-center gap-1">
              <DiffViewSwitch />
              <button
                onClick={handleCollapseAll}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
                title={allCollapsed ? '展开所有' : '折叠所有'}
              >
                {allCollapsed ? (
                  <ChevronsDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronsUp className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* Sticky file header */}
        {stickyDiff && diffs.length > 1 && (
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1 bg-accent/30 border-b border-border/30 text-xs">
            <span className={`font-bold text-[10px] ${(changeBadge[stickyDiff.change] || changeBadge.modified).color} px-1 rounded`}>
              {(changeBadge[stickyDiff.change] || changeBadge.modified).label}
            </span>
            <span className="font-mono text-foreground truncate">
              {stickyDiff.newPath || stickyDiff.oldPath}
            </span>
            {stickyDiff.additions != null && stickyDiff.additions > 0 && (
              <span className="text-green-600 text-[10px] font-mono">+{stickyDiff.additions}</span>
            )}
            {stickyDiff.deletions != null && stickyDiff.deletions > 0 && (
              <span className="text-red-600 text-[10px] font-mono">-{stickyDiff.deletions}</span>
            )}
          </div>
        )}

        {/* Diff cards */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-3">
          {diffs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {showLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>加载变更中…</span>
                </div>
              ) : (
                '尚未进行任何更改'
              )}
            </div>
          ) : (
            diffs.map((diff, idx) => {
              const id = getDiffId(diff, idx);
              return (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) diffRefs.current.set(id, el);
                    else diffRefs.current.delete(id);
                  }}
                >
                  <DiffCard
                    diff={diff}
                    expanded={!collapsedIds.has(id)}
                    onToggle={() => toggle(id)}
                    selectedAttempt={workspace ?? null}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right: Changes directory sidebar */}
      {diffs.length > 0 && (
        <div
          className={`shrink-0 border-l border-border bg-muted/20 flex flex-col ${
            sidebarCollapsed ? 'w-8' : 'w-56'
          }`}
        >
          {sidebarCollapsed ? (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="h-full flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="展开文件目录"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground">
                  Changes
                </span>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground"
                  title="收起"
                >
                  <ChevronDown className="h-3 w-3 -rotate-90" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                <DiffFileTree
                  files={diffs.map((diff, idx) => {
                    const id = getDiffId(diff, idx);
                    const badge = changeBadge[diff.change] || changeBadge.modified;
                    return {
                      id,
                      path: diff.newPath || diff.oldPath || id,
                      badge,
                      additions: diff.additions,
                      deletions: diff.deletions,
                    };
                  })}
                  onFileClick={scrollToFile}
                />
              </div>
              {/* Summary footer */}
              <div className="shrink-0 px-2 py-1.5 border-t border-border text-[10px] text-muted-foreground">
                {fileCount} 个文件 ·{' '}
                <span className="text-green-600">+{added}</span>{' '}
                <span className="text-red-600">-{deleted}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default DockviewDiffsReviewPanel;
