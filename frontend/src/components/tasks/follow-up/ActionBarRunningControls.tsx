import { Clock, CornerDownLeft, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

type ActionBarRunningControlsProps = {
  isQueueLoading: boolean;
  isCompactingContext: boolean;
  isStopping: boolean;
  isSteering?: boolean;
  supportsSteering?: boolean;
  hasQueueableContent: boolean;
  sessionId?: string;
  onQueueMessage: () => void;
  onSteer?: () => void;
  onStopExecution: () => void;
};

export function ActionBarRunningControls({
  isQueueLoading,
  isCompactingContext,
  isStopping,
  isSteering = false,
  supportsSteering = false,
  hasQueueableContent,
  sessionId,
  onQueueMessage,
  onSteer,
  onStopExecution,
}: ActionBarRunningControlsProps) {
  return (
    <div className="flex items-center gap-1">
      {!isCompactingContext ? (
        <>
          {supportsSteering ? (
            <Button
              onClick={onSteer}
              disabled={isSteering || !sessionId || !hasQueueableContent}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              aria-label={'\u7ea0\u504f'}
            >
              {isSteering ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <>
                  <CornerDownLeft className="mr-1 h-3.5 w-3.5" />
                  {'\u7ea0\u504f'}
                </>
              )}
            </Button>
          ) : null}
          <Button
            onClick={onQueueMessage}
            disabled={isQueueLoading || !sessionId || !hasQueueableContent}
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            aria-label={'\u961f\u5217'}
          >
            {isQueueLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <>
                <Clock className="mr-1 h-3.5 w-3.5" />
                {'\u961f\u5217'}
              </>
            )}
          </Button>
        </>
      ) : null}
      <ComposerPrimaryActionButton
        action="stop"
        label={'\u505c\u6b62'}
        onClick={onStopExecution}
        disabled={isStopping}
        pending={isStopping}
      />
    </div>
  );
}
