const CAROUSEL_PAGE_KEYS = new Set(['PageDown', 'PageUp', 'Home', 'End']);

export function shouldPinKanbanCarouselKey(key: string): boolean {
  return CAROUSEL_PAGE_KEYS.has(key);
}

export function shouldSuppressKanbanCarouselPageKey(
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest('[data-panel="conversation-logs"]')) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) {
    return false;
  }
  return true;
}

export function pinKanbanCarouselScroll(
  element: { scrollLeft: number; scrollTop: number } | null
): void {
  if (!element) return;
  if (element.scrollLeft !== 0) {
    element.scrollLeft = 0;
  }
  if (element.scrollTop !== 0) {
    element.scrollTop = 0;
  }
}
