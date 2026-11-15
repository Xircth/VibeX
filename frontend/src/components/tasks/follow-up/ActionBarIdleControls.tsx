import { useTranslation } from 'react-i18next';
import type { SendMessageShortcut } from 'shared/types';
import { Button } from '@/components/ui/button';
import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

function formatSendShortcutHint(
  shortcut: SendMessageShortcut | null | undefined
): string | null {
  if (!shortcut) return null;
  if (shortcut === 'ModifierEnter') {
    const isApplePlatform =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad|iPod/i.test(
        navigator.platform || navigator.userAgent || ''
      );
    return isApplePlatform ? '⌘+Enter' : 'Ctrl+Enter';
  }
  return 'Enter';
}

type ActionBarIdleControlsProps = {
  isEditable: boolean;
  isAwaitingNewSessionConfirmation: boolean;
  isSendingFollowUp: boolean;
  canSendFollowUp: boolean;
  hasComments: boolean;
  hasConflictResolutionInstructions: boolean;
  sendShortcut?: SendMessageShortcut | null;
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
  sendShortcut = null,
  onSendFollowUp,
  onClearComments,
}: ActionBarIdleControlsProps) {
  const { t } = useTranslation('tasks');
  const clearReviewLabel = t('composer.clearReview', '清除审查');
  const sendLabel = hasConflictResolutionInstructions
    ? t('composer.resolveConflict', '解决冲突')
    : t('composer.send', '发送');

  return (
    <div className="flex items-center gap-1">
      {hasComments ? (
        <Button
          onClick={onClearComments}
          size="sm"
          variant="destructive"
          disabled={!isEditable}
          className="h-8 px-2.5 text-sm"
        >
          {clearReviewLabel}
        </Button>
      ) : null}

      <ComposerPrimaryActionButton
        action="send"
        label={sendLabel}
        shortcutHint={formatSendShortcutHint(sendShortcut)}
        onClick={onSendFollowUp}
        disabled={
          !canSendFollowUp || !isEditable || isAwaitingNewSessionConfirmation
        }
        pending={isSendingFollowUp}
      />
    </div>
  );
}
