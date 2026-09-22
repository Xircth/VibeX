export const NATIVE_TITLE_ATTR = 'title';
export const STORED_TITLE_ATTR = 'data-app-title';
export const OWNED_TOOLTIP_ATTR = 'data-app-owned-tooltip';
export const NATIVE_TITLE_TOOLTIP_CLASS = 'app-hover-tooltip';
export const NATIVE_TITLE_SHOW_DELAY_MS = 280;
export const NATIVE_TITLE_GAP_PX = 6;
export const NATIVE_TITLE_MARGIN_PX = 8;

const TITLED_SELECTOR = `[${NATIVE_TITLE_ATTR}], [${STORED_TITLE_ATTR}]`;

export function readElementTitle(element: Element): string {
  return (
    element.getAttribute(NATIVE_TITLE_ATTR) ??
    element.getAttribute(STORED_TITLE_ATTR) ??
    ''
  ).trim();
}

export function findTitledElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (
    target.closest(`.${NATIVE_TITLE_TOOLTIP_CLASS}`) ||
    target.closest('.astryx-tooltip')
  ) {
    return null;
  }

  const element = target.closest(TITLED_SELECTOR);
  if (
    !element ||
    element === document.documentElement ||
    element === document.body
  ) {
    return null;
  }
  if (!readElementTitle(element)) return null;
  return element;
}

export function isOwnedAppTooltip(element: Element): boolean {
  return Boolean(element.closest(`[${OWNED_TOOLTIP_ATTR}]`));
}

export function suppressNativeTitle(element: Element): string {
  const live = element.getAttribute(NATIVE_TITLE_ATTR);
  if (live != null && live.trim()) {
    element.setAttribute(STORED_TITLE_ATTR, live);
    element.removeAttribute(NATIVE_TITLE_ATTR);
    return live.trim();
  }
  return readElementTitle(element);
}

export function restoreNativeTitle(element: Element): void {
  const stored = element.getAttribute(STORED_TITLE_ATTR);
  if (stored != null && !element.hasAttribute(NATIVE_TITLE_ATTR)) {
    element.setAttribute(NATIVE_TITLE_ATTR, stored);
  }
  element.removeAttribute(STORED_TITLE_ATTR);
}

export function positionHoverTooltip(
  anchor: { top: number; left: number; width: number; height: number },
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = NATIVE_TITLE_GAP_PX,
  margin = NATIVE_TITLE_MARGIN_PX
): { top: number; left: number } {
  let top = anchor.top + anchor.height + gap;
  let left = anchor.left + (anchor.width - tooltip.width) / 2;

  if (top + tooltip.height + margin > viewport.height) {
    top = anchor.top - tooltip.height - gap;
  }
  if (top < margin) {
    top = margin;
  }

  const maxLeft = Math.max(margin, viewport.width - tooltip.width - margin);
  left = Math.min(Math.max(left, margin), maxLeft);
  return { top, left };
}
