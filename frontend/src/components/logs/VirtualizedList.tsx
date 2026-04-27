import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { BaseCodingAgent, type TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from '@/components/NormalizedConversation/DisplayConversationEntry';
import { AggregatedThinkingCard } from '@/components/NormalizedConversation/AggregatedThinkingCard';
import { AggregatedGroupCard } from '@/components/NormalizedConversation/AggregatedGroupCard';
import {
  ProcessChangeSummaryCard,
  type ProcessChangeItem,
} from '@/components/NormalizedConversation/ProcessChangeSummaryCard';
import { buildDisplayEntries } from '@/components/NormalizedConversation/conversation-entry-utils';
import { useEntries } from '@/contexts/EntriesContext';
import { useConversationHistory } from '@/hooks/useConversationHistory/useConversationHistory';
import type {
  AddEntryType,
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/useConversationHistory/types';

export interface VirtualizedListRef {
  scrollToPreviousUserMessage: () => void;
}

interface VirtualizedListProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
}

function isUserMessageEntry(entry: PatchTypeWithKey): boolean {
  return (
    entry.type === 'NORMALIZED_ENTRY' &&
    entry.content.entry_type.type === 'user_message'
  );
}

type UserMessagePosition = {
  patchKey: string;
  top: number;
};

export function findPreviousUserMessageKey(
  positions: UserMessagePosition[],
  scrollTop: number,
  viewportHeight: number
): string | null {
  if (positions.length === 0) {
    return null;
  }

  const anchor = scrollTop + Math.max(24, viewportHeight * 0.25);

  for (let index = positions.length - 1; index >= 0; index -= 1) {
    if (positions[index]!.top < anchor) {
      return positions[index]!.patchKey;
    }
  }

  return positions[0]!.patchKey;
}

export function buildProcessChangeItems(
  entries: PatchTypeWithKey[]
): ProcessChangeItem[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'NORMALIZED_ENTRY') {
      return [];
    }

    const entryType = entry.content.entry_type;
    if (entryType.type !== 'tool_use') {
      return [];
    }

    const actionType = entryType.action_type;
    if (actionType.action !== 'file_edit') {
      return [];
    }

    return actionType.changes.map((change, index) => ({
      key: `${entry.patchKey}:${index}`,
      path: actionType.path,
      change,
    }));
  });
}

const VirtualizedList = forwardRef<VirtualizedListRef, VirtualizedListProps>(
  function VirtualizedList({ attempt, task }, ref) {
    const { entries, setEntries } = useEntries();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const userMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    const handleEntriesUpdated = useCallback(
      (
        newEntries: PatchTypeWithKey[],
        _addType: AddEntryType,
        _loading: boolean
      ) => {
        setEntries(newEntries);
      },
      [setEntries]
    );

    useConversationHistory({
      attempt,
      onEntriesUpdated: handleEntriesUpdated,
    });

    const normalizedEntries = useMemo(
      () =>
        entries.filter(
          (entry): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } =>
            entry.type === 'NORMALIZED_ENTRY'
        ),
      [entries]
    );

    const displayEntries = useMemo<DisplayEntry[]>(
      () =>
        buildDisplayEntries(normalizedEntries, {
          aggregateThinking:
            attempt.session?.executor === BaseCodingAgent.CODEX,
        }),
      [attempt.session?.executor, normalizedEntries]
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToPreviousUserMessage() {
          const container = containerRef.current;
          if (!container) return;

          const positions = normalizedEntries
            .filter(isUserMessageEntry)
            .map((entry) => ({
              patchKey: entry.patchKey,
              top: userMessageRefs.current.get(entry.patchKey)?.offsetTop,
            }))
            .filter(
              (
                item
              ): item is {
                patchKey: string;
                top: number;
              } => typeof item.top === 'number'
            );

          const targetPatchKey = findPreviousUserMessageKey(
            positions,
            container.scrollTop,
            container.clientHeight
          );

          if (!targetPatchKey) return;

          userMessageRefs.current
            .get(targetPatchKey)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
      }),
      [normalizedEntries]
    );

    return (
      <div
        ref={containerRef}
        className="h-full overflow-y-auto px-2 py-3"
        data-panel="conversation-logs"
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          {displayEntries.map((entry) => (
            <div
              key={entry.patchKey}
              ref={(node) => {
                if (
                  node &&
                  entry.type === 'NORMALIZED_ENTRY' &&
                  isUserMessageEntry(entry)
                ) {
                  userMessageRefs.current.set(entry.patchKey, node);
                } else {
                  userMessageRefs.current.delete(entry.patchKey);
                }
              }}
            >
              {entry.type === 'AGGREGATED_GROUP' ? (
                <AggregatedGroupCard
                  entries={entry.entries}
                  aggregationType={entry.aggregationType}
                  attempt={attempt}
                  task={task ?? undefined}
                />
              ) : entry.type === 'AGGREGATED_THINKING_GROUP' ? (
                <AggregatedThinkingCard
                  entries={entry.entries}
                  expansionKey={entry.patchKey}
                />
              ) : entry.type === 'AGGREGATED_DIFF_GROUP' ? (
                <ProcessChangeSummaryCard
                  executionProcessId={entry.executionProcessId}
                  attempt={attempt}
                  changes={buildProcessChangeItems(entry.entries)}
                />
              ) : entry.type === 'NORMALIZED_ENTRY' ? (
                <DisplayConversationEntry
                  entry={entry.content}
                  expansionKey={entry.patchKey}
                  executionProcessId={entry.executionProcessId}
                  taskAttempt={attempt}
                  task={task ?? undefined}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }
);

export default VirtualizedList;
