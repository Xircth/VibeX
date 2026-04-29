import React, { useState } from 'react';
import { ChevronRight, Edit } from 'lucide-react';
import type { TaskWithAttemptStatus } from 'shared/types.ts';
import type { WorkspaceWithSession } from '@/types/attempt';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import { cn } from '@/lib/utils';
import DisplayConversationEntry from './DisplayConversationEntry';

export const AggregatedFileEditCard: React.FC<{
  entries: PatchTypeWithKey[];
  attempt: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
}> = ({ entries, attempt, task }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="px-4 py-1 conv-entry-item">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm conv-tool-card cursor-pointer"
      >
        <span className="shrink-0 conv-tool-icon">
          <Edit className="h-3 w-3" />
        </span>
        <span className="conv-tool-label shrink-0">编辑文件</span>
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
          {entries.map((data) => (
            <div key={data.patchKey} className="conv-agg-timeline-item">
              {data.type === 'NORMALIZED_ENTRY' ? (
                <DisplayConversationEntry
                  expansionKey={data.patchKey}
                  entry={data.content}
                  executionProcessId={data.executionProcessId}
                  taskAttempt={attempt}
                  task={task}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
