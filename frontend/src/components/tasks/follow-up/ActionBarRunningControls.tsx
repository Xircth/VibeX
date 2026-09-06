import { ChevronUp, Clock, CornerDownLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

type SteeringChannel = 'native' | 'pull';

type ActionBarRunningControlsProps = {
  isQueueLoading: boolean;
  isCompactingContext: boolean;
  isStopping: boolean;
  isSteering?: boolean;
  steeringChannel?: SteeringChannel | null;
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
  steeringChannel = null,
  hasQueueableContent,
  sessionId,
  onQueueMessage,
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
      {!isCompactingContext ? (
        <div className="flex items-center">
          <Button
            onClick={onQueueMessage}
            disabled={isQueueLoading || !sessionId || !hasQueueableContent}
            size="sm"
            variant="ghost"
            className={
              canSteer ? 'h-7 rounded-r-none px-2 text-xs' : 'h-7 px-2 text-xs'
            }
            aria-label={t('composer.queueMessage')}
          >
            {isQueueLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <>
                <Clock className="mr-1 h-3.5 w-3.5" />
                {t('composer.queueMessage')}
              </>
            )}
          </Button>
          {canSteer ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  disabled={isSteering || !sessionId || !hasQueueableContent}
                  size="sm"
                  variant="ghost"
                  className="h-7 w-5 rounded-l-none border-l border-border px-0"
                  aria-label={steerLabel}
                >
                  {isSteering ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <ChevronUp className="h-3.5 w-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuItem
                  onSelect={() => onSteer?.()}
                  disabled={isSteering}
                >
                  <CornerDownLeft className="mr-2 h-3.5 w-3.5" />
                  {steerLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
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
