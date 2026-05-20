import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import {
  BaseCodingAgent,
  ExecutionProcessStatus,
  type TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from '@/components/NormalizedConversation/DisplayConversationEntry';
import { AggregatedThinkingCard } from '@/components/NormalizedConversation/AggregatedThinkingCard';
import { AggregatedGroupCard } from '@/components/NormalizedConversation/AggregatedGroupCard';
import { AggregatedFileEditCard } from '@/components/NormalizedConversation/AggregatedFileEditCard';
import {
  ProcessChangeSummaryCard,
  type ProcessChangeItem,
} from '@/components/NormalizedConversation/ProcessChangeSummaryCard';
import { buildDisplayEntries } from '@/components/NormalizedConversation/conversation-entry-utils';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { useConversationHistory } from '@/hooks/useConversationHistory/useConversationHistory';
import type {
  AddEntryType,
  BaseDisplayEntry,
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/useConversationHistory/types';
import { isCollapsedAssistantMessagesGroup } from '@/hooks/useConversationHistory/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { cn } from '@/lib/utils';

export interface VirtualizedListRef {
  scrollToPreviousUserMessage: () => void;
  scrollToBottom: () => void;
}

interface VirtualizedListProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onAtBottomChange?: (isAtBottom: boolean) => void;
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

const conversationScrollPositions = new Map<string, number>();
const MAX_CONVERSATION_SCROLL_POSITIONS = 50;
const BOTTOM_SCROLL_THRESHOLD_PX = 48;

function rememberConversationScrollPosition(key: string, scrollTop: number) {
  conversationScrollPositions.delete(key);
  conversationScrollPositions.set(key, scrollTop);

  while (conversationScrollPositions.size > MAX_CONVERSATION_SCROLL_POSITIONS) {
    const oldestKey = conversationScrollPositions.keys().next().value;
    if (!oldestKey) break;
    conversationScrollPositions.delete(oldestKey);
  }
}

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

export function collapsedAssistantMessagesLabel(hiddenCount: number): string {
  return `已折叠 ${hiddenCount} 条过程消息`;
}

const VirtualizedList = forwardRef<VirtualizedListRef, VirtualizedListProps>(
function VirtualizedList({ attempt, task, onAtBottomChange }, ref) {
    const { entries, setEntries } = useEntries();
    const { executionProcessesVisible } = useExecutionProcessesContext();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const userMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const [isLoadingEntries, setIsLoadingEntries] = useState(false);
    const conversationScrollKey = `${attempt.id}:${attempt.session?.id ?? 'none'}`;
    const restoredScrollRef = useRef<string | null>(null);
    const isAtBottomRef = useRef(true);
    const { config } = useUserSystem();

    const updateAtBottomState = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const nextIsAtBottom = distanceFromBottom <= BOTTOM_SCROLL_THRESHOLD_PX;
      if (isAtBottomRef.current === nextIsAtBottom) return;

      isAtBottomRef.current = nextIsAtBottom;
      onAtBottomChange?.(nextIsAtBottom);
    }, [onAtBottomChange]);

    const saveScrollPosition = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;
      rememberConversationScrollPosition(
        conversationScrollKey,
        container.scrollTop
      );
      updateAtBottomState();
    }, [conversationScrollKey, updateAtBottomState]);

    const handleEntriesUpdated = useCallback(
      (
        newEntries: PatchTypeWithKey[],
        _addType: AddEntryType,
        _loading: boolean
      ) => {
        setIsLoadingEntries(_loading);
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

    const displayEntries = useMemo<DisplayEntry[]>(() => {
      const completedExecutionProcessIds = new Set(
        executionProcessesVisible
          .filter(
            (process) => process.status !== ExecutionProcessStatus.running
          )
          .map((process) => process.id)
      );

      return buildDisplayEntries(normalizedEntries, {
        aggregateThinking: attempt.session?.executor === BaseCodingAgent.CODEX,
        completedExecutionProcessIds,
        collapseAiMessagesByDefault:
          config?.ai_message_default_collapsed ?? false,
      });
    }, [
      attempt.session?.executor,
      config?.ai_message_default_collapsed,
      executionProcessesVisible,
      normalizedEntries,
    ]);

    const renderBaseDisplayEntry = useCallback(
      (entry: BaseDisplayEntry) => {
        if (entry.type === 'AGGREGATED_GROUP') {
          return (
            <AggregatedGroupCard
              entries={entry.entries}
              aggregationType={entry.aggregationType}
              attempt={attempt}
              task={task ?? undefined}
            />
          );
        }

        if (entry.type === 'AGGREGATED_THINKING_GROUP') {
          return (
            <AggregatedThinkingCard
              entries={entry.entries}
              expansionKey={entry.patchKey}
            />
          );
        }

        if (entry.type === 'AGGREGATED_FILE_EDIT_GROUP') {
          return (
            <AggregatedFileEditCard
              entries={entry.entries}
              attempt={attempt}
              task={task ?? undefined}
            />
          );
        }

        if (entry.type === 'PROCESS_CHANGE_SUMMARY') {
          return (
            <ProcessChangeSummaryCard
              executionProcessId={entry.executionProcessId}
              attempt={attempt}
              changes={buildProcessChangeItems(entry.entries)}
            />
          );
        }

        if (entry.type === 'NORMALIZED_ENTRY') {
          return (
            <DisplayConversationEntry
              entry={entry.content}
              expansionKey={entry.patchKey}
              executionProcessId={entry.executionProcessId}
              taskAttempt={attempt}
              task={task ?? undefined}
            />
          );
        }

        return null;
      },
      [attempt, task]
    );

    useLayoutEffect(() => {
      if (restoredScrollRef.current === conversationScrollKey) return;
      if (displayEntries.length === 0) return;

      const container = containerRef.current;
      const scrollTop = conversationScrollPositions.get(conversationScrollKey);
      if (!container || typeof scrollTop !== 'number') {
        restoredScrollRef.current = conversationScrollKey;
        return;
      }

      container.scrollTop = scrollTop;
      restoredScrollRef.current = conversationScrollKey;
      updateAtBottomState();
    }, [conversationScrollKey, displayEntries.length, updateAtBottomState]);

    useLayoutEffect(() => {
      updateAtBottomState();
    }, [displayEntries.length, updateAtBottomState]);

    useEffect(() => {
      return () => {
        saveScrollPosition();
      };
    }, [saveScrollPosition]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom() {
          const container = containerRef.current;
          if (!container) return;

          container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth',
          });
          isAtBottomRef.current = true;
          onAtBottomChange?.(true);
        },
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
      [normalizedEntries, onAtBottomChange]
    );

    return (
      <div
        ref={containerRef}
        className="h-full overflow-y-auto px-2 py-3"
        data-panel="conversation-logs"
        onScroll={saveScrollPosition}
      >
        {isLoadingEntries && displayEntries.length === 0 ? (
          <div className="flex h-full min-h-[160px] items-center justify-center text-muted-foreground">
            <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading session...</span>
            </div>
          </div>
        ) : (
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
                {isCollapsedAssistantMessagesGroup(entry) ? (
                  <CollapsedAssistantMessagesBlock
                    hiddenCount={entry.hiddenCount}
                    entries={entry.entries}
                    renderEntry={renderBaseDisplayEntry}
                  />
                ) : null}
                {!isCollapsedAssistantMessagesGroup(entry)
                  ? renderBaseDisplayEntry(entry)
                  : null}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);

function CollapsedAssistantMessagesBlock({
  hiddenCount,
  entries,
  renderEntry,
}: {
  hiddenCount: number;
  entries: BaseDisplayEntry[];
  renderEntry: (entry: BaseDisplayEntry) => JSX.Element | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="conv-entry-item px-4 py-1">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform',
            expanded ? '' : '-rotate-90'
          )}
        />
        <span>{collapsedAssistantMessagesLabel(hiddenCount)}</span>
      </button>
      {expanded
        ? entries.map((entry) => (
            <div key={entry.patchKey}>{renderEntry(entry)}</div>
          ))
        : null}
    </div>
  );
}

export default VirtualizedList;
