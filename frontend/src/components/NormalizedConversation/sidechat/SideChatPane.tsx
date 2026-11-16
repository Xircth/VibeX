import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  CheckCircle2,
  CornerDownLeft,
  Loader2,
  MessageSquareShare,
  Send,
  Split,
  Square,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageTurn } from 'shared/types';
import { Button } from '@/components/ui/button';
import { requestComposerTokenInsert } from '@/lib/composerInsert';
import { cn } from '@/lib/utils';
import { AstryxMarkdown } from '../AstryxMarkdown';
import {
  buildSideChatConclusionQuote,
  defaultSideChatClient,
  extractRecentMainThreadTurns,
  type SideChatClient,
  type SideChatMessage,
  type SideChatToolCall,
} from './sideChatClient';

export interface SideChatMergeBackPayload {
  userQuestion: string;
  assistantAnswer: string;
  formattedToken: string;
}

export interface SideChatPaneProps {
  conversationId?: string | null;
  turns?: ReadonlyArray<MessageTurn | { turn: MessageTurn }>;
  workspacePath?: string | null;
  client?: SideChatClient;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onMergeBack?: (payload: SideChatMergeBackPayload) => void;
  showTriggerButton?: boolean;
}

function makeSideChatSessionId(conversationId?: string | null): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${conversationId || 'ephemeral'}-side-${suffix}`;
}

function upsertToolCall(
  existing: SideChatToolCall[] | undefined,
  incoming: SideChatToolCall
): SideChatToolCall[] {
  const list = existing ? [...existing] : [];
  const index = list.findIndex((item) => item.id === incoming.id);
  if (index >= 0) {
    list[index] = { ...list[index], ...incoming };
    return list;
  }
  list.push(incoming);
  return list;
}

export function SideChatPane({
  conversationId,
  turns,
  workspacePath,
  client = defaultSideChatClient,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  onMergeBack,
  showTriggerButton = false,
}: SideChatPaneProps) {
  const { t } = useTranslation(['conversation', 'common']);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const [sideChatId, setSideChatId] = useState(() =>
    makeSideChatSessionId(conversationId)
  );
  const [messages, setMessages] = useState<SideChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingDeltaRef = useRef<{ messageId: string; text: string } | null>(
    null
  );
  const deltaRafRef = useRef<{
    id: number;
    kind: 'raf' | 'timeout';
  } | null>(null);

  const cancelScheduledDeltaFlush = useCallback(() => {
    const scheduled = deltaRafRef.current;
    if (!scheduled) return;
    deltaRafRef.current = null;
    if (scheduled.kind === 'raf') {
      cancelAnimationFrame(scheduled.id);
    } else {
      window.clearTimeout(scheduled.id);
    }
  }, []);

  const flushPendingDelta = useCallback(() => {
    cancelScheduledDeltaFlush();
    const pending = pendingDeltaRef.current;
    pendingDeltaRef.current = null;
    if (!pending || !pending.text) return;
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === pending.messageId
          ? { ...msg, content: msg.content + pending.text }
          : msg
      )
    );
  }, [cancelScheduledDeltaFlush]);

  const contextTurns = useMemo(
    () => extractRecentMainThreadTurns(turns, 3),
    [turns]
  );

  const resetEphemeralState = useCallback(() => {
    cancelScheduledDeltaFlush();
    pendingDeltaRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
    setMessages([]);
    setDraft('');
    setSideChatId(makeSideChatSessionId(conversationId));
  }, [cancelScheduledDeltaFlush, conversationId]);

  const handleDiscard = useCallback(() => {
    if (isStreaming && conversationId) {
      void client.abortSideChat({ conversationId, sideChatId });
    }
    resetEphemeralState();
    setOpen(false);
  }, [client, conversationId, isStreaming, resetEphemeralState, setOpen, sideChatId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isShortcut =
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 's';
      if (!isShortcut) return;
      event.preventDefault();
      if (isOpen) {
        handleDiscard();
      } else {
        setSideChatId(makeSideChatSessionId(conversationId));
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [conversationId, handleDiscard, isOpen, setOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(
    () => () => {
      cancelScheduledDeltaFlush();
      pendingDeltaRef.current = null;
      abortControllerRef.current?.abort();
    },
    [cancelScheduledDeltaFlush]
  );

  const latestConclusionPair = useMemo(() => {
    let lastAssistant = '';
    let lastUser = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!lastAssistant && msg.role === 'assistant' && !msg.isError) {
        const trimmed = msg.content.trim();
        if (trimmed) {
          lastAssistant = trimmed;
        }
      } else if (lastAssistant && !lastUser && msg.role === 'user') {
        lastUser = msg.content.trim();
        break;
      }
    }
    if (!lastAssistant) return null;
    if (!lastUser) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
          lastUser = messages[i].content.trim();
          break;
        }
      }
    }
    return {
      userQuestion: lastUser,
      assistantAnswer: lastAssistant,
    };
  }, [messages]);

  const handleMergeBack = useCallback(() => {
    if (!latestConclusionPair) return;
    const { formattedToken, chipLabel } = buildSideChatConclusionQuote({
      userQuestion: latestConclusionPair.userQuestion,
      assistantAnswer: latestConclusionPair.assistantAnswer,
      prefixLabel: t('conversation:sideChat.mergeBackPrefix'),
      questionLabel: t('conversation:sideChat.questionLabel'),
      answerLabel: t('conversation:sideChat.answerLabel'),
    });

    requestComposerTokenInsert({
      value: formattedToken,
      label: chipLabel,
      conversationId,
    });

    onMergeBack?.({
      userQuestion: latestConclusionPair.userQuestion,
      assistantAnswer: latestConclusionPair.assistantAnswer,
      formattedToken,
    });

    resetEphemeralState();
    setOpen(false);
  }, [
    conversationId,
    latestConclusionPair,
    onMergeBack,
    resetEphemeralState,
    setOpen,
    t,
  ]);

  const handleStopStreaming = useCallback(() => {
    flushPendingDelta();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
    setMessages((prev) =>
      prev.map((item) =>
        item.isStreaming ? { ...item, isStreaming: false } : item
      )
    );
    if (conversationId) {
      void client.abortSideChat({ conversationId, sideChatId });
    }
  }, [client, conversationId, flushPendingDelta, sideChatId]);

  const handleSend = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || isStreaming) return;

    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `assistant-${Date.now() + 1}`;
    const priorHistory = messages
      .filter((m) => !m.isError && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    setDraft('');
    setIsStreaming(true);
    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: 'user', content: prompt },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
      },
    ]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await client.sendSideChatPrompt({
        conversationId: conversationId ?? 'ephemeral',
        sideChatId,
        prompt,
        contextTurns,
        history: priorHistory,
        signal: controller.signal,
        onEvent: (event) => {
          if (controller.signal.aborted) return;
          if (event.type === 'delta') {
            if (pendingDeltaRef.current?.messageId === assistantMessageId) {
              pendingDeltaRef.current.text += event.text;
            } else {
              pendingDeltaRef.current = {
                messageId: assistantMessageId,
                text: event.text,
              };
            }
            if (!deltaRafRef.current) {
              if (typeof window.requestAnimationFrame === 'function') {
                deltaRafRef.current = {
                  kind: 'raf',
                  id: window.requestAnimationFrame(() => {
                    deltaRafRef.current = null;
                    flushPendingDelta();
                  }),
                };
              } else {
                deltaRafRef.current = {
                  kind: 'timeout',
                  id: window.setTimeout(() => {
                    deltaRafRef.current = null;
                    flushPendingDelta();
                  }, 16),
                };
              }
            }
          } else if (event.type === 'tool') {
            flushPendingDelta();
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      toolCalls: upsertToolCall(msg.toolCalls, event.toolCall),
                    }
                  : msg
              )
            );
          } else if (event.type === 'done' && event.content !== undefined) {
            flushPendingDelta();
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? { ...msg, content: event.content ?? msg.content }
                  : msg
              )
            );
          } else if (event.type === 'error') {
            flushPendingDelta();
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      content: event.message,
                      isError: true,
                      isStreaming: false,
                    }
                  : msg
              )
            );
          }
        },
      });

      if (controller.signal.aborted) return;
      flushPendingDelta();

      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== assistantMessageId) return msg;
          const nextContent =
            result.content.trim().length > 0 ? result.content : msg.content;
          const mergedTools = result.toolCalls
            ? result.toolCalls.reduce<SideChatToolCall[] | undefined>(
                (acc, tc) => upsertToolCall(acc, tc),
                msg.toolCalls
              )
            : msg.toolCalls;
          return {
            ...msg,
            content: nextContent,
            toolCalls: mergedTools,
            isStreaming: false,
          };
        })
      );
    } catch (error) {
      cancelScheduledDeltaFlush();
      pendingDeltaRef.current = null;
      if (controller.signal.aborted) return;
      const errMessage =
        error instanceof Error ? error.message : String(error);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: errMessage,
                isError: true,
                isStreaming: false,
              }
            : msg
        )
      );
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsStreaming(false);
      }
    }
  }, [
    cancelScheduledDeltaFlush,
    client,
    contextTurns,
    conversationId,
    draft,
    flushPendingDelta,
    isStreaming,
    messages,
    sideChatId,
  ]);

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void handleSend();
    }
  };

  if (!isOpen) {
    if (!showTriggerButton) return null;
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setSideChatId(makeSideChatSessionId(conversationId));
          setOpen(true);
        }}
        title={t('conversation:sideChat.openShortcutHint')}
        aria-label={t('conversation:sideChat.openShortcutHint')}
        data-testid="side-chat-open-trigger"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Split className="h-3.5 w-3.5" />
        <span>{t('conversation:sideChat.title')}</span>
      </Button>
    );
  }

  return (
    <aside
      aria-label={t('conversation:sideChat.title')}
      data-testid="side-chat-pane"
      className="absolute inset-y-0 right-0 z-30 flex w-[40%] min-w-[320px] max-w-[560px] flex-col border-l border-border bg-background/95 shadow-xl backdrop-blur-md"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Split className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-semibold text-foreground">
            {t('conversation:sideChat.title')}
          </span>
          <span
            data-testid="side-chat-context-badge"
            className="shrink-0 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums"
          >
            {contextTurns.length > 0
              ? t('conversation:sideChat.contextBadge', {
                  count: contextTurns.length,
                })
              : t('conversation:sideChat.contextEmpty')}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!latestConclusionPair || isStreaming}
            onClick={handleMergeBack}
            data-testid="side-chat-merge-back"
            className="h-7 gap-1 px-2 text-xs"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
            <span>{t('conversation:sideChat.mergeBack')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDiscard}
            aria-label={t('conversation:sideChat.discard')}
            title={t('conversation:sideChat.discard')}
            data-testid="side-chat-discard"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        data-testid="side-chat-messages"
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center text-xs text-muted-foreground">
            <MessageSquareShare className="mb-2 h-5 w-5 opacity-60" />
            <p>{t('conversation:sideChat.emptyPrompt')}</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              data-testid={`side-chat-message-${msg.role}`}
              className={cn(
                'rounded-lg px-3 py-2 text-xs',
                msg.role === 'user'
                  ? 'ml-6 bg-primary/10 text-foreground'
                  : msg.isError
                    ? 'mr-4 border border-destructive/40 bg-destructive/10 text-destructive'
                    : 'mr-2 border border-border/60 bg-muted/30 text-foreground'
              )}
            >
              {msg.toolCalls && msg.toolCalls.length > 0 ? (
                <div
                  data-testid="side-chat-tool-list"
                  className="mb-2 space-y-1"
                >
                  {msg.toolCalls.map((tool) => (
                    <div
                      key={tool.id}
                      className="flex items-center gap-1.5 rounded bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground"
                    >
                      {tool.status === 'running' ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                      ) : tool.status === 'failed' ? (
                        <XCircle className="h-3 w-3 shrink-0 text-destructive" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 shrink-0 text-[hsl(var(--success))]" />
                      )}
                      <Wrench className="h-3 w-3 shrink-0 opacity-70" />
                      <span className="truncate font-medium text-foreground">
                        {tool.name}
                      </span>
                      {tool.summary ? (
                        <span className="min-w-0 flex-1 truncate opacity-80">
                          {tool.summary}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-[10px]">
                        {tool.status === 'running'
                          ? t('conversation:sideChat.toolRunning')
                          : tool.status === 'failed'
                            ? t('conversation:sideChat.toolFailed')
                            : t('conversation:sideChat.toolCompleted')}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {msg.role === 'assistant' && !msg.isError ? (
                msg.content ? (
                  <AstryxMarkdown
                    value={msg.content}
                    workspacePath={workspacePath}
                    isStreaming={msg.isStreaming}
                    className="text-xs"
                  />
                ) : msg.isStreaming ? (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  </div>
                ) : null
              ) : (
                <div className="whitespace-pre-wrap break-words">
                  {msg.content}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-ring">
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={t('conversation:sideChat.inputPlaceholder')}
            aria-label={t('conversation:sideChat.inputPlaceholder')}
            data-testid="side-chat-input"
            className="max-h-28 min-h-[36px] flex-1 resize-none bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {isStreaming ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleStopStreaming}
              aria-label={t('conversation:sideChat.stop')}
              data-testid="side-chat-stop"
              className="h-7 w-7 shrink-0 p-0"
            >
              <Square className="h-3 w-3" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!draft.trim()}
              onClick={() => void handleSend()}
              aria-label={t('conversation:sideChat.send')}
              data-testid="side-chat-send"
              className="h-7 w-7 shrink-0 p-0"
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
