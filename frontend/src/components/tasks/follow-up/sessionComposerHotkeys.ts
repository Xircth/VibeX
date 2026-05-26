export function getComposerHotkeyScopeActivation({
  isEditable,
  isTextareaFocused,
}: {
  isEditable: boolean;
  isTextareaFocused: boolean;
}): {
  isFollowUpScopeActive: boolean;
  isFollowUpReadyScopeActive: boolean;
} {
  const isComposerScopeActive = isEditable && isTextareaFocused;

  return {
    isFollowUpScopeActive: isComposerScopeActive,
    isFollowUpReadyScopeActive: isComposerScopeActive,
  };
}
