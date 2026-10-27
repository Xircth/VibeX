export const CONVERSATION_SCROLL_TO_TURN_EVENT =
  'vibex:conversation-scroll-to-turn';

export const CONVERSATION_SCROLL_TO_GOAL_EVENT =
  'vibex:conversation-scroll-to-goal';

export type ConversationScrollToTurnDetail = {
  conversationId: string;
  turnId: string;
};

export type ConversationScrollToGoalDetail = {
  conversationId: string;
};

export function requestConversationScrollToTurn(
  conversationId: string,
  turnId: string
): void {
  if (!conversationId || !turnId) return;
  window.dispatchEvent(
    new CustomEvent<ConversationScrollToTurnDetail>(
      CONVERSATION_SCROLL_TO_TURN_EVENT,
      { detail: { conversationId, turnId } }
    )
  );
}

export function requestConversationScrollToGoal(conversationId: string): void {
  if (!conversationId) return;
  window.dispatchEvent(
    new CustomEvent<ConversationScrollToGoalDetail>(
      CONVERSATION_SCROLL_TO_GOAL_EVENT,
      { detail: { conversationId } }
    )
  );
}
