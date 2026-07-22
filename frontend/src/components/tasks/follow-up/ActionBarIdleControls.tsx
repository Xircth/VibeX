import { Button } from '@/components/ui/button';
import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

const CLEAR_REVIEW_LABEL = '\u6e05\u9664\u5ba1\u67e5';
const SEND_LABEL = '\u53d1\u9001';
const RESOLVE_CONFLICT_LABEL = '\u89e3\u51b3\u51b2\u7a81';

type ActionBarIdleControlsProps = {
  isEditable: boolean;
  isAwaitingNewSessionConfirmation: boolean;
  isSendingFollowUp: boolean;
  canSendFollowUp: boolean;
  hasComments: boolean;
  hasConflictResolutionInstructions: boolean;
  onSendFollowUp: () => void;
  onClearComments: () => void;
};

export function ActionBarIdleControls({
  isEditable,
  isAwaitingNewSessionConfirmation,
  isSendingFollowUp,
  canSendFollowUp,
  hasComments,
  hasConflictResolutionInstructions,
  onSendFollowUp,
  onClearComments,
}: ActionBarIdleControlsProps) {
  const sendLabel = hasConflictResolutionInstructions
    ? RESOLVE_CONFLICT_LABEL
    : SEND_LABEL;

  return (
    <div className="flex items-center gap-1">
      {hasComments ? (
        <Button
          onClick={onClearComments}
          size="sm"
          variant="destructive"
          disabled={!isEditable}
          className="h-7 px-2 text-xs"
        >
          {CLEAR_REVIEW_LABEL}
        </Button>
      ) : null}

      <ComposerPrimaryActionButton
        action="send"
        label={sendLabel}
        onClick={onSendFollowUp}
        disabled={
          !canSendFollowUp || !isEditable || isAwaitingNewSessionConfirmation
        }
        pending={isSendingFollowUp}
      />
    </div>
  );
}
