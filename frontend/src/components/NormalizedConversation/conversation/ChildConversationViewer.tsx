import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bot, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ConversationTimelineSkeleton } from '@/components/logs/ConversationTimelineSkeleton';
import {
  ESTIMATED_CONVERSATION_ROW_HEIGHT,
  getVirtualWindowTranslateY,
  measureScrollMargin,
  measureUnscaledBlockHeight,
  observeUnscaledElementRect,
} from '@/components/logs/VirtualizedList';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  MessageTurn,
  TaskWithAttemptStatus,
  TimelineRow,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { ArtifactTimelineCard } from '@/components/NormalizedConversation/ArtifactTimelineCard';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import {
  collectAskQuestionToolUses,
  findMatchingAskQuestionToolInUses,
} from '@/components/NormalizedConversation/TurnActivity';
import { SubagentLifecycleProvider } from '@/components/NormalizedConversation/tools/SubagentLifecycleContext';
import { toast } from '@/components/ui/toast';
import {
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { resolveConversationCollapsePreferences } from '@/lib/conversationCollapsePreferences';
import type { WorkspaceWithSession } from '@/types/attempt';
import { agentDisplayLabel } from './DelegationCard';
import i18n from '@/i18n';

const CONVERSATION_REGION_SELECTOR = '.right-panel-conversation-region';
const CHILD_VIRTUALIZE_THRESHOLD = 24;
const CHILD_VIRTUAL_OVERSCAN = 8;

type ChildRenderRow =
  | { kind: 'stream-message'; key: string; item: ConversationTimelineTurn }
  | { kind: 'stream-side'; key: string; row: TimelineRow }
  | { kind: 'leftover-side'; key: string; row: TimelineRow };

export function ChildConversationViewer({
  conversationId,
  agentId: agentIdHint,
  taskPreview,
  attempt,
  task,
  workspacePath,
  onClose,
  onOpenChild,
}: {
  conversationId: string;
  agentId?: string | null;
  taskPreview?: string | null;
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath?: string | null;
  onClose: () => void;
  onOpenChild?: (childConversationId: string) => void;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const { config } = useOptionalUserSystem() ?? {};
  const { collapseAiMessages } = resolveConversationCollapsePreferences(config);
  const conversation = useConversationTimeline(conversationId);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const messages = conversation.timeline;
  const agentId = conversation.agentId ?? agentIdHint ?? null;
  const title = agentId ? agentDisplayLabel(agentId) : t('childViewer.title');
  const stream = useMemo(
    () =>
      childConversationStream(
        conversation.items,
        messages,
        taskPreview ?? null
      ),
    [conversation.items, messages, taskPreview]
  );
  const leftoverSideRows = useMemo(
    () => leftoverUninlinedSideRows(conversation.sideRows, stream),
    [conversation.sideRows, stream]
  );
  const delegations = useMemo(
    () =>
      conversation.sideRows.flatMap((row) =>
        row.row.kind === 'delegation' ? [row.row.delegation] : []
      ),
    [conversation.sideRows]
  );
  const timelineQuestions = useMemo(
    () =>
      conversation.sideRows.flatMap((row) =>
        row.row.kind === 'question_request'
          ? [
              {
                request: row.row.request,
                response: row.row.response ?? null,
              },
            ]
          : []
      ),
    [conversation.sideRows]
  );
  const askQuestionUses = useMemo(
    () => collectAskQuestionToolUses(messages),
    [messages]
  );
  const matchedAnsweredQuestionIds = useMemo(() => {
    const matched = new Set<string>();
    const checked = new Set<string>();
    const checkRow = (row: TimelineRow) => {
      if (row.row.kind !== 'question_request' || !row.row.response) return;
      const questionId = row.row.request.question_id;
      if (checked.has(questionId)) return;
      checked.add(questionId);
      if (
        findMatchingAskQuestionToolInUses(row.row.request, askQuestionUses) !==
        null
      ) {
        matched.add(questionId);
      }
    };
    for (const entry of stream) {
      if (entry.kind === 'side') checkRow(entry.row);
    }
    for (const row of leftoverSideRows) {
      checkRow(row);
    }
    return matched;
  }, [askQuestionUses, leftoverSideRows, stream]);

  const turnsForProvider = useMemo(
    () => messages.map((row) => row.turn),
    [messages]
  );

  const renderRows = useMemo<ChildRenderRow[]>(() => {
    const rows: ChildRenderRow[] = [];
    for (const entry of stream) {
      if (entry.kind === 'message') {
        rows.push({
          kind: 'stream-message',
          key: entry.item.key,
          item: entry.item,
        });
        continue;
      }
      if (
        entry.row.row.kind === 'question_request' &&
        entry.row.row.response &&
        matchedAnsweredQuestionIds.has(entry.row.row.request.question_id)
      ) {
        continue;
      }
      rows.push({
        kind: 'stream-side',
        key: entry.row.row_id,
        row: entry.row,
      });
    }
    for (const entry of leftoverSideRows) {
      if (entry.row.kind === 'permission_request') {
        rows.push({ kind: 'leftover-side', key: entry.row_id, row: entry });
      } else if (entry.row.kind === 'question_request') {
        if (
          entry.row.response &&
          matchedAnsweredQuestionIds.has(entry.row.request.question_id)
        ) {
          continue;
        }
        rows.push({ kind: 'leftover-side', key: entry.row_id, row: entry });
      } else if (entry.row.kind === 'turn_error') {
        rows.push({ kind: 'leftover-side', key: entry.row_id, row: entry });
      }
    }
    return rows;
  }, [leftoverSideRows, matchedAnsweredQuestionIds, stream]);

  const shouldVirtualize = renderRows.length > CHILD_VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: shouldVirtualize ? renderRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CONVERSATION_ROW_HEIGHT,
    getItemKey: (index) => renderRows[index]?.key ?? index,
    overscan: CHILD_VIRTUAL_OVERSCAN,
    scrollMargin,
    observeElementRect: observeUnscaledElementRect,
    measureElement: measureUnscaledBlockHeight,
  });

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollMargin(0);
      return;
    }
    const container = scrollRef.current;
    const list = listRef.current;
    if (!container || !list) return;
    const update = () => {
      const next = measureScrollMargin(list, container);
      setScrollMargin((current) =>
        Math.abs(current - next) > 1 ? next : current
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(list);
    return () => observer.disconnect();
  }, [shouldVirtualize, renderRows.length]);

  useLayoutEffect(() => {
    const node = document.querySelector(CONVERSATION_REGION_SELECTOR);
    setHost(node instanceof HTMLElement ? node : null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const respondPermission = useCallback(
    (permissionId: string, response: AgentPermissionResponse) => {
      setRespondingId(permissionId);
      void conversation
        .respondPermission(permissionId, response)
        .catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error))
        )
        .finally(() => setRespondingId(null));
    },
    [conversation]
  );
  const respondQuestion = useCallback(
    (questionId: string, response: AgentElicitationResponse) => {
      setRespondingId(questionId);
      void conversation
        .respondQuestion(questionId, response)
        .catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error))
        )
        .finally(() => setRespondingId(null));
    },
    [conversation]
  );

  const renderChildRow = (row: ChildRenderRow) => {
    if (row.kind === 'stream-message') {
      return (
        <MessageTurnView
          turn={row.item.turn}
          phase={row.item.phase}
          attempt={attempt}
          task={task}
          workspacePath={workspacePath}
          collapseProcess={collapseAiMessages}
          showInterruptedNotice={false}
          delegations={delegations}
          questions={timelineQuestions}
          onOpenChild={onOpenChild}
        />
      );
    }
    if (row.kind === 'stream-side') {
      return (
        <ChildInlineSideRow
          entry={row.row}
          respondingId={respondingId}
          onRespondQuestion={respondQuestion}
        />
      );
    }
    const entry = row.row;
    if (entry.row.kind === 'permission_request') {
      return (
        <PermissionRequestCard
          request={entry.row.request}
          responding={respondingId === entry.row.request.permission_id}
          onRespond={respondPermission}
        />
      );
    }
    if (entry.row.kind === 'question_request') {
      return (
        <ChildInlineSideRow
          entry={entry}
          respondingId={respondingId}
          onRespondQuestion={respondQuestion}
        />
      );
    }
    if (entry.row.kind === 'turn_error') {
      return <TurnErrorCard error={entry.row.error.error} />;
    }
    return null;
  };

  const overlay = (
    <div
      data-testid="child-conversation-backdrop"
      className="absolute inset-0 z-40 flex items-stretch justify-center bg-background/70 p-5 backdrop-blur-md"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="child-conversation-viewer-title"
        data-testid="child-conversation-viewer"
        className="flex h-full max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-[var(--surface-control)] text-popover-foreground shadow-[var(--shadow-popover)]"
      >
        <header className="flex h-10 shrink-0 items-center gap-2 px-4">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
            {agentId ? (
              <AgentTypeIcon agentType={agentId} className="h-5 w-5" />
            ) : (
              <Bot className="h-5 w-5" />
            )}
          </span>
          <h2
            id="child-conversation-viewer-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          >
            {title}
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            onClick={onClose}
            aria-label={t('childViewer.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div
          data-testid="child-conversation-thread"
          className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl bg-background"
        >
          <div
            ref={scrollRef}
            data-panel="child-conversation-logs"
            className="h-full overflow-y-auto px-2 py-3"
          >
            {conversation.loading && messages.length === 0 ? (
              <ConversationTimelineSkeleton label={t('childViewer.loading')} />
            ) : stream.length === 0 && leftoverSideRows.length === 0 ? (
              <div className="grid min-h-[160px] place-items-center text-xs text-muted-foreground">
                {conversation.error ?? t('childViewer.empty')}
              </div>
            ) : (
              <SubagentLifecycleProvider turns={turnsForProvider}>
                <div className="conv-thread-shell relative mx-auto w-full">
                  <div className="conv-thread-content min-w-0 space-y-3">
                    {shouldVirtualize ? (
                      <div
                        ref={listRef}
                        data-testid="child-conversation-virtual-list"
                        className="relative w-full"
                        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                      >
                        <div
                          className="absolute top-0 left-0 w-full"
                          style={{
                            transform: getVirtualWindowTranslateY(
                              rowVirtualizer.getVirtualItems()[0]?.start,
                              scrollMargin
                            ),
                          }}
                        >
                          {rowVirtualizer
                            .getVirtualItems()
                            .map((virtualRow) => {
                              const row = renderRows[virtualRow.index];
                              if (!row) return null;
                              return (
                                <div
                                  key={virtualRow.key}
                                  ref={rowVirtualizer.measureElement}
                                  data-index={virtualRow.index}
                                  className="w-full pb-3"
                                >
                                  {renderChildRow(row)}
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    ) : (
                      renderRows.map((row) => (
                        <div key={row.key}>{renderChildRow(row)}</div>
                      ))
                    )}
                    {conversation.error ? (
                      <div
                        role="alert"
                        className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      >
                        {conversation.error}
                      </div>
                    ) : null}
                  </div>
                </div>
              </SubagentLifecycleProvider>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return host ? createPortal(overlay, host) : overlay;
}

function ChildInlineSideRow({
  entry,
  respondingId,
  onRespondQuestion,
}: {
  entry: TimelineRow;
  respondingId: string | null;
  onRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void;
}) {
  const row = entry.row;
  if (row.kind === 'question_request') {
    return (
      <QuestionRequestCard
        request={row.request}
        response={row.response ?? null}
        onRespond={onRespondQuestion}
        responding={respondingId === row.request.question_id}
      />
    );
  }
  if (row.kind === 'feedback_request') {
    return (
      <div className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info-foreground">
        <div className="font-medium">
          {i18n.t('panels:ui.childConversation.feedbackRequested')}
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-info-foreground/80">
          {row.request.prompt}
        </div>
      </div>
    );
  }
  if (row.kind === 'terminal_summary') {
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">
          {row.terminal.command ?? 'Terminal'} · {row.terminal.status}
        </div>
        {row.terminal.output_summary ? (
          <div className="mt-1 whitespace-pre-wrap break-words">
            {row.terminal.output_summary}
          </div>
        ) : null}
      </div>
    );
  }
  if (row.kind === 'artifact_revision') {
    return <ArtifactTimelineCard artifact={row.artifact} />;
  }
  return null;
}

function childConversationStream(
  items: ConversationTimelineItem[],
  messages: ConversationTimelineTurn[],
  taskPreview: string | null
): ConversationTimelineItem[] {
  const stream =
    items.length > 0
      ? items
      : messages.map((item) => ({
          kind: 'message' as const,
          revision: item.revision,
          item,
        }));
  const hasUser = stream.some(
    (entry) => entry.kind === 'message' && entry.item.turn.role === 'user'
  );
  const prompt = taskPreview?.trim();
  if (hasUser || !prompt) return stream;
  return [delegatedTaskItem(prompt), ...stream];
}

function leftoverUninlinedSideRows(
  sideRows: TimelineRow[],
  stream: ConversationTimelineItem[]
): TimelineRow[] {
  const inlined = new Set(
    stream.flatMap((entry) => (entry.kind === 'side' ? [entry.row.row_id] : []))
  );
  return sideRows.filter((row) => !inlined.has(row.row_id));
}

function delegatedTaskItem(text: string): ConversationTimelineItem {
  const turn: MessageTurn = {
    id: 'delegated-task:user',
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: new Date(0).toISOString(),
  };
  return {
    kind: 'message',
    revision: 0n,
    item: {
      key: 'delegated-task:user',
      phase: 'persisted',
      revision: 0n,
      turn,
    },
  };
}
