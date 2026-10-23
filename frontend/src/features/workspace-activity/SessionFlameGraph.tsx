import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Copy,
  GitFork,
  Search,
  Settings,
  User,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { MessageTurn, TimelineRow } from 'shared/types';
import { cn } from '@/lib/utils';
import {
  buildTrajectoryRecords,
  deriveTrajectoryTimeline,
  formatDurationMs,
  trajectoryTimelineFocusIndexes,
  type ActivityChart,
  type TrajectoryRecord,
  type TrajectoryRecordKind,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
  type TrajectoryUsage,
} from './workspaceActivityModel';

type DetailTabId =
  | 'summary'
  | 'preview'
  | 'payload'
  | 'result'
  | 'usage'
  | 'timing';

type DisplayRow = {
  key: string;
  record: TrajectoryRecord;
  turnStart: boolean;
  turnEnd: boolean;
  collapsedSummary?: string;
  collapsedKind?: 'turn' | 'calls';
};

const KIND_ICON: Record<TrajectoryRecordKind, LucideIcon> = {
  system: Settings,
  user: User,
  assistant: Bot,
  tool: Wrench,
  subtool: GitFork,
  notice: AlertCircle,
};

const KIND_BADGE_CLASS: Record<TrajectoryRecordKind, string> = {
  system:
    'border border-[var(--border-subtle)] bg-[var(--surface-control)] text-muted-foreground',
  user: 'border border-primary/30 bg-primary/10 text-foreground',
  assistant:
    'border border-[hsl(var(--success)/0.45)] bg-[hsl(var(--success)/0.14)] text-[hsl(var(--success))]',
  tool: 'border border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))]',
  subtool: 'border border-primary/40 bg-primary/12 text-foreground',
  notice:
    'border border-[hsl(var(--destructive)/0.45)] bg-[hsl(var(--destructive)/0.14)] text-[hsl(var(--destructive))]',
};

const KIND_SPAN_CLASS: Record<TrajectoryRecordKind, string> = {
  system: 'bg-muted-foreground/70',
  user: 'bg-primary/80',
  assistant: 'bg-[hsl(var(--success)/0.85)]',
  tool: 'bg-[hsl(var(--warning)/0.85)]',
  subtool: 'bg-primary/75',
  notice: 'bg-[hsl(var(--destructive)/0.85)]',
};

function formatLocalTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`;
}

function formatPrettyPayload(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function orderedRange(left: number, right: number): TrajectoryTimeRange {
  return left <= right
    ? { start: left, end: right }
    : { start: right, end: left };
}

function CopySnippetButton({
  value,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="raised-control inline-flex h-6 items-center gap-1 rounded-[calc(var(--radius)-6px)] px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-[hsl(var(--success))]" />
          <span>{copiedLabel}</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          <span>{copyLabel}</span>
        </>
      )}
    </button>
  );
}

function StartedAtToggle({
  startedAtMs,
  notRecordedLabel,
  localTimeTitle,
  unixTimeTitle,
}: {
  startedAtMs: number | null;
  notRecordedLabel: string;
  localTimeTitle: string;
  unixTimeTitle: string;
}) {
  const [showUnix, setShowUnix] = useState(false);
  if (startedAtMs == null || !Number.isFinite(startedAtMs)) {
    return (
      <dd className="font-mono text-xs text-muted-foreground">
        {notRecordedLabel}
      </dd>
    );
  }
  return (
    <dd>
      <button
        type="button"
        title={showUnix ? localTimeTitle : unixTimeTitle}
        className="rounded px-1 py-0.5 font-mono text-xs tabular-nums text-foreground transition-colors hover:bg-[var(--surface-control-hover)]"
        onClick={() => setShowUnix((prev) => !prev)}
      >
        {showUnix
          ? (startedAtMs / 1_000).toFixed(3)
          : formatLocalTimestamp(startedAtMs)}
      </button>
    </dd>
  );
}

function UsageDefinitionList({
  usage,
  t,
}: {
  usage: TrajectoryUsage | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (!usage) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('workspaceActivity.trajectoryUsageNotReported')}
      </p>
    );
  }
  const totalInput =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

  return (
    <dl className="space-y-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t('workspaceActivity.trajectoryInputTokens')}
        </dt>
        <dd className="font-mono tabular-nums text-foreground">
          {totalInput} tok
        </dd>
      </div>
      {usage.cacheReadTokens > 0 ? (
        <div className="flex items-center justify-between gap-2 pl-3">
          <dt className="text-muted-foreground">
            {t('workspaceActivity.trajectoryCacheRead')}
          </dt>
          <dd className="font-mono tabular-nums text-muted-foreground">
            {usage.cacheReadTokens} tok
          </dd>
        </div>
      ) : null}
      {usage.cacheWriteTokens > 0 ? (
        <div className="flex items-center justify-between gap-2 pl-3">
          <dt className="text-muted-foreground">
            {t('workspaceActivity.trajectoryCacheWrite')}
          </dt>
          <dd className="font-mono tabular-nums text-muted-foreground">
            {usage.cacheWriteTokens} tok
          </dd>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t('workspaceActivity.trajectoryOutputTokens')}
        </dt>
        <dd className="font-mono tabular-nums text-foreground">
          {usage.outputTokens} tok
        </dd>
      </div>
      {usage.contextUsedTokens != null ? (
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t('workspaceActivity.trajectoryContextWindow')}
          </dt>
          <dd className="font-mono tabular-nums text-foreground">
            {usage.contextWindowMaxTokens != null
              ? `${usage.contextUsedTokens} / ${usage.contextWindowMaxTokens} tok`
              : `${usage.contextUsedTokens} tok`}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export function SessionFlameGraph({
  charts = [],
  turns = [],
  rows = [],
  failedTurnIds = [],
  onSelectSession,
}: {
  charts?: ActivityChart[];
  turns?: MessageTurn[];
  rows?: TimelineRow[];
  failedTurnIds?: string[];
  onSelectSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation('panels');
  const records = useMemo(
    () =>
      buildTrajectoryRecords({
        turns,
        rows,
        charts,
        failedTurnIds,
      }),
    [charts, failedTurnIds, rows, turns]
  );

  const hasAnyTimed = useMemo(
    () =>
      records.some((record) => record.timed && (record.durationMs ?? 0) > 0),
    [records]
  );
  const [actualDuration, setActualDuration] = useState<boolean>(true);
  const timelineMode: TrajectoryTimelineMode =
    actualDuration && hasAnyTimed ? 'duration' : 'sequence';

  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  const [collapsedAssistants, setCollapsedAssistants] = useState<
    ReadonlySet<number>
  >(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [timelineRange, setTimelineRange] =
    useState<TrajectoryTimeRange | null>(null);
  const [draftRange, setDraftRange] = useState<TrajectoryTimeRange | null>(
    null
  );
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTabId>('summary');
  const [inspectorWidth, setInspectorWidth] = useState<number>(320);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const dragRef = useRef<{
    pointerId: number;
    anchorTime: number;
    anchorClientX: number;
    recordIndex: number | null;
  } | null>(null);

  const kindLabel = useCallback(
    (kind: TrajectoryRecordKind): string => {
      switch (kind) {
        case 'system':
          return t('workspaceActivity.trajectoryKindSystem');
        case 'user':
          return t('workspaceActivity.trajectoryKindUser');
        case 'assistant':
          return t('workspaceActivity.trajectoryKindAssistant');
        case 'tool':
          return t('workspaceActivity.trajectoryKindTool');
        case 'subtool':
          return t('workspaceActivity.trajectoryKindSubtool');
        case 'notice':
          return t('workspaceActivity.trajectoryKindNotice');
      }
    },
    [t]
  );

  const collapsibleTurnIds = useMemo(() => {
    const countsByTurn = new Map<number, number>();
    for (const r of records) {
      if (r.turn == null) continue;
      countsByTurn.set(r.turn, (countsByTurn.get(r.turn) ?? 0) + 1);
    }
    return Array.from(countsByTurn.entries())
      .filter(([, count]) => count > 1)
      .map(([turn]) => turn);
  }, [records]);

  const allTurnsCollapsed =
    collapsibleTurnIds.length > 0 &&
    collapsibleTurnIds.every((turn) => collapsedTurns.has(turn));

  const collapsibleAssistantIndexes = useMemo(() => {
    const result: number[] = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r?.kind !== 'assistant') continue;
      const next = records[i + 1];
      if (next?.kind === 'tool' || next?.kind === 'subtool') {
        result.push(r.index);
      }
    }
    return result;
  }, [records]);

  const allCallsCollapsed =
    collapsibleAssistantIndexes.length > 0 &&
    collapsibleAssistantIndexes.every((idx) => collapsedAssistants.has(idx));

  const toggleAllTurns = () => {
    setCollapsedTurns(() =>
      allTurnsCollapsed ? new Set() : new Set(collapsibleTurnIds)
    );
  };

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  };

  const toggleAllCalls = () => {
    setCollapsedAssistants(() =>
      allCallsCollapsed ? new Set() : new Set(collapsibleAssistantIndexes)
    );
  };

  const toggleAssistantCalls = (assistantIndex: number) => {
    setCollapsedAssistants((prev) => {
      const next = new Set(prev);
      if (next.has(assistantIndex)) next.delete(assistantIndex);
      else next.add(assistantIndex);
      return next;
    });
  };

  const searchMatchIndexes = useMemo<ReadonlySet<number> | null>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set<number>();
    for (const r of records) {
      const haystack = [
        r.title,
        r.resultPreview,
        r.fullText,
        r.thinkingText,
        r.toolName,
        r.inputDetail,
        r.outputDetail,
        r.model,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (haystack.includes(q)) {
        matches.add(r.index);
      }
    }
    return matches;
  }, [records, searchQuery]);

  const timelineModel = useMemo(
    () => deriveTrajectoryTimeline(records, timelineMode),
    [records, timelineMode]
  );

  const activeRange = draftRange ?? timelineRange;
  const timelineFocusIndexes = useMemo<ReadonlySet<number> | null>(() => {
    if (!activeRange) return null;
    return trajectoryTimelineFocusIndexes(records, activeRange, timelineMode);
  }, [activeRange, records, timelineMode]);

  const displayRows = useMemo<DisplayRow[]>(() => {
    let base = records;
    if (searchMatchIndexes !== null) {
      base = base.filter((r) => searchMatchIndexes.has(r.index));
    }
    if (timelineFocusIndexes !== null && searchMatchIndexes === null) {
      base = base.filter((r) => timelineFocusIndexes.has(r.index));
    }

    const afterTurnCollapse: DisplayRow[] = [];
    const byTurn = new Map<number, TrajectoryRecord[]>();
    for (const r of base) {
      if (r.turn == null) continue;
      const list = byTurn.get(r.turn) ?? [];
      list.push(r);
      byTurn.set(r.turn, list);
    }

    const emittedCollapsedTurns = new Set<number>();
    for (const r of base) {
      if (
        r.turn != null &&
        collapsedTurns.has(r.turn) &&
        searchMatchIndexes === null &&
        timelineFocusIndexes === null
      ) {
        if (emittedCollapsedTurns.has(r.turn)) continue;
        emittedCollapsedTurns.add(r.turn);
        const turnRecords = byTurn.get(r.turn) ?? [r];
        const first = turnRecords[0] ?? r;
        const rest = turnRecords.slice(1);
        const stepsCount = new Set(
          rest.filter((item) => item.step > 0).map((item) => item.step)
        ).size;
        const toolsCount = rest.filter(
          (item) => item.kind === 'tool' || item.kind === 'subtool'
        ).length;
        afterTurnCollapse.push({
          key: `row:${first.index}`,
          record: first,
          turnStart: true,
          turnEnd: rest.length === 0,
        });
        if (rest.length > 0) {
          afterTurnCollapse.push({
            key: `collapsed-turn:${r.turn}`,
            record: first,
            turnStart: false,
            turnEnd: true,
            collapsedKind: 'turn',
            collapsedSummary: t(
              'workspaceActivity.trajectoryCollapsedSummary',
              {
                steps: Math.max(1, stepsCount),
                tools: toolsCount,
              }
            ),
          });
        }
        continue;
      }

      afterTurnCollapse.push({
        key: `row:${r.index}`,
        record: r,
        turnStart: r.turnStart,
        turnEnd: r.turnEnd,
      });
    }

    if (
      collapsedAssistants.size === 0 ||
      searchMatchIndexes !== null ||
      timelineFocusIndexes !== null
    ) {
      return afterTurnCollapse;
    }

    const out: DisplayRow[] = [];
    for (let i = 0; i < afterTurnCollapse.length; i++) {
      const current = afterTurnCollapse[i];
      if (!current) continue;
      out.push(current);
      if (
        current.collapsedSummary ||
        current.record.kind !== 'assistant' ||
        !collapsedAssistants.has(current.record.index)
      ) {
        continue;
      }
      const calls: DisplayRow[] = [];
      for (let j = i + 1; j < afterTurnCollapse.length; j++) {
        const candidate = afterTurnCollapse[j];
        if (
          !candidate ||
          candidate.collapsedSummary ||
          (candidate.record.kind !== 'tool' &&
            candidate.record.kind !== 'subtool')
        ) {
          break;
        }
        calls.push(candidate);
      }
      if (calls.length === 0) continue;
      const toolNames = Array.from(
        new Set(
          calls
            .map((c) => c.record.toolName || c.record.title.split(' ')[0])
            .filter(Boolean)
        )
      );
      const countText = t('workspaceActivity.trajectoryCollapsedCallsSummary', {
        count: calls.length,
      });
      const lastCall = calls[calls.length - 1];
      out[out.length - 1] = { ...current, turnEnd: false };
      out.push({
        key: `collapsed-calls:${current.record.index}`,
        record: current.record,
        turnStart: false,
        turnEnd: lastCall?.turnEnd ?? false,
        collapsedKind: 'calls',
        collapsedSummary:
          toolNames.length > 0
            ? `${countText} · ${toolNames.slice(0, 4).join(', ')}`
            : countText,
      });
      i += calls.length;
    }

    return out;
  }, [
    collapsedAssistants,
    collapsedTurns,
    records,
    searchMatchIndexes,
    t,
    timelineFocusIndexes,
  ]);

  const selectedRecord = useMemo(
    () =>
      selectedIndex == null
        ? null
        : (records.find((r) => r.index === selectedIndex) ?? null),
    [records, selectedIndex]
  );

  const selectedTurn = selectedRecord?.turn ?? null;

  const availableTabs = useMemo<
    Array<{ id: DetailTabId; label: string }>
  >(() => {
    if (!selectedRecord) return [];
    if (selectedRecord.kind === 'assistant') {
      return [
        {
          id: 'summary',
          label: t('workspaceActivity.trajectoryTabSummary'),
        },
        {
          id: 'preview',
          label: t('workspaceActivity.trajectoryTabPreview'),
        },
        { id: 'usage', label: t('workspaceActivity.trajectoryTabUsage') },
        { id: 'timing', label: t('workspaceActivity.trajectoryTabTiming') },
      ];
    }
    if (selectedRecord.kind === 'tool' || selectedRecord.kind === 'subtool') {
      return [
        {
          id: 'summary',
          label: t('workspaceActivity.trajectoryTabSummary'),
        },
        {
          id: 'payload',
          label: t('workspaceActivity.trajectoryTabPayload'),
        },
        { id: 'result', label: t('workspaceActivity.trajectoryTabResult') },
        { id: 'timing', label: t('workspaceActivity.trajectoryTabTiming') },
      ];
    }
    return [
      { id: 'summary', label: t('workspaceActivity.trajectoryTabSummary') },
      { id: 'preview', label: t('workspaceActivity.trajectoryTabPreview') },
      { id: 'timing', label: t('workspaceActivity.trajectoryTabTiming') },
    ];
  }, [selectedRecord, t]);

  useEffect(() => {
    if (
      availableTabs.length > 0 &&
      !availableTabs.some((tab) => tab.id === activeTab)
    ) {
      setActiveTab('summary');
    }
  }, [activeTab, availableTabs]);

  const selectRecord = useCallback(
    (index: number, preferredTab?: DetailTabId) => {
      setSelectedIndex(index);
      if (preferredTab) {
        setActiveTab(preferredTab);
      }
      const rowEl = rowRefs.current.get(index);
      if (rowEl && typeof rowEl.scrollIntoView === 'function') {
        rowEl.scrollIntoView({ block: 'nearest' });
      }
    },
    []
  );

  const fullStart = timelineModel?.start ?? 0;
  const fullDuration = Math.max(
    1,
    (timelineModel?.end ?? 1) - (timelineModel?.start ?? 0)
  );
  const domainStart = viewport ? viewport.start : fullStart;
  const domainDuration = viewport
    ? Math.max(1, viewport.end - viewport.start)
    : fullDuration;

  useEffect(() => {
    const track = trackRef.current;
    if (!track || !timelineModel) return;
    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      const anchorFraction = clampFraction(
        (event.clientX - rect.left) / Math.max(1, rect.width)
      );
      const minZoom = timelineMode === 'sequence' ? 2 : 50;
      const nextDuration = Math.min(
        fullDuration,
        Math.max(
          Math.min(minZoom, fullDuration),
          domainDuration * Math.exp(event.deltaY * 0.0015)
        )
      );
      if (nextDuration >= fullDuration * 0.995) {
        setViewport(null);
        return;
      }
      const anchorTime = domainStart + anchorFraction * domainDuration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, fullStart),
        fullStart + fullDuration - nextDuration
      );
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    track.addEventListener('wheel', handleWheel, { passive: false });
    return () => track.removeEventListener('wheel', handleWheel);
  }, [
    domainDuration,
    domainStart,
    fullDuration,
    fullStart,
    timelineMode,
    timelineModel,
  ]);

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!timelineModel) return;
    if (event.button === 2) {
      setTimelineRange(null);
      setDraftRange(null);
      return;
    }
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = clampFraction(
      (event.clientX - rect.left) / Math.max(1, rect.width)
    );
    const anchorTime = domainStart + fraction * domainDuration;
    const targetEl =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-timeline-record-index]')
        : null;
    const recordIndex =
      targetEl?.dataset.timelineRecordIndex != null
        ? Number(targetEl.dataset.timelineRecordIndex)
        : null;

    dragRef.current = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      recordIndex: Number.isFinite(recordIndex) ? recordIndex : null,
    };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDraftRange({ start: anchorTime, end: anchorTime });
  };

  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = clampFraction(
      (event.clientX - rect.left) / Math.max(1, rect.width)
    );
    const pointTime = domainStart + fraction * domainDuration;
    setDraftRange(orderedRange(drag.anchorTime, pointTime));
  };

  const onTrackPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const isClick = Math.abs(event.clientX - drag.anchorClientX) < 4;
    setDraftRange(null);

    if (isClick) {
      if (drag.recordIndex != null) {
        setTimelineRange(null);
        selectRecord(drag.recordIndex);
      } else {
        setTimelineRange(null);
      }
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = clampFraction(
      (event.clientX - rect.left) / Math.max(1, rect.width)
    );
    const pointTime = domainStart + fraction * domainDuration;
    setTimelineRange(orderedRange(drag.anchorTime, pointTime));
  };

  const onTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && timelineRange !== null) {
      event.preventDefault();
      setTimelineRange(null);
    }
  };

  const visibleBrush = useMemo(() => {
    if (!activeRange || !timelineModel) return null;
    const start = clampFraction(
      (activeRange.start - domainStart) / domainDuration
    );
    const end = clampFraction((activeRange.end - domainStart) / domainDuration);
    return orderedRange(start, end);
  }, [activeRange, domainDuration, domainStart, timelineModel]);

  const untimedLabel = t('workspaceActivity.untimed');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] text-foreground">
      {/* 1. Sticky Trajectory Toolbar */}
      <div
        role="toolbar"
        aria-label={t('workspaceActivity.trajectoryToolbarAria')}
        className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-topbar)] px-2.5 py-1.5"
      >
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-label={
              actualDuration
                ? t('workspaceActivity.trajectoryUseEqualWidth')
                : t('workspaceActivity.trajectoryUseActualDuration')
            }
            aria-pressed={actualDuration}
            title={
              actualDuration
                ? t('workspaceActivity.trajectoryUseEqualWidth')
                : t('workspaceActivity.trajectoryUseActualDuration')
            }
            onClick={() => {
              setActualDuration((prev) => !prev);
              setTimelineRange(null);
              setViewport(null);
            }}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-[calc(var(--radius)-6px)] px-2 text-xs font-medium transition-colors',
              actualDuration
                ? 'bg-[var(--surface-active)] text-foreground'
                : 'text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground'
            )}
          >
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('workspaceActivity.trajectoryDuration')}</span>
          </button>

          <button
            type="button"
            aria-label={
              allTurnsCollapsed
                ? t('workspaceActivity.trajectoryExpandTurns')
                : t('workspaceActivity.trajectoryCollapseTurns')
            }
            aria-pressed={allTurnsCollapsed}
            title={
              allTurnsCollapsed
                ? t('workspaceActivity.trajectoryExpandTurns')
                : t('workspaceActivity.trajectoryCollapseTurns')
            }
            disabled={collapsibleTurnIds.length === 0}
            onClick={toggleAllTurns}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-[calc(var(--radius)-6px)] px-2 text-xs font-medium transition-colors disabled:opacity-40',
              allTurnsCollapsed
                ? 'bg-[var(--surface-active)] text-foreground'
                : 'text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground'
            )}
          >
            <span className="font-mono text-xs" aria-hidden="true">
              {allTurnsCollapsed ? '⊞' : '⊟'}
            </span>
            <span>{t('workspaceActivity.trajectoryTurns')}</span>
          </button>

          <button
            type="button"
            aria-label={
              allCallsCollapsed
                ? t('workspaceActivity.trajectoryExpandCalls')
                : t('workspaceActivity.trajectoryCollapseCalls')
            }
            aria-pressed={allCallsCollapsed}
            title={
              allCallsCollapsed
                ? t('workspaceActivity.trajectoryExpandCalls')
                : t('workspaceActivity.trajectoryCollapseCalls')
            }
            disabled={collapsibleAssistantIndexes.length === 0}
            onClick={toggleAllCalls}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-[calc(var(--radius)-6px)] px-2 text-xs font-medium transition-colors disabled:opacity-40',
              allCallsCollapsed
                ? 'bg-[var(--surface-active)] text-foreground'
                : 'text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground'
            )}
          >
            <span className="font-mono text-xs" aria-hidden="true">
              {allCallsCollapsed ? '⊞' : '⊟'}
            </span>
            <span>{t('workspaceActivity.trajectoryCalls')}</span>
          </button>

          {timelineRange !== null ? (
            <button
              type="button"
              onClick={() => setTimelineRange(null)}
              className="inline-flex h-7 items-center gap-1 rounded-[calc(var(--radius)-6px)] bg-primary/15 px-2 text-xs font-medium text-foreground transition-colors hover:bg-primary/25"
            >
              <span>{t('workspaceActivity.trajectoryClearSelection')}</span>
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {/* Single control frame search input */}
        <div className="raised-control flex h-7 w-40 items-center gap-1.5 rounded-[var(--radius)] px-2.5 focus-within:ring-1 focus-within:ring-ring">
          <Search
            className="h-3 w-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label={t('workspaceActivity.trajectorySearch')}
            placeholder={t('workspaceActivity.trajectorySearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-foreground shadow-none placeholder:text-muted-foreground focus:outline-none focus:ring-0"
          />
        </div>
      </div>

      {/* 2. Fixed 3-Lane Overview Timeline (Chrome Network style) */}
      <section
        role="region"
        aria-label={t('workspaceActivity.trajectoryTimelineAria')}
        className="shrink-0 select-none border-b border-[var(--border-subtle)] bg-[var(--surface-control)]"
      >
        <div className="grid h-[52px] grid-cols-[3.25rem_minmax(0,1fr)] overflow-hidden">
          <div
            aria-hidden="true"
            className="relative border-r border-[var(--border-subtle)] pr-1.5 text-right text-xs leading-none text-muted-foreground"
          >
            <span className="absolute right-1.5 top-[5px]">
              {t('workspaceActivity.trajectoryLaneInput')}
            </span>
            <span className="absolute right-1.5 top-[20px]">
              {t('workspaceActivity.trajectoryLaneModel')}
            </span>
            <span className="absolute right-1.5 top-[35px]">
              {t('workspaceActivity.trajectoryLaneTools')}
            </span>
          </div>

          <div
            ref={trackRef}
            tabIndex={0}
            aria-label={t('workspaceActivity.trajectoryTimelineOverviewAria')}
            onKeyDown={onTrackKeyDown}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onDoubleClick={() => {
              setTimelineRange(null);
              setViewport(null);
            }}
            onContextMenu={(e) => e.preventDefault()}
            className="relative overflow-hidden cursor-crosshair focus:outline-none"
          >
            {visibleBrush !== null ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 z-10 border-x-2 border-primary bg-primary/15"
                style={{
                  left: `${visibleBrush.start * 100}%`,
                  width: `${Math.max(0.5, (visibleBrush.end - visibleBrush.start) * 100)}%`,
                }}
              />
            ) : null}

            {/* Turn boundary hairlines */}
            {timelineModel?.turnBoundaries.map((boundary) => {
              const leftPct =
                ((boundary.time - domainStart) / domainDuration) * 100;
              if (leftPct < 0 || leftPct > 100) return null;
              return (
                <span
                  key={`turn-boundary:${boundary.turn}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[var(--border-subtle)]"
                  style={{ left: `${leftPct}%` }}
                />
              );
            })}

            {/* 3 Semantic Lanes */}
            {timelineModel?.spans.map((span) => {
              const leftPct =
                ((span.start - domainStart) / domainDuration) * 100;
              const widthPct = ((span.end - span.start) / domainDuration) * 100;
              if (leftPct + widthPct < 0 || leftPct > 100) return null;

              const record = records[span.index];
              const isSelected = selectedIndex === span.index;
              const outsideBrush =
                timelineFocusIndexes !== null &&
                !timelineFocusIndexes.has(span.index);
              const outsideSearch =
                searchMatchIndexes !== null &&
                !searchMatchIndexes.has(span.index);
              const durationText =
                record?.timed && record.durationMs != null
                  ? ` · ${formatDurationMs(record.durationMs)}`
                  : '';

              return (
                <span
                  key={`span:${span.index}`}
                  data-timeline-record-index={span.index}
                  data-timeline-span={span.kind}
                  title={`${kindLabel(span.kind)} · ${span.label}${durationText}`}
                  className={cn(
                    'absolute h-2.5 rounded-[2px] transition-opacity',
                    span.isError
                      ? 'bg-[hsl(var(--destructive))]'
                      : KIND_SPAN_CLASS[span.kind],
                    isSelected &&
                      'z-20 ring-2 ring-primary ring-offset-1 ring-offset-background',
                    (outsideBrush || outsideSearch) && 'opacity-20'
                  )}
                  style={{
                    top: `${6 + span.lane * 15}px`,
                    left: `${Math.max(0, leftPct)}%`,
                    width: `calc(${Math.max(0.8, Math.min(100 - Math.max(0, leftPct), widthPct))}% - 1px)`,
                    minWidth: '3px',
                  }}
                />
              );
            })}
          </div>
        </div>
      </section>

      {/* 3. Split Container: Event Ledger Table + Local Event Details Inspector */}
      <div
        ref={splitRef}
        className="flex min-h-0 flex-1 overflow-hidden bg-[var(--surface-card)]"
      >
        <div className="min-w-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 z-10 h-7 border-b border-[var(--border-subtle)] bg-[var(--surface-topbar)] text-muted-foreground select-none">
                <th className="w-[120px] pr-2 text-right font-medium">
                  {t('workspaceActivity.trajectoryColumnEvent')}
                </th>
                <th className="pl-2 text-left font-medium">
                  {t('workspaceActivity.trajectoryColumnContent')}
                </th>
                <th className="w-[68px] pr-2.5 text-right font-medium">
                  {t('workspaceActivity.trajectoryColumnTime')}
                </th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => {
                const { record, collapsedSummary, collapsedKind } = row;
                const Icon = KIND_ICON[record.kind];
                const isSelected =
                  !collapsedSummary && selectedIndex === record.index;
                const isTurnActive =
                  record.turn != null && selectedTurn === record.turn;

                return (
                  <tr
                    key={row.key}
                    ref={(el) => {
                      if (!collapsedSummary && el) {
                        rowRefs.current.set(record.index, el);
                      }
                    }}
                    data-selected={isSelected || undefined}
                    onClick={() => {
                      if (collapsedKind === 'turn' && record.turn != null) {
                        toggleTurn(record.turn);
                        return;
                      }
                      if (collapsedKind === 'calls') {
                        toggleAssistantCalls(record.index);
                        return;
                      }
                      selectRecord(record.index);
                    }}
                    className={cn(
                      'group h-[30px] cursor-pointer border-b border-[var(--border-subtle)] transition-colors',
                      row.turnStart &&
                        'border-t-2 border-t-[var(--border-subtle)]',
                      isSelected
                        ? 'bg-[var(--surface-active)]'
                        : 'hover:bg-[var(--surface-control-hover)]'
                    )}
                  >
                    {/* Event column: Turn Rail + Selection Rail + Turn Badge + Role Pill */}
                    <td className="relative overflow-visible pr-1.5 pl-8 align-middle">
                      {isTurnActive ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'pointer-events-none absolute inset-y-0 left-0 w-0.5',
                            record.isError
                              ? 'bg-[hsl(var(--destructive)/0.6)]'
                              : 'bg-primary/45'
                          )}
                        />
                      ) : null}
                      {isSelected ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'pointer-events-none absolute inset-y-0 left-0 w-[3px]',
                            record.isError
                              ? 'bg-[hsl(var(--destructive))]'
                              : 'bg-primary'
                          )}
                        />
                      ) : null}

                      {!collapsedSummary &&
                      row.turnStart &&
                      record.turn != null ? (
                        <button
                          type="button"
                          title={t('workspaceActivity.trajectoryTurnLabel', {
                            turn: record.turn,
                          })}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTurn(record.turn!);
                          }}
                          className={cn(
                            'absolute left-0 top-0 rounded-br px-1 py-0.5 font-mono text-xs leading-none tabular-nums transition-colors',
                            isTurnActive
                              ? 'bg-primary/15 font-semibold text-foreground'
                              : 'bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                          )}
                        >
                          #{record.turn}
                        </button>
                      ) : null}

                      {!collapsedSummary ? (
                        <div className="flex items-center justify-end">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs leading-none',
                              record.isError
                                ? KIND_BADGE_CLASS.notice
                                : KIND_BADGE_CLASS[record.kind],
                              record.kind === 'subtool' && 'ml-2'
                            )}
                          >
                            <Icon
                              className="h-3 w-3 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{kindLabel(record.kind)}</span>
                          </span>
                        </div>
                      ) : null}
                    </td>

                    {/* Content column */}
                    <td className="max-w-0 truncate pl-2 pr-2 align-middle">
                      {collapsedSummary ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                          <span className="rounded bg-[var(--surface-control)] px-1 leading-4">
                            …
                          </span>
                          <span>{collapsedSummary}</span>
                        </span>
                      ) : (
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'truncate',
                              record.kind === 'tool' ||
                                record.kind === 'subtool'
                                ? 'font-mono text-foreground'
                                : 'text-foreground'
                            )}
                            title={record.title}
                          >
                            {record.title}
                          </span>
                          {record.resultPreview ? (
                            <span
                              className={cn(
                                'inline-flex min-w-0 items-center gap-1 truncate font-mono',
                                record.isError
                                  ? 'text-[hsl(var(--destructive))]'
                                  : 'text-muted-foreground'
                              )}
                              title={record.resultPreview}
                            >
                              <span aria-hidden="true">→</span>
                              <span className="truncate">
                                {record.resultPreview}
                              </span>
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>

                    {/* Duration column */}
                    <td className="pr-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground align-middle">
                      {!collapsedSummary
                        ? record.timed &&
                          record.durationMs != null &&
                          record.durationMs > 0
                          ? formatDurationMs(record.durationMs)
                          : record.kind === 'user'
                            ? ''
                            : untimedLabel
                        : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* 4. Resizable Right-Side Event Details Inspector */}
        {selectedRecord ? (
          <aside
            aria-label={t('workspaceActivity.trajectoryDetailsEvent')}
            style={{ width: `${inspectorWidth}px` }}
            className="relative flex shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-card)]"
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('workspaceActivity.trajectoryDetailsResize')}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const startX = event.clientX;
                const startWidth = inspectorWidth;
                const splitWidth =
                  splitRef.current?.getBoundingClientRect().width ?? 720;
                const move = (e: globalThis.PointerEvent) => {
                  const next = Math.min(
                    Math.max(240, startWidth + (startX - e.clientX)),
                    Math.max(260, splitWidth - 220)
                  );
                  setInspectorWidth(Math.round(next));
                };
                const up = () => {
                  window.removeEventListener('pointermove', move);
                  window.removeEventListener('pointerup', up);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
              }}
              className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
            />

            {/* Inspector Header */}
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-topbar)] px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-xs leading-none',
                    selectedRecord.isError
                      ? KIND_BADGE_CLASS.notice
                      : KIND_BADGE_CLASS[selectedRecord.kind]
                  )}
                >
                  {kindLabel(selectedRecord.kind)}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {selectedRecord.turn != null
                    ? `${t('workspaceActivity.trajectoryTurnLabel', {
                        turn: selectedRecord.turn,
                      })}${
                        selectedRecord.step > 0
                          ? ` · ${t('workspaceActivity.trajectoryStepLabel', {
                              step: selectedRecord.step,
                            })}`
                          : ''
                      }`
                    : t('workspaceActivity.trajectoryBetweenTurns')}
                </span>
              </div>
              <button
                type="button"
                aria-label={t('workspaceActivity.trajectoryDetailsClose')}
                onClick={() => setSelectedIndex(null)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[calc(var(--radius)-6px)] text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Inspector Tabs */}
            <div
              role="tablist"
              aria-label={t('workspaceActivity.trajectoryDetailsEvent')}
              className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2.5 py-1"
            >
              {availableTabs.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  type="button"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'rounded-[calc(var(--radius)-6px)] px-2 py-1 text-xs font-medium transition-colors',
                    activeTab === tab.id
                      ? 'bg-[var(--surface-active)] text-foreground'
                      : 'text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Inspector Body */}
            <div
              role="tabpanel"
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs"
            >
              {activeTab === 'summary' ? (
                <>
                  <dl className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">
                        {t('workspaceActivity.trajectoryStatus')}
                      </dt>
                      <dd
                        className={cn(
                          'font-medium',
                          selectedRecord.status === 'failed'
                            ? 'text-[hsl(var(--destructive))]'
                            : selectedRecord.status === 'running'
                              ? 'text-[hsl(var(--warning))]'
                              : 'text-[hsl(var(--success))]'
                        )}
                      >
                        {selectedRecord.status === 'failed'
                          ? t('workspaceActivity.trajectoryStatusFailed')
                          : selectedRecord.status === 'running'
                            ? t('workspaceActivity.trajectoryStatusPending')
                            : t('workspaceActivity.trajectoryStatusCompleted')}
                      </dd>
                    </div>

                    {selectedRecord.model ? (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted-foreground">
                          {t('workspaceActivity.trajectoryModel')}
                        </dt>
                        <dd className="truncate font-mono text-foreground">
                          {selectedRecord.model}
                        </dd>
                      </div>
                    ) : null}

                    {selectedRecord.parentAssistantIndex != null ||
                    (selectedRecord.childSessionId && onSelectSession) ? (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted-foreground">
                          {t('workspaceActivity.trajectoryHierarchy')}
                        </dt>
                        <dd className="flex flex-wrap items-center gap-1.5">
                          {selectedRecord.parentAssistantIndex != null ? (
                            <button
                              type="button"
                              onClick={() =>
                                selectRecord(
                                  selectedRecord.parentAssistantIndex!,
                                  'summary'
                                )
                              }
                              className="inline-flex items-center gap-0.5 rounded bg-[var(--surface-control)] px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-[var(--surface-control-hover)]"
                            >
                              <span>
                                {t(
                                  'workspaceActivity.trajectoryAssistantMessage'
                                )}
                              </span>
                              <ChevronRight className="h-3 w-3" />
                            </button>
                          ) : null}
                          {selectedRecord.childSessionId && onSelectSession ? (
                            <button
                              type="button"
                              onClick={() =>
                                onSelectSession(selectedRecord.childSessionId!)
                              }
                              className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-primary/25"
                            >
                              <span>
                                {t(
                                  'workspaceActivity.trajectoryOpenChildSession'
                                )}
                              </span>
                              <ChevronRight className="h-3 w-3" />
                            </button>
                          ) : null}
                        </dd>
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">
                        {t('workspaceActivity.trajectoryTotalDuration')}
                      </dt>
                      <dd className="font-mono tabular-nums text-foreground">
                        {selectedRecord.timed &&
                        selectedRecord.durationMs != null
                          ? formatDurationMs(selectedRecord.durationMs)
                          : untimedLabel}
                      </dd>
                    </div>

                    {selectedRecord.usage ? (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted-foreground">
                          {t('workspaceActivity.trajectoryTokens')}
                        </dt>
                        <dd className="font-mono tabular-nums text-foreground">
                          {selectedRecord.usage.outputTokens} tok
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {/* Quick Preview Cards */}
                  {selectedRecord.thinkingText ? (
                    <div className="space-y-1 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-muted-foreground">
                          {t('workspaceActivity.trajectoryThinking')}
                        </span>
                      </div>
                      <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">
                        {selectedRecord.thinkingText}
                      </p>
                    </div>
                  ) : null}

                  {selectedRecord.fullText ? (
                    <div className="space-y-1 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setActiveTab('preview')}
                          className="inline-flex items-center gap-1 font-semibold text-foreground hover:underline"
                        >
                          <span>
                            {t('workspaceActivity.trajectoryTabPreview')}
                          </span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                      <p className="line-clamp-6 whitespace-pre-wrap text-foreground">
                        {selectedRecord.fullText}
                      </p>
                    </div>
                  ) : null}

                  {(selectedRecord.kind === 'tool' ||
                    selectedRecord.kind === 'subtool') && (
                    <>
                      <div className="space-y-1 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                        <button
                          type="button"
                          onClick={() => setActiveTab('payload')}
                          className="inline-flex items-center gap-1 font-semibold text-foreground hover:underline"
                        >
                          <span>
                            {t('workspaceActivity.trajectoryTabPayload')}
                          </span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                        <pre className="line-clamp-5 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                          {formatPrettyPayload(selectedRecord.inputDetail) ??
                            t('workspaceActivity.trajectoryNoPayload')}
                        </pre>
                      </div>

                      <div className="space-y-1 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                        <button
                          type="button"
                          onClick={() => setActiveTab('result')}
                          className="inline-flex items-center gap-1 font-semibold text-foreground hover:underline"
                        >
                          <span>
                            {t('workspaceActivity.trajectoryTabResult')}
                          </span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                        <pre
                          className={cn(
                            'line-clamp-5 overflow-x-auto whitespace-pre-wrap font-mono text-xs',
                            selectedRecord.isError
                              ? 'text-[hsl(var(--destructive))]'
                              : 'text-foreground'
                          )}
                        >
                          {selectedRecord.outputDetail ??
                            t('workspaceActivity.trajectoryNoResult')}
                        </pre>
                      </div>
                    </>
                  )}
                </>
              ) : null}

              {activeTab === 'preview' ? (
                <div className="space-y-3">
                  {selectedRecord.thinkingText ? (
                    <details
                      open
                      className="rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5"
                    >
                      <summary className="cursor-pointer font-semibold text-muted-foreground">
                        {t('workspaceActivity.trajectoryThinking')}
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
                        {selectedRecord.thinkingText}
                      </pre>
                    </details>
                  ) : null}

                  <div className="space-y-1.5">
                    {selectedRecord.fullText ? (
                      <>
                        <div className="flex justify-end">
                          <CopySnippetButton
                            value={selectedRecord.fullText}
                            copyLabel={t('workspaceActivity.trajectoryCopy')}
                            copiedLabel={t(
                              'workspaceActivity.trajectoryCopied'
                            )}
                          />
                        </div>
                        <pre className="whitespace-pre-wrap rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5 font-sans text-xs leading-relaxed text-foreground">
                          {selectedRecord.fullText}
                        </pre>
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        {t('workspaceActivity.trajectoryNoOutput')}
                      </p>
                    )}
                  </div>
                </div>
              ) : null}

              {activeTab === 'payload' ? (
                <div className="space-y-1.5">
                  {selectedRecord.inputDetail ? (
                    <>
                      <div className="flex justify-end">
                        <CopySnippetButton
                          value={
                            formatPrettyPayload(selectedRecord.inputDetail) ??
                            selectedRecord.inputDetail
                          }
                          copyLabel={t('workspaceActivity.trajectoryCopy')}
                          copiedLabel={t('workspaceActivity.trajectoryCopied')}
                        />
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5 font-mono text-xs text-foreground">
                        {formatPrettyPayload(selectedRecord.inputDetail)}
                      </pre>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {t('workspaceActivity.trajectoryNoPayload')}
                    </p>
                  )}
                </div>
              ) : null}

              {activeTab === 'result' ? (
                <div className="space-y-1.5">
                  {selectedRecord.outputDetail ? (
                    <>
                      <div className="flex justify-end">
                        <CopySnippetButton
                          value={selectedRecord.outputDetail}
                          copyLabel={t('workspaceActivity.trajectoryCopy')}
                          copiedLabel={t('workspaceActivity.trajectoryCopied')}
                        />
                      </div>
                      <pre
                        className={cn(
                          'overflow-x-auto whitespace-pre-wrap rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5 font-mono text-xs',
                          selectedRecord.isError
                            ? 'text-[hsl(var(--destructive))]'
                            : 'text-foreground'
                        )}
                      >
                        {selectedRecord.outputDetail}
                      </pre>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {t('workspaceActivity.trajectoryNoResult')}
                    </p>
                  )}
                </div>
              ) : null}

              {activeTab === 'usage' ? (
                <div className="space-y-3">
                  <div className="space-y-1.5 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                    <h4 className="font-semibold text-foreground">
                      {t('workspaceActivity.trajectoryThisRequest')}
                    </h4>
                    <UsageDefinitionList usage={selectedRecord.usage} t={t} />
                  </div>

                  {selectedRecord.cumulativeUsage ? (
                    <div className="space-y-1.5 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                      <h4 className="font-semibold text-foreground">
                        {t('workspaceActivity.trajectorySessionCumulative')}
                      </h4>
                      <UsageDefinitionList
                        usage={selectedRecord.cumulativeUsage}
                        t={t}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === 'timing' ? (
                <dl className="space-y-2 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">
                      {t('workspaceActivity.trajectoryStarted')}
                    </dt>
                    <StartedAtToggle
                      startedAtMs={selectedRecord.startedAtMs}
                      notRecordedLabel={t(
                        'workspaceActivity.trajectoryNotRecorded'
                      )}
                      localTimeTitle={t(
                        'workspaceActivity.trajectoryShowLocalTime'
                      )}
                      unixTimeTitle={t(
                        'workspaceActivity.trajectoryShowUnixTimestamp'
                      )}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">
                      {t('workspaceActivity.trajectoryTotalDuration')}
                    </dt>
                    <dd className="font-mono tabular-nums text-foreground">
                      {selectedRecord.timed && selectedRecord.durationMs != null
                        ? formatDurationMs(selectedRecord.durationMs)
                        : t('workspaceActivity.trajectoryNotRecorded')}
                    </dd>
                  </div>
                  {selectedRecord.usage?.outputTokens &&
                  selectedRecord.timed &&
                  selectedRecord.durationMs &&
                  selectedRecord.durationMs > 0 ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">
                        {t('workspaceActivity.trajectoryThroughput')}
                      </dt>
                      <dd className="font-mono tabular-nums text-foreground">
                        {(
                          selectedRecord.usage.outputTokens /
                          (selectedRecord.durationMs / 1_000)
                        ).toFixed(1)}{' '}
                        tok/s
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
