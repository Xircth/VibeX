import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

type ThinkingAggregate = {
  mergedContent: string;
  count: number;
  timestamps: number[];
};

function collectThinking(entries: PatchTypeWithKey[]): ThinkingAggregate {
  const contents: string[] = [];
  const timestamps: number[] = [];
  let count = 0;

  for (const entry of entries) {
    if (
      entry.type !== 'NORMALIZED_ENTRY' ||
      entry.content.entry_type.type !== 'thinking'
    ) {
      continue;
    }

    count += 1;

    const trimmed = entry.content.content.trim();
    if (trimmed) contents.push(trimmed);

    if (entry.content.timestamp) {
      const parsed = Date.parse(entry.content.timestamp);
      if (Number.isFinite(parsed)) timestamps.push(parsed);
    }
  }

  return { mergedContent: contents.join('\n\n'), count, timestamps };
}

function useAggregatedThinkingElapsed(
  timestamps: number[],
  isStreaming: boolean
): number | null {
  const firstTimestamp = useMemo(
    () => (timestamps.length ? Math.min(...timestamps) : null),
    [timestamps]
  );
  const fallbackStartRef = useRef(Date.now());
  const [liveSeconds, setLiveSeconds] = useState(0);
  const completedElapsed = useMemo(() => {
    if (timestamps.length < 2) return null;
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    return Math.max(0, Math.floor((last - first) / 1000));
  }, [timestamps]);

  useEffect(() => {
    if (!isStreaming) return;

    const update = () => {
      const startedAt = firstTimestamp ?? fallbackStartRef.current;
      setLiveSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };

    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [firstTimestamp, isStreaming]);

  return isStreaming ? liveSeconds : completedElapsed;
}

export const AggregatedThinkingCard: React.FC<{
  entries: PatchTypeWithKey[];
  expansionKey: string;
  isStreaming?: boolean;
}> = ({ entries, expansionKey, isStreaming = false }) => {
  const [expanded, toggle] = useExpandable(
    `thinking-group:${expansionKey}`,
    isStreaming
  );

  const {
    mergedContent,
    count: entryCount,
    timestamps,
  } = useMemo(() => collectThinking(entries), [entries]);
  const elapsedSeconds = useAggregatedThinkingElapsed(timestamps, isStreaming);

  return (
    <div className="px-4 py-1">
      <div
        className={`conv-thinking conv-thinking-group ${isStreaming ? 'conv-thinking-streaming' : ''}`}
      >
        <button
          type="button"
          className="conv-thinking-header w-full"
          onClick={() => toggle()}
          title={expanded ? 'Collapse Thinking' : 'Expand Thinking'}
          aria-label={expanded ? 'Collapse Thinking' : 'Expand Thinking'}
        >
          <Brain className="conv-thinking-icon h-3 w-3 shrink-0" />
          <ChevronRight
            className={`h-3 w-3 shrink-0 conv-thinking-chevron ${expanded ? 'is-expanded' : ''}`}
          />
          <span className="truncate">Thinking</span>
          <span className="conv-thinking-status">
            {isStreaming ? '思考中' : '已完成'}
          </span>
          {typeof elapsedSeconds === 'number' ? (
            <span className="conv-thinking-elapsed">
              {formatElapsed(elapsedSeconds)}
            </span>
          ) : null}
          <span className="conv-thinking-count">{entryCount}</span>
        </button>
        {expanded && mergedContent && (
          <div className="conv-thinking-content conv-thinking-group-content">
            <Markdown value={mergedContent} />
          </div>
        )}
      </div>
    </div>
  );
};
