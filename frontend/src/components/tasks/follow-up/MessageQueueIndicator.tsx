import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  Clock,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { QueuedMessage } from './sessionComposerQueue';
import { cn } from '@/lib/utils';

export function formatCountdownTimer(
  deliverAt: string | null | undefined,
  nowMs: number
): string {
  if (!deliverAt) return '00:00';
  const targetMs = Date.parse(deliverAt);
  if (!Number.isFinite(targetMs)) return '00:00';
  const remainingSec = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  const hours = Math.floor(remainingSec / 3600);
  const minutes = Math.floor((remainingSec % 3600) / 60);
  const seconds = remainingSec % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

interface MessageQueueIndicatorProps {
  isQueued?: boolean;
  queuedMessages?: QueuedMessage[];
  delayedMessages?: QueuedMessage[];
  canSteerQueued?: boolean;
  steeringQueued?: boolean;
  onSteerQueuedMessage?: (message: QueuedMessage) => void;
  onEditQueuedMessage?: (message: QueuedMessage) => void;
  onDeleteQueuedMessage?: (message: QueuedMessage) => void;
  onMoveQueuedMessage?: (message: QueuedMessage, direction: -1 | 1) => void;
  onDelayQueuedMessage?: (message: QueuedMessage, delaySeconds: number) => void;
}

export function MessageQueueIndicator({
  isQueued,
  queuedMessages = [],
  delayedMessages = [],
  canSteerQueued = false,
  steeringQueued = false,
  onSteerQueuedMessage,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onMoveQueuedMessage,
  onDelayQueuedMessage,
}: MessageQueueIndicatorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [expanded, setExpanded] = useState(false);
  const [delayedExpanded, setDelayedExpanded] = useState(true);
  const [delayingMessageId, setDelayingMessageId] = useState<string | null>(
    null
  );
  const [delayMinutesInput, setDelayMinutesInput] = useState('5');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasNormalQueue = (isQueued ?? queuedMessages.length > 0) && queuedMessages.length > 0;
  const hasDelayedQueue = delayedMessages.length > 0;

  useEffect(() => {
    if (!hasDelayedQueue) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasDelayedQueue]);

  if (!hasNormalQueue && !hasDelayedQueue) return null;

  const submitDelayMinutes = (message: QueuedMessage) => {
    const minutes = Number(delayMinutesInput.trim());
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const delaySeconds = Math.max(1, Math.round(minutes * 60));
    onDelayQueuedMessage?.(message, delaySeconds);
    setDelayingMessageId(null);
  };

  return (
    <div className="space-y-1.5">
      {hasNormalQueue ? (
        <div
          className="overflow-hidden rounded-lg border border-border bg-muted/55 text-sm text-muted-foreground"
          data-testid="normal-message-queue"
        >
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 px-2.5 text-left hover:bg-muted/80"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <Clock className="h-3.5 w-3.5 flex-none" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
              {t('messageQueue.descriptionCount', {
                count: queuedMessages.length,
              })}
            </span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 flex-none transition-transform motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
          </button>

          {expanded ? (
            <ol className="divide-y divide-border border-t border-border">
              {queuedMessages.map((message, index) => {
                const claimed = message.status === 'claimed';
                const isDelayInputOpen = delayingMessageId === message.id;
                return (
                  <li
                    key={message.id}
                    className="flex min-h-9 items-center gap-2 px-2.5 py-1.5"
                  >
                    <span className="w-4 flex-none text-center text-[11px] tabular-nums">
                      {claimed ? (
                        <Loader2
                          className="mx-auto h-3 w-3 animate-spin motion-reduce:animate-none"
                          aria-label={t('messageQueue.sending')}
                        />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {message.data.message || t('messageQueue.attachmentOnly')}
                    </span>
                    {message.data.images.length > 0 ? (
                      <span className="flex-none text-[11px] tabular-nums">
                        +{message.data.images.length}
                      </span>
                    ) : null}
                    <div className="flex flex-none items-center gap-0.5">
                      <QueueAction
                        label={t('messageQueue.editMessage')}
                        disabled={claimed || !onEditQueuedMessage}
                        onClick={() => onEditQueuedMessage?.(message)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </QueueAction>
                      <QueueAction
                        label={t('messageQueue.delayMessage', {
                          defaultValue: '转为延时消息',
                        })}
                        testId={`delay-queued-message-${message.id}`}
                        disabled={claimed || !onDelayQueuedMessage}
                        onClick={() => {
                          if (isDelayInputOpen) {
                            setDelayingMessageId(null);
                          } else {
                            setDelayMinutesInput('5');
                            setDelayingMessageId(message.id);
                          }
                        }}
                      >
                        <Clock className="h-3.5 w-3.5" />
                      </QueueAction>
                      {isDelayInputOpen ? (
                        <input
                          type="number"
                          min={1}
                          step={1}
                          autoFocus
                          data-testid={`delay-minutes-input-${message.id}`}
                          value={delayMinutesInput}
                          onChange={(event) =>
                            setDelayMinutesInput(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.stopPropagation();
                              submitDelayMinutes(message);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              event.stopPropagation();
                              setDelayingMessageId(null);
                            }
                          }}
                          placeholder={t(
                            'messageQueue.delayMinutesPlaceholder',
                            {
                              defaultValue: '分钟',
                            }
                          )}
                          aria-label={t(
                            'messageQueue.delayMinutesPlaceholder',
                            {
                              defaultValue: '分钟',
                            }
                          )}
                          className="h-6 w-14 rounded border border-border bg-background px-1.5 text-[11px] tabular-nums text-foreground focus:border-primary focus:outline-none"
                        />
                      ) : null}
                      <QueueAction
                        label={t('messageQueue.deleteMessage')}
                        disabled={claimed || !onDeleteQueuedMessage}
                        onClick={() => onDeleteQueuedMessage?.(message)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </QueueAction>
                      {canSteerQueued ? (
                        <QueueAction
                          label={t('messageQueue.steer')}
                          disabled={
                            claimed || steeringQueued || !onSteerQueuedMessage
                          }
                          onClick={() => onSteerQueuedMessage?.(message)}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </QueueAction>
                      ) : null}
                      <QueueAction
                        label={t('messageQueue.moveUp')}
                        disabled={claimed || index === 0 || !onMoveQueuedMessage}
                        onClick={() => onMoveQueuedMessage?.(message, -1)}
                      >
                        <ChevronsUp className="h-3.5 w-3.5" />
                      </QueueAction>
                      <QueueAction
                        label={t('messageQueue.moveDown')}
                        disabled={
                          claimed ||
                          index === queuedMessages.length - 1 ||
                          !onMoveQueuedMessage
                        }
                        onClick={() => onMoveQueuedMessage?.(message, 1)}
                      >
                        <ChevronsDown className="h-3.5 w-3.5" />
                      </QueueAction>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}

      {hasDelayedQueue ? (
        <div
          className="overflow-hidden rounded-lg border border-border bg-muted/55 text-sm text-muted-foreground"
          data-testid="delayed-message-queue"
        >
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 px-2.5 text-left hover:bg-muted/80"
            onClick={() => setDelayedExpanded((value) => !value)}
            aria-expanded={delayedExpanded}
          >
            <Clock className="h-3.5 w-3.5 flex-none text-sky-500" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
              {t('messageQueue.delayedDescriptionCount', {
                count: delayedMessages.length,
                defaultValue: `延时消息队列 (${delayedMessages.length})`,
              })}
            </span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 flex-none transition-transform motion-reduce:transition-none',
                delayedExpanded && 'rotate-180'
              )}
            />
          </button>

          {delayedExpanded ? (
            <ol className="divide-y divide-border border-t border-border">
              {delayedMessages.map((message, index) => (
                <li
                  key={message.id}
                  className="flex min-h-9 items-center gap-2 px-2.5 py-1.5"
                >
                  <span className="w-4 flex-none text-center text-[11px] tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {message.data.message || t('messageQueue.attachmentOnly')}
                  </span>
                  {message.data.images.length > 0 ? (
                    <span className="flex-none text-[11px] tabular-nums">
                      +{message.data.images.length}
                    </span>
                  ) : null}
                  <div className="flex flex-none items-center gap-1">
                    <span
                      className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-sky-600 dark:text-sky-400"
                      data-testid={`delayed-countdown-${message.id}`}
                    >
                      <Clock className="h-3 w-3" />
                      {formatCountdownTimer(message.deliverAt, nowMs)}
                    </span>
                    {onEditQueuedMessage ? (
                      <QueueAction
                        label={t('messageQueue.editMessage')}
                        disabled={false}
                        onClick={() => onEditQueuedMessage(message)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </QueueAction>
                    ) : null}
                    {onDeleteQueuedMessage ? (
                      <QueueAction
                        label={t('messageQueue.deleteMessage')}
                        disabled={false}
                        onClick={() => onDeleteQueuedMessage(message)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </QueueAction>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QueueAction({
  label,
  testId,
  disabled,
  onClick,
  children,
}: {
  label: string;
  testId?: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="rounded-md p-1 hover:bg-background/80 disabled:cursor-not-allowed disabled:opacity-35"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
