export const DEFAULT_COLLAPSE_PREFERENCES = {
  aiMessagesCollapsed: true,
  filesChangedCollapsed: true,
} as const;

type ConversationCollapseConfig = {
  ai_message_default_collapsed?: boolean;
  files_changed_default_collapsed?: boolean;
};

export function resolveConversationCollapsePreferences(
  config: ConversationCollapseConfig | null | undefined
): { collapseAiMessages: boolean; expandFileChanges: boolean } {
  return {
    collapseAiMessages:
      config?.ai_message_default_collapsed ??
      DEFAULT_COLLAPSE_PREFERENCES.aiMessagesCollapsed,
    expandFileChanges: !(
      config?.files_changed_default_collapsed ??
      DEFAULT_COLLAPSE_PREFERENCES.filesChangedCollapsed
    ),
  };
}
