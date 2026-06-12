import React, { useMemo } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function getElapsedSeconds(entries: PatchTypeWithKey[]): number | null {
  const timestamps = entries
    .filter(
      (entry): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } =>
        entry.type === 'NORMALIZED_ENTRY' &&
        entry.content.entry_type.type === 'thinking' &&
        Boolean(entry.content.timestamp)
    )
    .map((entry) => Date.parse(entry.content.timestamp ?? ''))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length < 2) return null;

  const first = Math.min(...timestamps);
  const last = Math.max(...timestamps);
  return Math.max(0, Math.floor((last - first) / 1000));
}

export const AggregatedThinkingCard: React.FC<{
  entries: PatchTypeWithKey[];
  expansionKey: string;
}> = ({ entries, expansionKey }) => {
  const [expanded, toggle] = useExpandable(
    `thinking-group:${expansionKey}`,
    false
  );

  const mergedContent = useMemo(
    () =>
      entries
        .filter(
          (entry): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } =>
            entry.type === 'NORMALIZED_ENTRY' &&
            entry.content.entry_type.type === 'thinking'
        )
        .map((entry) => entry.content.content.trim())
        .filter(Boolean)
        .join('\n\n'),
    [entries]
  );
  const elapsedSeconds = useMemo(() => getElapsedSeconds(entries), [entries]);

  return (
    <div className="px-4 py-1">
      <div className="conv-thinking conv-thinking-group">
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
          {typeof elapsedSeconds === 'number' ? (
            <span className="conv-thinking-elapsed">
              {formatElapsed(elapsedSeconds)}
            </span>
          ) : null}
          <span className="conv-thinking-count">{entries.length}</span>
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
