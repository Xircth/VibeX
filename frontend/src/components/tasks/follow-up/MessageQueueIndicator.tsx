import { Clock } from 'lucide-react';

interface MessageQueueIndicatorProps {
  isQueued: boolean;
}

export function MessageQueueIndicator({
  isQueued,
}: MessageQueueIndicatorProps) {
  if (!isQueued) return null;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-md border">
      <Clock className="h-4 w-4 flex-shrink-0" />
      <div className="font-medium">
        {'消息已排队 - 将在当前运行完成时执行'}
      </div>
    </div>
  );
}
