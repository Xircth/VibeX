import type { DragEndEvent, Modifier } from '@dnd-kit/core';

export const CANVAS_DROP_IGNORE_SELECTOR =
  '.session-hub-sidebar, .session-canvas-floating-panel, .session-canvas-create-panel';

export const SESSION_LIST_DRAG_OVERLAY_CLASS = 'session-list-drag-overlay';

export const snapDragOverlayToCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (
    !draggingNodeRect ||
    !activatorEvent ||
    !('clientX' in activatorEvent) ||
    !('clientY' in activatorEvent) ||
    typeof activatorEvent.clientX !== 'number' ||
    typeof activatorEvent.clientY !== 'number'
  ) {
    return transform;
  }

  return {
    ...transform,
    x:
      transform.x +
      activatorEvent.clientX -
      draggingNodeRect.left -
      draggingNodeRect.width / 2,
    y:
      transform.y +
      activatorEvent.clientY -
      draggingNodeRect.top -
      draggingNodeRect.height / 2,
  };
};

export function dragEndClientPoint(
  event: Pick<DragEndEvent, 'active' | 'delta' | 'activatorEvent'>
): { x: number; y: number } | null {
  const translated = event.active.rect.current.translated;
  if (translated) {
    return {
      x: translated.left + translated.width / 2,
      y: translated.top + translated.height / 2,
    };
  }

  const activator = event.activatorEvent;
  if (
    activator &&
    typeof activator === 'object' &&
    'clientX' in activator &&
    'clientY' in activator &&
    typeof activator.clientX === 'number' &&
    typeof activator.clientY === 'number'
  ) {
    return {
      x: activator.clientX + event.delta.x,
      y: activator.clientY + event.delta.y,
    };
  }

  return null;
}

export function hitElementFromPoint(x: number, y: number): Element | null {
  if (typeof document === 'undefined' || !document.elementsFromPoint) {
    return document.elementFromPoint(x, y);
  }
  const hits = document.elementsFromPoint(x, y);
  return (
    hits.find(
      (element) => !element.closest(`.${SESSION_LIST_DRAG_OVERLAY_CLASS}`)
    ) ?? null
  );
}

export function isPointOverCanvasDrop(hit: EventTarget | null): boolean {
  if (!(hit instanceof Element)) return false;
  if (hit.closest(CANVAS_DROP_IGNORE_SELECTOR)) return false;
  return Boolean(hit.closest('.canvas-surface'));
}
