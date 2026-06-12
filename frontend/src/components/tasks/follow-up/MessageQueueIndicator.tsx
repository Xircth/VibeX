import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { QueuedMessage } from './sessionComposerQueue';
import { cn } from '@/lib/utils';

interface MessageQueueIndicatorProps {
  isQueued: boolean;
  queuedMessage?: QueuedMessage | null;
  messagePreview?: string | null;
  attachmentCount?: number;
  onEditQueuedMessage?: (message: QueuedMessage) => void;
  onDeleteQueuedMessage?: () => void;
}

export function MessageQueueIndicator({
  isQueued,
  queuedMessage,
  messagePreview,
  attachmentCount = 0,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
}: MessageQueueIndicatorProps) {
  const [expanded, setExpanded] = useState(false);
  if (!isQueued) return null;

  const preview = queuedMessage?.data.message ?? messagePreview ?? '';
  const images = queuedMessage?.data.images ?? [];
  const visibleAttachmentCount = images.length || attachmentCount;

  return (
    <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-1 font-medium">
            <span className="truncate">
              消息已排队，当前运行完成后会自动发送。
            </span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 flex-none transition-transform',
                expanded ? 'rotate-180' : ''
              )}
            />
          </div>
          {preview ? (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/90">
              {preview}
            </div>
          ) : null}
          {visibleAttachmentCount > 0 ? (
            <div className="mt-0.5 text-xs text-muted-foreground/90">
              {visibleAttachmentCount} image
              {visibleAttachmentCount === 1 ? '' : 's'} attached
            </div>
          ) : null}
        </button>
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            className="rounded p-1 hover:bg-background/80 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => queuedMessage && onEditQueuedMessage?.(queuedMessage)}
            disabled={!queuedMessage || !onEditQueuedMessage}
            aria-label="编辑队列消息"
            title="编辑队列消息"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-background/80 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onDeleteQueuedMessage}
            disabled={!onDeleteQueuedMessage}
            aria-label="删除队列消息"
            title="删除队列消息"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 opacity-40"
            disabled
            aria-label="上移队列消息"
            title="当前仅支持单条队列"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 opacity-40"
            disabled
            aria-label="下移队列消息"
            title="当前仅支持单条队列"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2 text-xs">
          {preview ? (
            <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-foreground">
              {preview}
            </div>
          ) : null}
          {images.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {images.map((image) => (
                <span
                  key={image}
                  className="max-w-full truncate rounded bg-background/60 px-2 py-1 font-mono text-[11px]"
                  title={image}
                >
                  {image}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

