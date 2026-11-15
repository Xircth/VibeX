export const OPEN_PULSE_DECK_EVENT = 'vibex:open-pulse-deck' as const;

export interface OpenPulseDeckEventDetail {
  projectId?: string | null;
}

/**
 * Dispatches `vibex:open-pulse-deck`. Returns `true` if an active Kanban or
 * workspace stage consumed the event (`event.preventDefault()`), or `false`
 * when the caller should fall back to an inline Pulse Deck popover/drawer.
 */
export function requestOpenPulseDeck(
  detail: OpenPulseDeckEventDetail = {}
): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const event = new CustomEvent<OpenPulseDeckEventDetail>(
    OPEN_PULSE_DECK_EVENT,
    {
      bubbles: true,
      cancelable: true,
      detail,
    }
  );
  return !window.dispatchEvent(event);
}
