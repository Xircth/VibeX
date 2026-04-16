import React, { useMemo } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

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
