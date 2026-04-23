import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  GitCompare,
  ChevronsUp,
  ChevronsDown,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  User,
  Calendar,
  Hash,
  X,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttempt } from '@/hooks/useAttempt';
import { useDiffStream } from '@/hooks/useDiffStream';
import { useDiffSummary } from '@/hooks/useDiffSummary';
import DiffCard from '@/components/DiffCard';
import DiffViewSwitch from '@/components/DiffViewSwitch';
import { DiffFileTree } from '@/components/diff/DiffFileTree';
import { useCommitDiffStore } from '@/stores/useCommitDiffStore';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import type { Diff, DiffChangeKind } from 'shared/types';

type DiffCollapseDefaults = Record<DiffChangeKind, boolean>;

const DEFAULT_COLLAPSE: DiffCollapseDefaults = {
  added: true,
  deleted: true,
  modified: true,
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
  added: {
    label: 'A',
    color: 'text-green-600 bg-green-100 dark:bg-green-900/40',
  },
  deleted: { label: 'D', color: 'text-red-600 bg-red-100 dark:bg-red-900/40' },
  modified: {
    label: 'M',
    color: 'text-blue-600 bg-blue-100 dark:bg-blue-900/40',
  },
  renamed: {
    label: 'R',
    color: 'text-yellow-600 bg-yellow-100 dark:bg-yellow-900/40',
  },
  copied: {
    label: 'C',
    color: 'text-purple-600 bg-purple-100 dark:bg-purple-900/40',
  },
  permissionChange: {
    label: 'P',
    color: 'text-gray-600 bg-gray-100 dark:bg-gray-900/40',
  },
};

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function DockviewDiffsReviewPanel() {
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const effectiveAttemptId = activeWorktreeId ?? routeWorkspaceId ?? undefined;
  const { data: workspace } = useAttempt(effectiveAttemptId);
  const attemptId = workspace?.id ?? effectiveAttemptId ?? null;

  // Commit diff mode from store
  const {
    commitSha,
    commitInfo,
    commitDiffs,
    isLoading: commitLoading,
    clearCommitDiff,
  } = useCommitDiffStore();
  const isCommitMode = !!commitSha;
  const targetPath = useGitDiffNavigationStore((state) => state.targetPath);
  const targetToken = useGitDiffNavigationStore((state) => state.requestToken);
  const clearTargetPath = useGitDiffNavigationStore(
    (state) => state.clearTargetPath
  );

  // Worktree diff mode (existing functionality)
  const {
    diffs: worktreeDiffs,
    error,
    isInitialized,
  } = useDiffStream(attemptId, true);
  const {
    fileCount: wtFileCount,
    added: wtAdded,
    deleted: wtDeleted,
  } = useDiffSummary(attemptId);

  // Select data source based on mode
  const diffs = isCommitMode ? commitDiffs : worktreeDiffs;

  // Compute stats for commit mode
  const fileCount = isCommitMode ? commitDiffs.length : wtFileCount;
  const added = isCommitMode
    ? commitDiffs.reduce((sum, d) => sum + (d.additions ?? 0), 0)
    : wtAdded;
  const deleted = isCommitMode
    ? commitDiffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0)
    : wtDeleted;

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [stickyFileId, setStickyFileId] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  // Reset collapse state when switching modes or commit
  useEffect(() => {
    setCollapsedIds(new Set());
    setProcessedIds(new Set());
    setStickyFileId(null);
    setSelectedFileId(null);
  }, [commitSha]);

  // Safety timeout: if not initialized within 5s, stop showing spinner
  useEffect(() => {
    if (isCommitMode || isInitialized || diffs.length > 0) {
      setLoadingTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setLoadingTimedOut(true), 5000);
    return () => clearTimeout(timer);
  }, [isCommitMode, isInitialized, diffs.length]);

  const showLoading = isCommitMode
    ? commitLoading
    : !isInitialized && !loadingTimedOut && diffs.length === 0;

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
          DEFAULT_COLLAPSE[diff.change] || exceedsMax(diff, COLLAPSE_MAX_LINES)
      )
      .map(({ id }) => id);

    setProcessedIds((prev) => new Set([...prev, ...newIds]));
    if (toCollapse.length > 0) {
      setCollapsedIds((prev) => new Set([...prev, ...toCollapse]));
    }
  }, [diffs, processedIds]);

  const ids = useMemo(() => diffs.map((d, i) => getDiffId(d, i)), [diffs]);

  const toggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const allCollapsed = collapsedIds.size === diffs.length && diffs.length > 0;

  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(allCollapsed ? new Set() : new Set(ids));
  }, [allCollapsed, ids]);

  const scrollToFile = useCallback(
    (id: string, behavior: ScrollBehavior = 'smooth') => {
      const el = diffRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ behavior, block: 'start' });
        setSelectedFileId(id);
        setCollapsedIds((prev) => {
          if (prev.has(id)) {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }
          return prev;
        });
      }
    },
    []
  );

  useEffect(() => {
    if (!targetPath || diffs.length === 0) return;

    const normalizedTargetPath = targetPath.replace(/\\/g, '/');
    const targetEntryIndex = diffs.findIndex((diff) => {
      const candidate = (diff.newPath || diff.oldPath || '').replace(
        /\\/g,
        '/'
      );
      return candidate === normalizedTargetPath;
    });

    if (targetEntryIndex < 0) return;

    const targetId = getDiffId(diffs[targetEntryIndex], targetEntryIndex);
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    scrollToFile(targetId, 'auto');
    clearTargetPath();
  }, [
    clearTargetPath,
    diffs,
    scrollToFile,
    sidebarCollapsed,
    targetPath,
    targetToken,
  ]);

  // Sticky file header tracking via IntersectionObserver
  // Tracks the last diff element that scrolled past the top of the viewport
  const lastVisibleIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || diffs.length === 0) return;

    // Track which elements are above the viewport threshold (top 40px of container)
    const aboveThreshold = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const ioEntry of entries) {
          const id = (ioEntry.target as HTMLElement).dataset.diffId;
          if (!id) continue;

          // When the element's top edge is above the rootMargin boundary,
          // it means the element has scrolled past the top => it's the "sticky" one
          if (!ioEntry.isIntersecting) {
            // Element is fully above the threshold line
            const rect = ioEntry.boundingClientRect;
            if (rect.top < 0) {
              aboveThreshold.add(id);
            } else {
              aboveThreshold.delete(id);
            }
          } else {
            aboveThreshold.delete(id);
          }
        }

        // Find the last element (by document order) that is above threshold
        let foundId: string | null = null;
        for (const [id] of diffRefs.current) {
          if (aboveThreshold.has(id)) {
            foundId = id;
          }
        }

        if (foundId !== lastVisibleIdRef.current) {
          lastVisibleIdRef.current = foundId;
          setStickyFileId(foundId);
        }
      },
      {
        root: container,
        // A thin margin at the very top of the scroll container
        rootMargin: '-40px 0px 0px 0px',
        threshold: [0, 1],
      }
    );

    // Observe all current diff elements
    for (const [, el] of diffRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [diffs]);

  const stickyDiff = useMemo(() => {
    if (!stickyFileId) return null;
    const idx = ids.indexOf(stickyFileId);
    if (idx === -1) return null;
    return diffs[idx];
  }, [stickyFileId, ids, diffs]);

  if (!isCommitMode && !attemptId) {
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

  if (!isCommitMode && error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 m-4">
        <div className="text-red-800 dark:text-red-300 text-sm">{`加载差异失败：${error}`}</div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex gap-2 p-2" data-panel="diffs">
      {/* Left: Diff content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-background">
        {/* Commit info header (only in commit mode) */}
        {isCommitMode && commitInfo && (
          <div className="shrink-0 border-b border-border bg-muted/20">
            <div className="px-3 py-2.5 space-y-1.5">
              {/* Title row with close button */}
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-foreground leading-snug">
                    {commitInfo.summary}
                  </h3>
                </div>
                <button
                  onClick={clearCommitDiff}
                  className="shrink-0 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="返回工作区差异"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Body (if any) */}
              {commitInfo.body && (
                <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-20 overflow-y-auto">
                  {commitInfo.body}
                </div>
              )}

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  <span className="text-foreground/80">
                    {commitInfo.author}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <Hash className="h-3 w-3" />
                  <button
                    className="font-mono text-foreground/80 hover:text-foreground transition-colors"
                    onClick={() =>
                      navigator.clipboard.writeText(commitInfo.sha)
                    }
                    title="Copy full SHA"
                  >
                    {commitInfo.sha.slice(0, 12)}
                  </button>
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  <span>{formatTimestamp(commitInfo.timestamp)}</span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Header toolbar */}
        {diffs.length > 0 && (
          <div className="shrink-0 flex items-center gap-2 px-3 h-[33px] border-b border-border bg-muted/30">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <span>{fileCount} 个文件已更改</span>
              <span className="font-mono text-green-600 dark:text-green-500">
                +{added}
              </span>
              <span className="font-mono text-red-600 dark:text-red-500">
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
            <span
              className={`font-bold text-[10px] ${(changeBadge[stickyDiff.change] || changeBadge.modified).color} px-1 rounded`}
            >
              {(changeBadge[stickyDiff.change] || changeBadge.modified).label}
            </span>
            <span className="font-mono text-foreground truncate">
              {stickyDiff.newPath || stickyDiff.oldPath}
            </span>
            {stickyDiff.additions != null && stickyDiff.additions > 0 && (
              <span className="text-green-600 text-[10px] font-mono">
                +{stickyDiff.additions}
              </span>
            )}
            {stickyDiff.deletions != null && stickyDiff.deletions > 0 && (
              <span className="text-red-600 text-[10px] font-mono">
                -{stickyDiff.deletions}
              </span>
            )}
          </div>
        )}

        {/* Diff cards */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto px-3 pb-3"
        >
          {diffs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {showLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>
                    {isCommitMode ? '加载提交差异中…' : '加载变更中…'}
                  </span>
                </div>
              ) : isCommitMode ? (
                '该提交无文件变更'
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
                  data-diff-id={id}
                  ref={(el) => {
                    if (el) diffRefs.current.set(id, el);
                    else diffRefs.current.delete(id);
                  }}
                >
                  <DiffCard
                    diff={diff}
                    expanded={!collapsedIds.has(id)}
                    onToggle={() => toggle(id)}
                    selectedAttempt={isCommitMode ? null : (workspace ?? null)}
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
          className={`shrink-0 overflow-hidden rounded-xl border border-border/60 bg-muted/20 flex flex-col transition-[width] duration-150 ${
            sidebarCollapsed ? 'w-8' : 'w-60'
          }`}
        >
          {sidebarCollapsed ? (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 border-b border-border"
              title="展开文件目录"
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
            </button>
          ) : (
            <>
              <div className="flex items-center h-[33px] px-2.5 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground flex-1">
                  {isCommitMode ? 'Changed Files' : 'Changes'}
                </span>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground"
                  title="收起"
                >
                  <PanelRightClose className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                <DiffFileTree
                  key={`diff-tree-${targetToken}`}
                  files={diffs.map((diff, idx) => {
                    const id = getDiffId(diff, idx);
                    const badge =
                      changeBadge[diff.change] || changeBadge.modified;
                    return {
                      id,
                      path: diff.newPath || diff.oldPath || id,
                      badge,
                      additions: diff.additions,
                      deletions: diff.deletions,
                    };
                  })}
                  activeFileId={selectedFileId}
                  onFileClick={(id) => scrollToFile(id)}
                />
              </div>
              {/* Summary footer */}
              <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-t border-border text-[10px] text-muted-foreground">
                <span>{fileCount} 个文件</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-green-600 font-mono">+{added}</span>
                <span className="text-red-600 font-mono">-{deleted}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default DockviewDiffsReviewPanel;
