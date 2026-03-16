import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  attemptsApi,
  type CommitGraphNode,
  type CommitGraphResult,
} from '@/lib/api';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

const ROW_HEIGHT = 32;
const LANE_WIDTH = 16;
const NODE_RADIUS = 4;
const MERGE_BASE_RADIUS = 6;

const COLORS = {
  currentBranch: 'var(--commit-graph-current, #3B82F6)',
  targetBranch: 'var(--commit-graph-target, #9CA3AF)',
  mergeBase: 'var(--commit-graph-merge-base, #F59E0B)',
};

interface CommitGraphProps {
  workspaceId: string;
  repoId: string;
}

interface LaneNode extends CommitGraphNode {
  lane: number;
  y: number;
  isMergeBase: boolean;
}

function assignLanes(graph: CommitGraphResult): LaneNode[] {
  const mergeBaseHash = graph.merge_base;
  return graph.nodes.map((node, idx) => ({
    ...node,
    lane: node.is_current_branch ? 0 : 1,
    y: idx * ROW_HEIGHT + ROW_HEIGHT / 2,
    isMergeBase: node.full_hash === mergeBaseHash,
  }));
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

export function CommitGraph({ workspaceId, repoId }: CommitGraphProps) {
  const { data: graph, isLoading } = useQuery({
    queryKey: ['commit-graph', workspaceId, repoId],
    queryFn: () => attemptsApi.getCommitGraph(workspaceId, repoId),
    enabled: !!workspaceId && !!repoId,
    refetchInterval: 10000,
  });

  const { openOrFocusPanel } = usePanelActionsContext();

  const laneNodes = useMemo(
    () => (graph ? assignLanes(graph) : []),
    [graph]
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, LaneNode>();
    for (const node of laneNodes) {
      map.set(node.full_hash, node);
    }
    return map;
  }, [laneNodes]);

  const handleCommitClick = useCallback(
    (_node: LaneNode) => {
      // Open the full diff review panel for the current workspace.
      // TODO: In v2, open a commit-specific diff panel instead.
      openOrFocusPanel('diffs', 'Diffs');
    },
    [openOrFocusPanel]
  );

  if (isLoading) {
    return (
      <div className="text-xs text-muted-foreground py-2">加载提交图...</div>
    );
  }

  if (!graph || laneNodes.length === 0) {
    return null;
  }

  const svgWidth = LANE_WIDTH * 3;
  const totalHeight = laneNodes.length * ROW_HEIGHT;

  return (
    <div className="border-t border-border pt-2 mt-2">
      <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
        提交图
        <span className="text-[10px] font-normal">
          (
          <span style={{ color: COLORS.currentBranch }}>
            {graph.current_branch}
          </span>
          {' vs '}
          <span style={{ color: COLORS.targetBranch }}>
            {graph.target_branch}
          </span>
          )
        </span>
      </div>
      <div className="max-h-80 overflow-auto">
        <div className="relative" style={{ minHeight: totalHeight }}>
          {/* SVG lanes */}
          <svg
            className="absolute left-0 top-0"
            width={svgWidth}
            height={totalHeight}
            style={{ pointerEvents: 'none' }}
          >
            {/* Connecting lines */}
            {laneNodes.map((node) =>
              node.parents.map((parentHash) => {
                const parent = nodeMap.get(parentHash);
                if (!parent) return null;
                const x1 = node.lane * LANE_WIDTH + LANE_WIDTH / 2;
                const y1 = node.y;
                const x2 = parent.lane * LANE_WIDTH + LANE_WIDTH / 2;
                const y2 = parent.y;

                if (x1 === x2) {
                  return (
                    <line
                      key={`${node.full_hash}-${parentHash}`}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={
                        node.is_current_branch
                          ? COLORS.currentBranch
                          : COLORS.targetBranch
                      }
                      strokeWidth={1.5}
                      opacity={0.5}
                    />
                  );
                } else {
                  const midY = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${node.full_hash}-${parentHash}`}
                      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      fill="none"
                      stroke={
                        node.is_current_branch
                          ? COLORS.currentBranch
                          : COLORS.targetBranch
                      }
                      strokeWidth={1.5}
                      opacity={0.5}
                    />
                  );
                }
              })
            )}

            {/* Commit nodes */}
            {laneNodes.map((node) => {
              const cx = node.lane * LANE_WIDTH + LANE_WIDTH / 2;
              const cy = node.y;
              const color = node.isMergeBase
                ? COLORS.mergeBase
                : node.is_current_branch
                  ? COLORS.currentBranch
                  : COLORS.targetBranch;
              const radius = node.isMergeBase
                ? MERGE_BASE_RADIUS
                : NODE_RADIUS;

              return (
                <g key={node.full_hash}>
                  <circle cx={cx} cy={cy} r={radius} fill={color} />
                  {node.isMergeBase && (
                    <>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={radius - 2}
                        fill="var(--background, #fff)"
                      />
                      <circle cx={cx} cy={cy} r={2} fill={color} />
                    </>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Commit info rows */}
          {laneNodes.map((node) => (
            <div
              key={node.full_hash}
              className="flex items-center hover:bg-accent/30 cursor-pointer group"
              style={{ height: ROW_HEIGHT, paddingLeft: svgWidth + 4 }}
              onClick={() => handleCommitClick(node)}
              title={`${node.full_hash}\n${node.message}\n${node.author}`}
            >
              <span className="text-[10px] font-mono text-muted-foreground w-14 shrink-0 group-hover:text-foreground">
                {node.hash}
              </span>
              <span className="text-xs truncate flex-1 min-w-0 text-foreground">
                {node.message}
              </span>
              {node.refs.length > 0 &&
                node.refs.map((refName) => (
                  <span
                    key={refName}
                    className="shrink-0 ml-1 text-[9px] px-1 py-0.5 rounded bg-accent text-accent-foreground font-mono"
                  >
                    {refName}
                  </span>
                ))}
              <span className="shrink-0 ml-2 text-[10px] text-muted-foreground whitespace-nowrap">
                {node.author}
              </span>
              <span className="shrink-0 ml-2 text-[10px] text-muted-foreground whitespace-nowrap">
                {formatTimeAgo(node.timestamp)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
