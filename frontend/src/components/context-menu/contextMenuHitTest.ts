export const CONTEXT_MENU_ZONE_ATTR = 'data-context-menu-zone';
export const CONTEXT_MENU_EDITABLE_ATTR = 'data-context-menu-editable';

const EDITABLE_TAGS = new Set(['input', 'textarea', 'select']);

function asElement(target: EventTarget | null): HTMLElement | null {
  if (!target || !(target instanceof Element)) return null;
  return target instanceof HTMLElement
    ? target
    : target.parentElement instanceof HTMLElement
      ? target.parentElement
      : null;
}

export function closestContextMenuZone(
  target: EventTarget | null
): string | null {
  const element = asElement(target);
  if (!element) return null;
  const zoned = element.closest(`[${CONTEXT_MENU_ZONE_ATTR}]`);
  return zoned?.getAttribute(CONTEXT_MENU_ZONE_ATTR) ?? null;
}

export function isForbiddenContextMenuTarget(target: EventTarget | null) {
  const zone = closestContextMenuZone(target);
  return zone === 'forbidden' || zone === 'native';
}

export function ignoresEditableContextMenu(target: EventTarget | null) {
  const element = asElement(target);
  if (!element) return false;
  return Boolean(element.closest(`[${CONTEXT_MENU_EDITABLE_ATTR}="ignore"]`));
}

export function isEditableContextMenuTarget(target: EventTarget | null) {
  if (isForbiddenContextMenuTarget(target)) return false;
  if (ignoresEditableContextMenu(target)) return false;
  const element = asElement(target);
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (EDITABLE_TAGS.has(tag)) {
    return true;
  }
  return element.isContentEditable;
}

export function isReadOnlyEditable(target: EventTarget | null) {
  const element = asElement(target);
  if (!element) return true;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.readOnly || element.disabled;
  }
  if (element instanceof HTMLSelectElement) {
    return element.disabled;
  }
  return false;
}

export function getContextMenuSelectedText(target: EventTarget | null): string {
  const element = asElement(target);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    return end > start ? element.value.slice(start, end) : '';
  }
  const selection = window.getSelection();
  return selection ? selection.toString() : '';
}

export function clampContextMenuPosition({
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = 8,
}: {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin)),
  };
}
