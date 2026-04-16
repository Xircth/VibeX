import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TaskWithAttemptStatus } from 'shared/types.ts';
import type { WorkspaceWithSession } from '@/types/attempt';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import { cn } from '@/lib/utils';
import {
  AGGREGATION_LABELS,
  getAggregatedEntryDetail,
  type AggregationType,
} from './conversation-entry-utils';
import DisplayConversationEntry from './DisplayConversationEntry';

/*****************************
 * Phase 6: AggregatedGroupCard — timeline + badge
 *****************************/

export const AggregatedGroupCard: React.FC<{
  entries: PatchTypeWithKey[];
  aggregationType: AggregationType;
  attempt: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
}> = ({ entries, aggregationType, attempt, task }) => {
  const [expanded, setExpanded] = useState(false);
  const { icon, label } = AGGREGATION_LABELS[aggregationType];

  return (
    <div className="px-4 py-1 conv-entry-item">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm conv-tool-card cursor-pointer"
      >
        <span className="shrink-0 conv-tool-icon">{icon}</span>
        <span className="conv-tool-label shrink-0">{label}</span>
        <span className="conv-count-badge">{entries.length}</span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 ml-auto text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="mt-1 conv-agg-timeline">
          {entries.map((data) => {
            return (
              <div key={data.patchKey} className="conv-agg-timeline-item">
                {data.type === 'NORMALIZED_ENTRY' ? (
                  <DisplayConversationEntry
                    expansionKey={data.patchKey}
                    entry={data.content}
                    executionProcessId={data.executionProcessId}
                    taskAttempt={attempt}
                    task={task}
                  />
                ) : (
                  <div className="px-2 py-0.5 text-xs text-muted-foreground font-mono truncate">
                    {getAggregatedEntryDetail(data)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
