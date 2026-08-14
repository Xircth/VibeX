import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { QueuedMessage } from './sessionComposerQueue';
import { cn } from '@/lib/utils';

interface MessageQueueIndicatorProps {
  isQueued: boolean;
  queuedMessages?: QueuedMessage[];
  onEditQueuedMessage?: (message: QueuedMessage) => void;
  onDeleteQueuedMessage?: (message: QueuedMessage) => void;
  onMoveQueuedMessage?: (message: QueuedMessage, direction: -1 | 1) => void;
}

export function MessageQueueIndicator({
  isQueued,
  queuedMessages = [],
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onMoveQueuedMessage,
}: MessageQueueIndicatorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [expanded, setExpanded] = useState(false);
  if (!isQueued || queuedMessages.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/55 text-sm text-muted-foreground">
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
                    label={t('messageQueue.deleteMessage')}
                    disabled={claimed || !onDeleteQueuedMessage}
                    onClick={() => onDeleteQueuedMessage?.(message)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </QueueAction>
                  <QueueAction
                    label={t('messageQueue.moveUp')}
                    disabled={claimed || index === 0 || !onMoveQueuedMessage}
                    onClick={() => onMoveQueuedMessage?.(message, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
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
                    <ArrowDown className="h-3.5 w-3.5" />
                  </QueueAction>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function QueueAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
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
