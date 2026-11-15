export const CONVERSATION_SCROLL_TO_TURN_EVENT =
  'vibex:conversation-scroll-to-turn';

export const CONVERSATION_SCROLL_TO_GOAL_EVENT =
  'vibex:conversation-scroll-to-goal';

export const CONVERSATION_SCROLL_TO_QUOTE_EVENT =
  'vibex:conversation-scroll-to-quote';

export type ConversationScrollToTurnDetail = {
  conversationId: string;
  turnId: string;
};

export type ConversationScrollToGoalDetail = {
  conversationId: string;
};

export type ConversationScrollToQuoteDetail = {
  conversationId?: string;
  turnId?: string;
  messageId?: string;
  turnOrdinal?: number;
  blockIndex?: number;
  snippet?: string;
  utf16Offset?: number;
  prefixAnchor?: string;
  suffixAnchor?: string;
};

const QUOTE_PULSE_CLASS = 'conv-quote-anchor-pulse';
const QUOTE_PULSE_DURATION_MS = 1400;
const PENDING_JUMP_TTL_MS = 8000;
const activePulseTimers = new WeakMap<HTMLElement, number>();
const pendingConversationJumps = new Map<
  string,
  { detail: ConversationScrollToQuoteDetail; expiresAt: number }
>();

export function recordPendingConversationJump(
  conversationId: string,
  detail: ConversationScrollToQuoteDetail
): void {
  if (!conversationId) return;
  pendingConversationJumps.set(conversationId, {
    detail: { ...detail, conversationId },
    expiresAt: Date.now() + PENDING_JUMP_TTL_MS,
  });
}

export function consumePendingConversationJump(
  conversationId: string | null | undefined
): ConversationScrollToQuoteDetail | null {
  if (!conversationId) return null;
  const entry = pendingConversationJumps.get(conversationId);
  if (!entry) return null;
  pendingConversationJumps.delete(conversationId);
  if (entry.expiresAt < Date.now()) return null;
  return entry.detail;
}

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

export function requestConversationScrollToQuote(
  detail: ConversationScrollToQuoteDetail
): void {
  if (
    !detail.turnId &&
    !detail.messageId &&
    detail.turnOrdinal === undefined &&
    !detail.snippet?.trim()
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ConversationScrollToQuoteDetail>(
      CONVERSATION_SCROLL_TO_QUOTE_EVENT,
      { detail }
    )
  );
}

export function findQuoteTargetElement(
  root: ParentNode,
  detail: ConversationScrollToQuoteDetail
): HTMLElement | null {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('[data-message-id], [data-turn-id]')
  );

  let matched: HTMLElement | null = null;
  if (detail.messageId) {
    matched =
      candidates.find(
        (el) =>
          el.dataset.messageId === detail.messageId &&
          (detail.blockIndex === undefined ||
            el.dataset.blockIndex === String(detail.blockIndex))
      ) ??
      candidates.find((el) => el.dataset.messageId === detail.messageId) ??
      null;
  }

  if (!matched && detail.turnId) {
    matched =
      candidates.find(
        (el) =>
          el.dataset.turnId === detail.turnId &&
          (detail.blockIndex === undefined ||
            el.dataset.blockIndex === String(detail.blockIndex))
      ) ??
      candidates.find((el) => el.dataset.turnId === detail.turnId) ??
      null;
  }

  if (!matched && detail.snippet?.trim()) {
    const needle = detail.snippet.trim();
    matched =
      candidates.find((el) => (el.textContent ?? '').includes(needle)) ?? null;
  }

  if (matched && detail.blockIndex !== undefined) {
    const blockChild = Array.from(
      matched.querySelectorAll<HTMLElement>('[data-block-index]')
    ).find((el) => el.dataset.blockIndex === String(detail.blockIndex));
    if (blockChild) {
      return blockChild;
    }
  }

  return matched;
}

export function pulseQuoteTargetElement(
  root: ParentNode,
  detail: ConversationScrollToQuoteDetail
): HTMLElement | null {
  const target = findQuoteTargetElement(root, detail);
  if (!target) return null;

  const existingTimer = activePulseTimers.get(target);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
    target.classList.remove(QUOTE_PULSE_CLASS);
  }

  target.classList.add(QUOTE_PULSE_CLASS);
  const timer = window.setTimeout(() => {
    target.classList.remove(QUOTE_PULSE_CLASS);
    activePulseTimers.delete(target);
  }, QUOTE_PULSE_DURATION_MS);
  activePulseTimers.set(target, timer);

  return target;
}
