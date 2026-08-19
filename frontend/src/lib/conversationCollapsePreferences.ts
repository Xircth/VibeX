export const DEFAULT_COLLAPSE_PREFERENCES = {
  aiMessagesCollapsed: true,
  filesChangedCollapsed: true,
  hideModelThinking: true,
} as const;

type ConversationCollapseConfig = {
  ai_message_default_collapsed?: boolean;
  files_changed_default_collapsed?: boolean;
  hide_model_thinking?: boolean;
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

export function resolveHideModelThinking(
  config: ConversationCollapseConfig | null | undefined
): boolean {
  return (
    config?.hide_model_thinking ??
    DEFAULT_COLLAPSE_PREFERENCES.hideModelThinking
  );
}
