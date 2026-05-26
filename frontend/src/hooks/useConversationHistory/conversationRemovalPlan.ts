type ConversationRemovalPlanInput = {
  displayedProcessIds: string[];
  visibleProcessIds: string[];
  isLoading: boolean;
  hasError: boolean;
};

export function getConversationRemovalPlan({
  displayedProcessIds,
  visibleProcessIds,
  isLoading,
  hasError,
}: ConversationRemovalPlanInput): string[] {
  if (isLoading || hasError) {
    return [];
  }

  const visibleProcessIdSet = new Set(visibleProcessIds);
  return displayedProcessIds.filter((id) => !visibleProcessIdSet.has(id));
}
