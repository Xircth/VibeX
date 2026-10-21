export const CONVERSATION_SCROLL_TO_TURN_EVENT =
  'vibex:conversation-scroll-to-turn';

export type ConversationScrollToTurnDetail = {
  conversationId: string;
  turnId: string;
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
