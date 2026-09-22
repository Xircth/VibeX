import { CornerDownLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

type SteeringChannel = 'native' | 'pull';

type ActionBarRunningControlsProps = {
  isCompactingContext: boolean;
  isStopping: boolean;
  isSteering?: boolean;
  steeringChannel?: SteeringChannel | null;
  hasQueueableContent: boolean;
  sessionId?: string;
  onSteer?: () => void;
  onStopExecution: () => void;
};

export function ActionBarRunningControls({
  isCompactingContext,
  isStopping,
  isSteering = false,
  steeringChannel = null,
  hasQueueableContent,
  sessionId,
  onSteer,
  onStopExecution,
}: ActionBarRunningControlsProps) {
  const { t } = useTranslation('tasks');
  const canSteer = Boolean(steeringChannel && onSteer);
  const steerLabel =
    steeringChannel === 'pull'
      ? t('composer.steerAsNote')
      : t('composer.steerIntoTurn');

  return (
    <div className="flex items-center gap-1">
      {canSteer && !isCompactingContext ? (
        <Button
          onClick={() => onSteer?.()}
          disabled={isSteering || !sessionId || !hasQueueableContent}
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          aria-label={steerLabel}
        >
          {isSteering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <>
              <CornerDownLeft className="mr-1 h-3.5 w-3.5" />
              {steerLabel}
            </>
          )}
        </Button>
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
