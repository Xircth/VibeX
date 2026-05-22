import { Clock } from 'lucide-react';

interface MessageQueueIndicatorProps {
  isQueued: boolean;
  messagePreview?: string | null;
  attachmentCount?: number;
}

export function MessageQueueIndicator({
  isQueued,
  messagePreview,
  attachmentCount = 0,
}: MessageQueueIndicatorProps) {
  if (!isQueued) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted p-3 text-sm text-muted-foreground">
      <Clock className="h-4 w-4 flex-shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">
          {'消息已排队，当前运行完成后会自动发送。'}
        </div>
        {messagePreview ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground/90">
            {messagePreview}
          </div>
        ) : null}
        {attachmentCount > 0 ? (
          <div className="mt-0.5 text-xs text-muted-foreground/90">
            {attachmentCount} image{attachmentCount === 1 ? '' : 's'} attached
          </div>
        ) : null}
      </div>
    </div>
  );
}
