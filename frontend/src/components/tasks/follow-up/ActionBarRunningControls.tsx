import { Clock, Loader2, StopCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

type ActionBarRunningControlsProps = {
  isQueued: boolean;
  isQueueLoading: boolean;
  isCompactingContext: boolean;
  isStopping: boolean;
  hasQueueableContent: boolean;
  sessionId?: string;
  onQueueMessage: () => void;
  onCancelQueue: () => void;
  onStopExecution: () => void;
};

export function ActionBarRunningControls({
  isQueued,
  isQueueLoading,
  isCompactingContext,
  isStopping,
  hasQueueableContent,
  sessionId,
  onQueueMessage,
  onCancelQueue,
  onStopExecution,
}: ActionBarRunningControlsProps) {
  return (
    <div className="flex items-center gap-1">
      {!isCompactingContext
        ? isQueued
          ? (
              <Button
                onClick={onCancelQueue}
                disabled={isQueueLoading || !sessionId}
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                aria-label={'\u53d6\u6d88\u961f\u5217'}
              >
                {isQueueLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <X className="mr-1 h-3.5 w-3.5" />
                    {'\u53d6\u6d88\u961f\u5217'}
                  </>
                )}
              </Button>
            )
          : (
              <Button
                onClick={onQueueMessage}
                disabled={isQueueLoading || !sessionId || !hasQueueableContent}
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                aria-label={'\u961f\u5217'}
              >
                {isQueueLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Clock className="mr-1 h-3.5 w-3.5" />
                    {'\u961f\u5217'}
                  </>
                )}
              </Button>
            )
        : null}
      <Button
        onClick={onStopExecution}
        disabled={isStopping}
        size="sm"
        variant="destructive"
        className="h-7 px-2 text-xs"
        aria-label={'\u505c\u6b62'}
      >
        {isStopping ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <>
            <StopCircle className="mr-1 h-3.5 w-3.5" />
            {'\u505c\u6b62'}
          </>
        )}
      </Button>
    </div>
  );
}
