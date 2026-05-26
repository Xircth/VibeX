import { useEffect } from 'react';
import { Scope } from '@/keyboard';
import { getComposerHotkeyScopeActivation } from './sessionComposerHotkeys';

export function useSessionComposerHotkeys({
  isEditable,
  isTextareaFocused,
  enableScope,
  disableScope,
}: {
  isEditable: boolean;
  isTextareaFocused: boolean;
  enableScope: (scope: Scope) => void;
  disableScope: (scope: Scope) => void;
}) {
  const { isFollowUpScopeActive, isFollowUpReadyScopeActive } =
    getComposerHotkeyScopeActivation({
      isEditable,
      isTextareaFocused,
    });

  useEffect(() => {
    if (isFollowUpScopeActive) {
      enableScope(Scope.FOLLOW_UP);
    } else {
      disableScope(Scope.FOLLOW_UP);
    }
    return () => {
      disableScope(Scope.FOLLOW_UP);
    };
  }, [isFollowUpScopeActive, enableScope, disableScope]);

  useEffect(() => {
    if (isFollowUpReadyScopeActive) {
      enableScope(Scope.FOLLOW_UP_READY);
    } else {
      disableScope(Scope.FOLLOW_UP_READY);
    }
    return () => {
      disableScope(Scope.FOLLOW_UP_READY);
    };
  }, [isFollowUpReadyScopeActive, enableScope, disableScope]);
}
